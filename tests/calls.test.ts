import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadAgents } from "../src/agents/loader.js";
import { buildCapabilities } from "../src/brain/capabilities.js";
import { Orchestrator } from "../src/brain/orchestrator.js";
import { Router } from "../src/brain/router.js";
import { CallDesk, agrees, parseDecision } from "../src/calls/desk.js";
import { GroqVoice } from "../src/calls/groq.js";
import { Cluster } from "../src/cluster/cluster.js";
import { parseConfig } from "../src/config.js";
import { AssistantTasks } from "../src/integrations/assistant.js";
import { ProviderPool } from "../src/providers/registry.js";
import { createApp } from "../src/server/app.js";
import { Fcm } from "../src/server/fcm.js";
import { Notifier, alertPayload } from "../src/server/push.js";
import { Store } from "../src/store/db.js";
import type { AlertAction, BrainAlert } from "../src/types.js";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));

function hub() {
  const dataDir = mkdtempSync(join(tmpdir(), "orc-call-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const config = parseConfig({ node: { name: "hub" }, dataDir, server: { token: "secret-token" }, cluster: { enabled: false }, context: { graphify: "off" } });
  const store = new Store(dataDir);
  cleanup.unshift(() => store.close());
  const pool = new ProviderPool(config, store, {});
  for (const id of [...pool.providers.keys()]) pool.providers.delete(id);
  const cluster = new Cluster(config, pool);
  const router = new Router(buildCapabilities(), { localBias: 0.5, learn: false }, store);
  const orchestrator = new Orchestrator(config, store, cluster, router, loadAgents(["agents"]), {});
  return { config, store, pool, cluster, router, orchestrator, dataDir };
}

/** A brain that knows a few open alerts and records acks. */
function fakeBrain(alerts: BrainAlert[]) {
  const acks: { id: number; action: AlertAction }[] = [];
  const http = (async (input: string | URL, init?: RequestInit) => {
    const { pathname } = new URL(String(input));
    const m = pathname.match(/^\/alerts\/(\d+)\/ack$/);
    if (m) acks.push({ id: Number(m[1]), action: JSON.parse(String(init?.body)).action });
    if (pathname === "/alerts") return Response.json(alerts);
    return Response.json(m ? {} : []);
  }) as typeof fetch;
  return { http, acks };
}

/** Groq's two endpoints: Whisper answers `heard`, chat answers the next queued decision. */
function fakeGroq(heard: string, decisions: object[]) {
  const calls: { path: string; auth: string; body: BodyInit | null | undefined }[] = [];
  const http = (async (input: string | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname.replace("/openai/v1", "");
    calls.push({ path, auth: String((init?.headers as Record<string, string>).Authorization), body: init?.body });
    if (path === "/audio/transcriptions") return Response.json({ text: heard });
    const next = decisions.shift() ?? { say: "Okay.", action: "none" };
    return Response.json({ choices: [{ message: { content: JSON.stringify(next) } }] });
  }) as typeof fetch;
  const voice = new GroqVoice({ baseUrl: "https://api.groq.com/openai/v1", keys: ["gsk_test_key"], model: "openai/gpt-oss-120b", transcribeModel: "whisper-large-v3-turbo" }, http);
  return { voice, calls };
}

const CALL: BrainAlert = { id: 9, level: 4, kind: "question", title: "Jayesh is still waiting", body: "He asked for the report 40 minutes ago and the alarm went unanswered.", task_id: 4 };
const auth = { Authorization: "Bearer secret-token", "Content-Type": "application/json" };

async function callHub(decisions: object[], opts: { heard?: string; noKey?: boolean; think?: (s: string, p: string) => Promise<string> } = {}) {
  const s = hub();
  const brain = fakeBrain([CALL]);
  const assistant = new AssistantTasks(s.store, { url: "http://brain", token: "t", pollMinutes: 5 }, brain.http);
  await assistant.sync();
  const groq = fakeGroq(opts.heard ?? "", decisions);
  const started: string[] = [];
  const calls = new CallDesk({
    voice: opts.noKey ? new GroqVoice({ baseUrl: "x", keys: [], model: "m", transcribeModel: "w" }) : groq.voice,
    think: opts.think,
    ack: (id, action) => assistant.ack(id, action),
    start: (task) => (started.push(task), `run${started.length}`),
    setup: async () => "SETUP BRIEFING: owner is Roger.",
  });
  const app = createApp({ ...s, assistant, calls, publicDir: "web/dist" });
  const turn = async (text: string) => {
    const r = await app.request(`/api/calls/${CALL.id}/turn`, { method: "POST", headers: auth, body: JSON.stringify({ text }) });
    return { status: r.status, body: await r.json() };
  };
  return { app, brain, groq, started, turn };
}

describe("alarms and calls on the phone", () => {
  it("sends levels 3 and 4 on the alarm channel to the call screen, and leaves 1-2 as they were", async () => {
    expect(alertPayload({ id: 1, level: 2, kind: "question", title: "Q", body: "b" })).toEqual({ title: "Q", body: "b", url: "/", tag: "alert:1" });
    expect(alertPayload({ id: 2, level: 3, kind: "overdue", title: "Pay rent", body: "b" })).toEqual({ title: "Pay rent", body: "b", url: "/#/call/2", tag: "alert:2", channel: "alarm" });
    expect(alertPayload(CALL)).toMatchObject({ title: "Call: Jayesh is still waiting", url: "/#/call/9", channel: "alarm" });

    // FCM: the channel id goes into the Android notification; alarms also at max priority.
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyFile = join(mkdtempSync(join(tmpdir(), "orc-fcm-")), "sa.json");
    writeFileSync(keyFile, JSON.stringify({ project_id: "p", client_email: "bot@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }));
    const sent: any[] = [];
    const http = (async (url: string, init: RequestInit) => {
      if (url.includes("oauth2")) return Response.json({ access_token: "ya29.test", expires_in: 3600 });
      sent.push(JSON.parse(String(init.body)).message);
      return Response.json({});
    }) as typeof fetch;
    const s = hub();
    const n = new Notifier(s.store, s.dataDir, async () => {}, new Fcm(keyFile, http));
    n.subscribeFcm("device-token-xxxxxxxxxxxxxxxx");
    await n.notify(alertPayload({ id: 1, level: 2, kind: "question", title: "Q", body: "b" }));
    await n.notify(alertPayload(CALL));
    expect(sent[0].android.notification).toEqual({ channel_id: "orchestrator", tag: "alert:1" });
    expect(sent[1].android.notification).toEqual({ channel_id: "alarm", tag: "alert:9", notification_priority: "PRIORITY_MAX", visibility: "PUBLIC" });
    expect(sent[1].data.url).toBe("/#/call/9");

    // /api/notify picks the payload by level.
    const pushed: { channel?: string; url: string }[] = [];
    const app = createApp({ ...s, notifier: { notify: async (p: { channel?: string; url: string }) => (pushed.push(p), 1) } as never, publicDir: "web/dist" });
    await app.request("/api/notify", { method: "POST", headers: auth, body: JSON.stringify({ id: 5, level: 3, kind: "overdue", title: "Rent", body: "due" }) });
    await app.request("/api/notify", { method: "POST", headers: auth, body: JSON.stringify({ id: 6, level: 2, kind: "overdue", title: "Rent", body: "due" }) });
    expect(pushed.map((p) => [p.channel, p.url])).toEqual([
      ["alarm", "/#/call/5"],
      [undefined, "/"],
    ]);
  });

  it("opens the call with the situation, hears a voice clip and forwards done to the brain", async () => {
    const h = await callHub(
      [
        { say: "Jayesh is waiting on the report. I'd send it now. What do you want to do?", action: "none" },
        { say: "Great, I'll mark it done.", action: "done" },
      ],
      { heard: "I already sent it, mark it done" },
    );
    const info = await (await h.app.request(`/api/calls/${CALL.id}`, { headers: auth })).json();
    expect(info).toMatchObject({ alert: { id: 9, level: 4 }, voice: true, available: true, ended: false });
    const open = await (await h.app.request(`/api/calls/${CALL.id}/answer`, { method: "POST", headers: auth })).json();
    expect(open.say).toMatch(/Jayesh is waiting/);

    // The phone sends its recording as multipart.
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array([0, 1, 2, 3])], { type: "audio/mp4" }), "turn.m4a");
    const r = await h.app.request(`/api/calls/${CALL.id}/turn`, { method: "POST", headers: { Authorization: auth.Authorization }, body: form });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ transcript: "I already sent it, mark it done", say: "Great, I'll mark it done.", action: "done", done: true });
    expect(h.brain.acks).toEqual([{ id: 9, action: "done" }]);
    // Whisper got the clip with the right model; the chat call was JSON mode with the briefing and the alert.
    const whisper = h.groq.calls.find((c) => c.path === "/audio/transcriptions")!;
    expect(whisper.auth).toBe("Bearer gsk_test_key");
    expect((whisper.body as FormData).get("model")).toBe("whisper-large-v3-turbo");
    const chat = JSON.parse(String(h.groq.calls.filter((c) => c.path === "/chat/completions").at(-1)!.body));
    expect(chat.response_format).toEqual({ type: "json_object" });
    expect(chat.messages[0].content).toContain("SETUP BRIEFING");
    expect(chat.messages[1].content).toContain("Jayesh is still waiting");
    expect(chat.messages[1].content).toContain("I already sent it");
    // The alert is answered: the call is over.
    expect((await h.turn("hello?")).status).toBe(404);
  });

  it("refuses any action outside the safe list", async () => {
    const h = await callHub([{ say: "Sending it now.", action: "send_message", args: { to: "Jayesh" } }]);
    const r = await h.turn("just send him the report");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ action: "none", refused: "send_message", done: false });
    expect(r.body.say).toMatch(/can't do that/);
    expect(h.brain.acks).toEqual([]);
    expect(h.started).toEqual([]);
  });

  it("only drafts or delegates after proposing it and hearing yes, and never as a write run", async () => {
    const h = await callHub([
      { say: "I can draft a reply saying it comes tonight.", action: "draft_reply", args: { to: "Jayesh", instructions: "the report comes tonight" } },
      { say: "Drafting it now.", action: "draft_reply", args: {} },
      { say: "Want me to research it?", action: "delegate", args: { task: "find last quarter's numbers" } },
      { say: "Okay, not then.", action: "delegate", args: {} },
    ]);
    // First time: a proposal, nothing started.
    let r = await h.turn("tell him it comes tonight");
    expect(r.body).toMatchObject({ action: "none", proposed: "draft_reply" });
    expect(r.body.say).toMatch(/\?$/);
    expect(h.started).toEqual([]);
    // The owner agrees: the run starts, with the proposed args and a no-send instruction.
    r = await h.turn("yes do it");
    expect(r.body).toMatchObject({ action: "draft_reply", runId: "run1", done: false });
    expect(h.started[0]).toContain("Do NOT send anything");
    expect(h.started[0]).toContain("the report comes tonight");
    expect(h.started[0]).toContain("To: Jayesh");
    // A delegate proposal answered with "no" does nothing.
    await h.turn("can you look up the numbers");
    r = await h.turn("no, not now");
    expect(r.body.action).toBe("none");
    expect(h.started).toHaveLength(1);
  });

  it("without a Groq key, refuses voice with 409 and takes typed turns through another model", async () => {
    const h = await callHub([], { noKey: true, think: async () => '```json\n{"say":"Snoozed for an hour.","action":"snooze"}\n```' });
    const info = await (await h.app.request(`/api/calls/${CALL.id}`, { headers: auth })).json();
    expect(info).toMatchObject({ voice: false, available: true });
    const r = await h.app.request(`/api/calls/${CALL.id}/turn`, { method: "POST", headers: auth, body: JSON.stringify({ audio: Buffer.from("clip").toString("base64"), mime: "audio/mp4" }) });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ fallback: "text", error: expect.stringMatching(/Groq key/) });
    const t = await h.turn("remind me later");
    expect(t.body).toMatchObject({ action: "snooze", done: true });
    expect(h.brain.acks).toEqual([{ id: 9, action: "snooze" }]);

    // And with no model at all, typed turns are refused the same way.
    const none = await callHub([], { noKey: true });
    expect((await none.turn("hello")).status).toBe(409);
  });

  it("reads agreement and the model's JSON loosely but safely", () => {
    expect(agrees("yes please")).toBe(true);
    expect(agrees("okay go ahead")).toBe(true);
    expect(agrees("no, don't")).toBe(false);
    expect(agrees("yes but wait")).toBe(false);
    expect(agrees("I know")).toBe(false);
    expect(parseDecision('Sure: {"say":"hi","action":"none"}')).toEqual({ say: "hi", action: "none" });
    expect(parseDecision("not json")).toBeUndefined();
  });
});
