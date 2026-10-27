import { createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadAgents } from "../src/agents/loader.js";
import { buildCapabilities } from "../src/brain/capabilities.js";
import { Orchestrator, parseQuestion } from "../src/brain/orchestrator.js";
import { Router } from "../src/brain/router.js";
import { Cluster } from "../src/cluster/cluster.js";
import { parseConfig } from "../src/config.js";
import type { Provider } from "../src/providers/base.js";
import { ProviderPool } from "../src/providers/registry.js";
import { createApp } from "../src/server/app.js";
import { Fcm } from "../src/server/fcm.js";
import { Notifier, payloadFor } from "../src/server/push.js";
import { Store } from "../src/store/db.js";
import type { ProviderId, ProviderRequest, ProviderResult, RunEvent, RunEventType } from "../src/types.js";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));

type Handler = (req: ProviderRequest) => Partial<ProviderResult> | Promise<Partial<ProviderResult>>;

function system(handlers: Partial<Record<ProviderId, Handler>>) {
  const dataDir = mkdtempSync(join(tmpdir(), "orc-ctl-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const config = parseConfig({ node: { name: "hub" }, dataDir, server: { token: "secret-token" }, cluster: { enabled: false }, context: { graphify: "off" } });
  const prompts: string[] = [];
  const fakes = Object.fromEntries(
    Object.entries(handlers).map(([id, h]) => [
      id,
      {
        id,
        detect: async () => ({ id, installed: true, authenticated: true }),
        run: async (req: ProviderRequest) => {
          prompts.push(req.prompt);
          // Respect stops like a real CLI would.
          if (req.signal?.aborted) return { ok: false, text: "", provider: id, durationMs: 1, error: "cancelled" };
          return { ok: true, text: "", provider: id, durationMs: 5, ...(await h!(req)) };
        },
      } as Provider,
    ]),
  );
  const store = new Store(dataDir);
  cleanup.unshift(() => store.close());
  const pool = new ProviderPool(config, store, fakes);
  for (const id of [...pool.providers.keys()]) if (!handlers[id]) pool.providers.delete(id);
  const cluster = new Cluster(config, pool);
  const router = new Router(buildCapabilities(), { localBias: 0.5, learn: false }, store);
  const attention: RunEventType[] = [];
  const orchestrator = new Orchestrator(config, store, cluster, router, loadAgents(["agents"]), { onAttention: (_r, _s, t) => void attention.push(t) });
  return { config, store, pool, cluster, router, orchestrator, prompts, attention, dataDir };
}

/** Calls `act` on each event of the given type for a run (the run waits until you act). */
function on(s: ReturnType<typeof system>, runId: string, type: RunEventType, act: (ev: RunEvent) => void) {
  s.orchestrator.subscribe(runId, (ev) => ev.type === type && act(ev));
}

describe("agents asking you", () => {
  it("parses a question only when the answer ends with <ask>", () => {
    expect(parseQuestion("<ask>Which MCU?</ask>")).toBe("Which MCU?");
    expect(parseQuestion("I looked around.\n<ask>USB-C or micro-USB?</ask>\n")).toBe("USB-C or micro-USB?");
    expect(parseQuestion("Done. I used <ask> tags in the template.")).toBeUndefined();
  });

  it("pauses the step, notifies you, and continues with your answer", async () => {
    let calls = 0;
    const s = system({ claude: (req) => ({ text: ++calls === 1 ? "<ask>ESP32 or RP2040?</ask>" : `built with ${req.prompt.includes("The user answered: RP2040") ? "RP2040" : "?"}` }) });
    const run = s.orchestrator.submit("design the board", { mode: "direct", ask: true });
    on(s, run.id, "step.question", (ev) => {
      const r = s.orchestrator.get(run.id)!;
      expect(r.status).toBe("waiting");
      expect(r.steps[0].status).toBe("waiting");
      expect((ev.data as { question: string }).question).toBe("ESP32 or RP2040?");
      expect(s.orchestrator.answer(run.id, "s1", "RP2040")).toBe(true);
    });
    const done = await s.orchestrator.wait(run.id)!;
    expect(done.status).toBe("done");
    expect(done.result).toBe("built with RP2040");
    expect(done.steps[0].answers).toEqual([{ question: "ESP32 or RP2040?", answer: "RP2040" }]);
    expect(s.prompts[0]).toContain("<ask>your question</ask>");
    expect(s.attention).toEqual(["step.question", "run.completed"]);
  });

  it("does not tell agents they may ask unless you turned it on", async () => {
    const s = system({ claude: () => ({ text: "<ask>should be ignored</ask>" }) });
    const done = await s.orchestrator.runToCompletion("x", { mode: "direct" });
    expect(s.prompts[0]).not.toContain("<ask>");
    expect(done.status).toBe("done");
  });
});

describe("checkpoints", () => {
  const PLAN = {
    goal: "g",
    synthesize: false,
    steps: [
      { id: "a", title: "Research", agent: "researcher", prompt: "STEP A", dependsOn: [] },
      { id: "b", title: "Write", agent: "writer", prompt: "STEP B", dependsOn: ["a"] },
    ],
  };

  it("redo and edit before later steps see the answer", async () => {
    let aRuns = 0;
    const s = system({
      claude: (req) => {
        if (req.prompt.includes("planning brain")) return { text: JSON.stringify(PLAN) };
        if (req.prompt.includes("STEP A")) return { text: req.prompt.includes("redo it: cite sources") ? `A v${++aRuns} with sources` : `A v${++aRuns}` };
        return { text: `B saw: ${req.prompt.includes("MY EDIT") ? "MY EDIT" : "original"}` };
      },
    });
    const run = s.orchestrator.submit("research and write", { mode: "plan", checkpoints: true });
    const seen: string[] = [];
    on(s, run.id, "step.review", (ev) => {
      const out = (ev.data as { output: string }).output;
      seen.push(`${ev.stepId}:${out}`);
      if (ev.stepId === "a" && out === "A v1") s.orchestrator.review(run.id, "a", { action: "redo", instructions: "cite sources" });
      else if (ev.stepId === "a") s.orchestrator.review(run.id, "a", { action: "edit", output: "MY EDIT" });
      else s.orchestrator.review(run.id, "b", { action: "continue" });
    });
    const done = await s.orchestrator.wait(run.id)!;
    expect(done.status).toBe("done");
    expect(seen).toEqual(["a:A v1", "a:A v2 with sources", "b:B saw: MY EDIT"]);
    expect(done.steps[0].edited).toBe(true);
    expect(done.result).toBe("B saw: MY EDIT");
    // Your edit is remembered as a correction for similar tasks later.
    expect(s.store.searchMemory("research", 5).some((m) => m.runId.endsWith(":correction") && m.summary.includes("MY EDIT"))).toBe(true);
  });

  it("stopping a paused step skips the steps that need it", async () => {
    const s = system({
      claude: (req) => ({ text: req.prompt.includes("planning brain") ? JSON.stringify(PLAN) : "out" }),
    });
    const run = s.orchestrator.submit("research and write", { mode: "plan", checkpoints: true });
    on(s, run.id, "step.review", (ev) => expect(s.orchestrator.stopStep(run.id, ev.stepId!)).toBe(true));
    const done = await s.orchestrator.wait(run.id)!;
    expect(done.status).toBe("failed");
    expect(done.steps.map((x) => [x.status, x.error])).toEqual([
      ["failed", "stopped by you"],
      ["skipped", "a step it depends on failed"],
    ]);
  });
});

describe("editing finished answers", () => {
  it("updates the result and refuses once later steps have started", async () => {
    const s = system({ claude: () => ({ text: "first draft" }) });
    const done = await s.orchestrator.runToCompletion("write it", { mode: "direct" });
    expect(s.orchestrator.editStep(done.id, "s1", "better draft")).toEqual({ ok: true });
    const r = s.store.getRun(done.id)!;
    expect(r.result).toBe("better draft");
    expect(r.steps[0].edited).toBe(true);
    expect(s.orchestrator.editStep(done.id, "nope", "x").ok).toBe(false);
  });
});

describe("conversations", () => {
  it("a follow-up message sees the earlier turns", async () => {
    const s = system({ claude: (req) => ({ text: req.prompt.includes("CONVERSATION SO FAR") ? "follow-up with context" : "a 40mm enclosure" }) });
    const app = createApp({ ...s, publicDir: "web/dist" });
    const auth = { Authorization: "Bearer secret-token", "Content-Type": "application/json" };
    const t = await (await app.request("/api/threads", { method: "POST", headers: auth, body: "{}" })).json();
    const r1 = await (await app.request(`/api/threads/${t.id}/messages`, { method: "POST", headers: auth, body: JSON.stringify({ text: "Design an enclosure", mode: "direct" }) })).json();
    await s.orchestrator.wait(r1.id);
    const r2 = await (await app.request(`/api/threads/${t.id}/messages`, { method: "POST", headers: auth, body: JSON.stringify({ text: "Make it 2mm thicker", mode: "direct" }) })).json();
    const done = await s.orchestrator.wait(r2.id)!;
    expect(done.result).toBe("follow-up with context");
    expect(done.steps[0].title).toMatch(/Make it 2mm thicker$/); // your words, not the history
    expect(s.prompts[1]).toContain("User: Design an enclosure");
    expect(s.prompts[1]).toContain("a 40mm enclosure");
    expect(s.prompts[1]).toContain("NEW MESSAGE FROM THE USER:\nMake it 2mm thicker");
    const view = await (await app.request(`/api/threads/${t.id}`, { headers: auth })).json();
    expect(view.thread.title).toBe("Design an enclosure");
    expect(view.runs.map((r: { task: string }) => r.task)).toEqual(["Design an enclosure", "Make it 2mm thicker"]);
  });

  it("answers and checkpoint decisions over HTTP; wrong state is a 409", async () => {
    const s = system({ claude: () => ({ text: "<ask>Which colour?</ask>" }) });
    const app = createApp({ ...s, publicDir: "web/dist" });
    const auth = { Authorization: "Bearer secret-token", "Content-Type": "application/json" };
    const run = s.orchestrator.submit("paint it", { mode: "direct", ask: true });
    await new Promise<void>((res) => on(s, run.id, "step.question", () => res()));
    expect((await app.request(`/api/runs/${run.id}/steps/s1/review`, { method: "POST", headers: auth, body: JSON.stringify({ action: "continue" }) })).status).toBe(409);
    expect((await app.request(`/api/runs/${run.id}/steps/s1/stop`, { method: "POST", headers: auth })).status).toBe(200);
    expect((await s.orchestrator.wait(run.id)!).steps[0].error).toBe("stopped by you");
  });
});

describe("access through tailscale serve", () => {
  it("requests forwarded by a local proxy need the token even though they arrive from loopback", async () => {
    const s = system({ claude: () => ({ text: "x" }) });
    const app = createApp({ ...s, publicDir: "web/dist" });
    const loopback = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
    expect((await app.request("/api/threads", {}, loopback)).status).toBe(200);
    const proxied = { "X-Forwarded-For": "100.64.0.7", "Tailscale-User-Login": "you@example.com" };
    expect((await app.request("/api/threads", { headers: proxied }, loopback)).status).toBe(401);
    expect((await app.request("/api/threads", { headers: { ...proxied, Authorization: "Bearer secret-token" } }, loopback)).status).toBe(200);
  });
});

describe("phone notifications", () => {
  it("sends what needs you and drops subscriptions the phone removed", async () => {
    const s = system({ claude: () => ({ text: "x" }) });
    const sent: string[] = [];
    const n = new Notifier(s.store, s.dataDir, async (sub, payload) => {
      if (sub.endpoint.includes("gone")) throw Object.assign(new Error("gone"), { statusCode: 410 });
      sent.push(payload);
    });
    const keys = { p256dh: "k", auth: "a" };
    n.subscribe({ endpoint: "https://push.example/ok", keys });
    n.subscribe({ endpoint: "https://push.example/gone", keys });
    expect(await n.notify({ title: "t", body: "b", url: "/", tag: "x" })).toBe(1);
    expect(s.store.pushSubs().map((x) => x.endpoint)).toEqual(["https://push.example/ok"]);
    expect(JSON.parse(sent[0]).title).toBe("t");
    // Keys survive restarts.
    expect(new Notifier(s.store, s.dataDir).publicKey).toBe(n.publicKey);
  });

  it("sends to the Android app through FCM with a signed service-account token", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyFile = join(mkdtempSync(join(tmpdir(), "orc-fcm-")), "sa.json");
    writeFileSync(keyFile, JSON.stringify({ project_id: "my-proj", client_email: "bot@my-proj.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }));
    const calls: { url: string; body: string; auth?: string }[] = [];
    const http = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body), auth: (init.headers as Record<string, string>).Authorization });
      if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "ya29.test", expires_in: 3600 }));
      if (String(init.body).includes("dead-token")) return new Response(JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }), { status: 404 });
      return new Response("{}");
    }) as typeof fetch;
    const fcm = new Fcm(keyFile, http);
    await fcm.send("device-token-123", { title: "Done", body: "Name a planet", url: "/#/t/t1?run=r1", tag: "r1" });
    // The OAuth assertion is a JWT signed with the key.
    const assertion = new URLSearchParams(calls[0].body).get("assertion")!;
    const [h, c, sig] = assertion.split(".");
    expect(JSON.parse(Buffer.from(c, "base64url").toString()).scope).toBe("https://www.googleapis.com/auth/firebase.messaging");
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
    // A notification message on the app's channel, high priority, with the tap target in data.
    expect(calls[1].url).toBe("https://fcm.googleapis.com/v1/projects/my-proj/messages:send");
    expect(calls[1].auth).toBe("Bearer ya29.test");
    const msg = JSON.parse(calls[1].body).message;
    expect(msg).toMatchObject({
      token: "device-token-123",
      notification: { title: "Done", body: "Name a planet" },
      android: { priority: "high", notification: { channel_id: "orchestrator" } },
      data: { url: "/#/t/t1?run=r1" },
    });
    // A token the phone no longer has is dropped.
    const s = system({ claude: () => ({ text: "x" }) });
    const n = new Notifier(s.store, s.dataDir, async () => {}, fcm);
    n.subscribeFcm("dead-token-xxxxxxxxxxxxxxxx");
    n.subscribeFcm("live-token-xxxxxxxxxxxxxxxx");
    expect(await n.notify({ title: "t", body: "b", url: "/", tag: "x" })).toBe(1);
    expect(s.store.pushSubs().map((x) => x.endpoint)).toEqual(["fcm:live-token-xxxxxxxxxxxxxxxx"]);
    expect(calls.filter((x) => x.url.includes("oauth2"))).toHaveLength(1); // the access token is reused
  });

  it("words the notification for each kind of event", () => {
    const run = { id: "r1", threadId: "t1", task: "Design the board", options: {}, status: "waiting", steps: [], createdAt: 0 } as never;
    const step = { id: "s1", title: "Pick MCU", agent: "pcb-designer", question: "ESP32 or RP2040?", kind: "pcb_design", status: "waiting", attempts: [] } as never;
    expect(payloadFor(run, step, "step.question")).toMatchObject({ title: "pcb-designer has a question", body: "ESP32 or RP2040?", url: "/#/t/t1?run=r1" });
    expect(payloadFor(run, undefined, "run.completed")?.title).toBe("Done");
    expect(payloadFor(run, undefined, "step.delta")).toBeUndefined();
  });
});
