import { createVerify, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
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
import { AssistantTasks, type BrainTask } from "../src/integrations/assistant.js";
import { GmailReader, parseTasks } from "../src/integrations/gmail.js";
import { OpenAICompatProvider } from "../src/providers/openai-compat.js";
import { createApp } from "../src/server/app.js";
import { localDay } from "../src/server/home.js";
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

describe("home screen", () => {
  it("shows today's tasks, open questions, failures and this week's numbers", async () => {
    const s = system({ claude: (req) => (req.prompt.includes("paint") ? { text: "<ask>Which colour?</ask>" } : { ok: false, error: "boom" }) });
    const app = createApp({ ...s, publicDir: "web/dist" });
    const auth = { Authorization: "Bearer secret-token", "Content-Type": "application/json" };
    const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: auth, body: JSON.stringify(body) });

    expect((await post("/api/tasks", { title: "Pay electricity bill", time: "by 5 pm", source: "gmail", detail: "due today" })).status).toBe(201);
    const late = await (await post("/api/tasks", { title: "Call Arun", time: "10:00", source: "whatsapp", id: "wa:123" })).json();
    await post("/api/tasks", { title: "Call Arun", time: "10:00", source: "whatsapp", id: "wa:123" }); // same message again: no duplicate
    expect((await post("/api/tasks", { title: "x", source: "fax" })).status).toBe(400);

    const failed = s.orchestrator.submit("broken thing", { mode: "direct" });
    await s.orchestrator.wait(failed.id);
    const asking = s.orchestrator.submit("paint it", { mode: "direct", ask: true });
    await new Promise<void>((res) => on(s, asking.id, "step.question", () => res()));

    const home = await (await app.request("/api/home", { headers: auth })).json();
    expect(home.tasks.map((t: { title: string }) => t.title)).toEqual(["Call Arun", "Pay electricity bill"]);
    expect(home.decisions).toMatchObject([{ kind: "question", runId: asking.id, stepId: "s1", text: "Which colour?" }]);
    expect(home.attention[0]).toMatchObject({ level: "error", runId: failed.id, task: "broken thing" });
    expect(home.recent[0].runId).toBe(failed.id);

    expect((await post(`/api/tasks/${late.id}/done`, {})).status).toBe(200);
    expect((await (await app.request("/api/tasks", { headers: auth })).json()).find((t: { id: string }) => t.id === "wa:123").done).toBe(true);

    const week = await (await app.request("/api/insights", { headers: auth })).json();
    expect(week.days).toHaveLength(7);
    expect(week.days[6]).toMatchObject({ runs: 2, failed: 1 });
    expect(week).toMatchObject({ runs: 2, done: 0, failed: 1 });
    s.orchestrator.cancel(asking.id);
  });
});

describe("gmail reader", () => {
  const today = localDay();
  const b64 = (s: string) => Buffer.from(s).toString("base64url");
  /** A fake Google: token endpoint, a two-message inbox, and the messages themselves. */
  function fakeGoogle() {
    const calls: string[] = [];
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const http = (async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "at", expires_in: 3600 });
      if (url.includes("/messages?")) return json({ messages: [{ id: "m1" }, { id: "m2" }] });
      if (url.includes("/messages/m1")) {
        return json({ id: "m1", payload: { headers: [{ name: "From", value: "Clinic <c@x>" }, { name: "Subject", value: "Appointment" }], mimeType: "multipart/alternative", parts: [{ mimeType: "text/plain", body: { data: b64("Your dentist appointment is today at 13:30.") } }] } });
      }
      if (url.includes("/messages/m2")) return json({ id: "m2", payload: { headers: [{ name: "Subject", value: "Sale" }], mimeType: "text/html", body: { data: b64("<p>50% off <b>everything</b></p>") } } });
      return json({ error: { message: "unexpected" } }, 404);
    }) as typeof fetch;
    return { http, calls };
  }

  function setup(answer: () => string) {
    const s = system({ claude: (req) => ({ text: req.prompt.includes("EMAIL 1") ? answer() : "?" }) });
    const clientFile = join(s.dataDir, "gmail-client.json");
    writeFileSync(clientFile, JSON.stringify({ installed: { client_id: "cid", client_secret: "secret" } }));
    writeFileSync(join(s.dataDir, "gmail-token.json"), JSON.stringify({ refresh_token: "rt", email: "me@gmail.com" }));
    const google = fakeGoogle();
    const gmail = new GmailReader(s.store, s.pool, { clientFile, dataDir: s.dataDir, query: "in:inbox", provider: "auto", node: "hub" }, google.http);
    return { s, gmail, google };
  }

  it("turns new mail into today's tasks once, and shows Gmail as a source", async () => {
    const { s, gmail, google } = setup(() => `Sure:\n{"tasks":[{"email":1,"title":"Dentist appointment","day":"${today}","time":"13:30","detail":"Clinic"}]}`);
    expect(await gmail.check()).toEqual({ scanned: 2, added: 1 });
    expect(s.store.tasksFor(today)).toMatchObject([{ id: "gmail:m1:0", title: "Dentist appointment", time: "13:30", source: "gmail", detail: "Clinic" }]);
    expect(s.prompts[0]).toContain("Your dentist appointment is today at 13:30.");
    expect(s.prompts[0]).toContain("50% off everything"); // HTML-only mail is read as text

    // Second pass: both emails were seen, so the model is not asked again.
    expect(await gmail.check()).toEqual({ scanned: 0, added: 0 });
    expect(s.prompts).toHaveLength(1);
    expect(google.calls.filter((u) => u.startsWith("https://oauth2")).length).toBe(1); // access token reused

    const app = createApp({ ...s, gmail, publicDir: "web/dist" });
    const home = await (await app.request("/api/home", { headers: { Authorization: "Bearer secret-token" } })).json();
    expect(home.sources.gmail).toBe(true);
    expect((await (await app.request("/api/gmail", { headers: { Authorization: "Bearer secret-token" } })).json()).email).toBe("me@gmail.com");
  });

  it("a bad answer keeps the mail for next time and shows up under needs a look", async () => {
    const { s, gmail } = setup(() => "I could not read these.");
    await expect(gmail.check()).rejects.toThrow(/could not read tasks/);
    expect(s.store.db.prepare("SELECT COUNT(*) AS n FROM gmail_seen").get()).toEqual({ n: 0 });
    const app = createApp({ ...s, gmail, publicDir: "web/dist" });
    const home = await (await app.request("/api/home", { headers: { Authorization: "Bearer secret-token" } })).json();
    expect(home.attention).toContainEqual(expect.objectContaining({ title: "Gmail check failed" }));
  });

  it("drops past, unknown and empty tasks from the model's answer", () => {
    const mails = [{ id: "a", from: "", subject: "", date: "", body: "" }];
    const text = `{"tasks":[{"email":1,"title":"Old","day":"2000-01-01"},{"email":5,"title":"Ghost"},{"email":1,"title":" "},{"email":1,"title":"Reply to Priya","time":"null"}]}`;
    expect(parseTasks(text, mails, today)).toEqual([{ id: "gmail:a:3", day: today, time: undefined, title: "Reply to Priya", detail: undefined }]);
    expect(parseTasks("no json here", mails, today)).toBeUndefined();
  });
});

describe("tasks from the AI_Assistant brain", () => {
  /** A UTC time without an offset, as the brain stores it, for a local clock time `days` from today. */
  const due = (days: number, h: number, m = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(h, m, 0, 0);
    return d.toISOString().slice(0, 19);
  };
  function fakeBrain(tasks: BrainTask[], opts: { down?: boolean } = {}) {
    const calls: string[] = [];
    const http = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url.replace("http://brain", "")} ${String((init?.headers as Record<string, string>)?.Authorization)}`);
      if (opts.down) throw new Error("connect ECONNREFUSED");
      const status = new URL(url).searchParams.get("status");
      const body = url.includes("/done") || url.includes("/confirm") ? {} : tasks.filter((t) => (status ? t.status === status : ["open", "pending_confirmation"].includes(t.status)));
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    return { http, calls };
  }

  it("puts today's, overdue and finished-today tasks on Today, and ticks them off in the brain", async () => {
    const s = system({});
    const tasks: BrainTask[] = [
      { id: 1, kind: "event", status: "open", title: "Dentist", due_at: due(0, 13, 30), source: "email", source_chat: "Clinic" },
      { id: 2, kind: "task", status: "pending_confirmation", title: "Send Priya the deck", due_at: due(0, 18), source: "whatsapp", source_chat: "Priya" },
      { id: 3, kind: "task", status: "open", title: "Pay the bill", due_at: due(-2, 17), source: "email" },
      { id: 4, kind: "task", status: "done", title: "Call Arun", due_at: due(0, 10) },
      { id: 5, kind: "task", status: "open", title: "Next week thing", due_at: due(5, 9) },
      { id: 6, kind: "task", status: "open", title: "Someday", due_at: null },
      { id: 7, kind: "event", status: "open", title: "Webinar yesterday", due_at: due(-1, 18), source: "email" },
      { id: 8, kind: "task", status: "open", title: "Six weeks late", due_at: due(-40, 9), source: "whatsapp" },
    ];
    const brain = fakeBrain(tasks);
    const a = new AssistantTasks(s.store, { url: "http://brain", token: "brain-secret", pollMinutes: 5 }, brain.http);
    expect(await a.sync()).toBe(4);
    const today = s.store.tasksFor(localDay());
    expect(today.map((t) => [t.id, t.time, t.source, t.done])).toEqual([
      ["brain:4", "10:00", "manual", true],
      ["brain:1", "13:30", "gmail", false],
      ["brain:2", "18:00", "whatsapp", false],
      ["brain:3", "overdue", "gmail", false],
    ]);
    expect(today.find((t) => t.id === "brain:2")?.detail).toBe("not confirmed yet · Priya");
    expect(brain.calls[0]).toContain("Bearer brain-secret");

    // Ticked off on the phone: done in the brain first, then here.
    const app = createApp({ ...s, assistant: a, publicDir: "web/dist" });
    const auth = { Authorization: "Bearer secret-token", "Content-Type": "application/json" };
    expect((await app.request("/api/tasks/brain:1/done", { method: "POST", headers: auth, body: JSON.stringify({ done: true }) })).status).toBe(200);
    expect(brain.calls.at(-1)).toMatch(/^POST \/tasks\/1\/done /);
    expect((await app.request("/api/tasks/brain:1/done", { method: "POST", headers: auth, body: JSON.stringify({ done: false }) })).status).toBe(200);
    expect(brain.calls.at(-1)).toMatch(/^POST \/tasks\/1\/confirm /);

    // Rejected in Telegram: it leaves Today on the next sync.
    tasks[1].status = "rejected";
    await a.sync();
    expect(s.store.tasksFor(localDay()).map((t) => t.id)).not.toContain("brain:2");

    const home = await (await app.request("/api/home", { headers: auth })).json();
    expect(home.sources.gmail).toBe(true);
  });

  it("shows an unreachable brain under needs a look and refuses to tick its tasks", async () => {
    const s = system({});
    const a = new AssistantTasks(s.store, { url: "http://brain", token: "t", pollMinutes: 5 }, fakeBrain([], { down: true }).http);
    await expect(a.sync()).rejects.toThrow(/did not answer/);
    const app = createApp({ ...s, assistant: a, publicDir: "web/dist" });
    const auth = { Authorization: "Bearer secret-token", "Content-Type": "application/json" };
    const home = await (await app.request("/api/home", { headers: auth })).json();
    expect(home.attention).toContainEqual(expect.objectContaining({ title: "Can't reach the brain" }));
    expect(home.sources.gmail).toBe(false);
    expect((await app.request("/api/tasks/brain:9/done", { method: "POST", headers: auth, body: "{}" })).status).toBe(502);
  });
});

describe("groq", () => {
  it("classifies with Groq, then answers a quick question with it", async () => {
    const s = system({
      groq: (req) => ({ text: req.prompt.startsWith("Classify this task") ? '{"kind":"quick","complexity":"simple","needsWeb":false,"needsWorkspace":false}' : "Paris" }),
      claude: () => ({ text: "from claude" }),
    });
    const run = await s.orchestrator.runToCompletion("What's the capital of France? Explain the decision briefly.", { mode: "auto" });
    expect(run.classification).toMatchObject({ kind: "quick", complexity: "simple" });
    expect(run.steps[0].provider).toBe("groq");
    expect(run.result).toBe("Paris");
  });

  it("falls back to keywords when Groq fails, and the run still finishes", async () => {
    const s = system({ groq: () => ({ ok: false, error: "HTTP 500" }), claude: () => ({ text: "from claude" }) });
    const run = await s.orchestrator.runToCompletion("Fix this TypeError crash in my React app", { mode: "direct" });
    expect(run.classification?.kind).toBe("debugging");
    expect(run.result).toBe("from claude");
  });

  it("streams from an OpenAI-compatible API and reads its rate limits", async () => {
    let mode = "ok";
    let body: any;
    const seenKeys: string[] = [];
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        body = JSON.parse(raw);
        const key = String(req.headers.authorization).slice(7);
        if (mode === "per-key") {
          seenKeys.push(key);
          if (key.startsWith("limited")) return void res.writeHead(429, { "retry-after": "60" }).end("slow down");
          if (key === "revoked") return void res.writeHead(401).end("invalid key");
        }
        if (mode === "limit") return void res.writeHead(429, { "retry-after": "30" }).end('{"error":{"message":"rate limit"}}');
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"lo"}}],"x_groq":{"usage":{"prompt_tokens":5,"completion_tokens":2}}}\n\n');
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanup.push(() => server.close());
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const p = new OpenAICompatProvider("groq", { baseUrl, apiKey: "k", model: "small", deepModel: "big" }, "no key");

    const deltas: string[] = [];
    const r = await p.run({ prompt: "hi", system: "be brief", deep: true, onDelta: (t) => deltas.push(t) });
    expect(r).toMatchObject({ ok: true, text: "Hello", provider: "groq", model: "big", usage: { inputTokens: 5, outputTokens: 2 } });
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(body.messages).toEqual([{ role: "system", content: "be brief" }, { role: "user", content: "hi" }]);

    mode = "limit";
    const limited = await p.run({ prompt: "hi" });
    expect(limited).toMatchObject({ ok: false, rateLimited: true });
    expect(limited.retryAt! - Date.now()).toBeGreaterThan(25_000);

    // Several keys: a limited one rests and the next is used; a rejected one is skipped.
    mode = "per-key";
    const rot = new OpenAICompatProvider("groq", { baseUrl, apiKeys: ["limited", "revoked", "good"], model: "small" }, "no key");
    expect((await rot.detect()).detail).toContain("3 keys in rotation");
    expect(await rot.run({ prompt: "hi" })).toMatchObject({ ok: true, text: "Hello" });
    expect(await rot.run({ prompt: "hi" })).toMatchObject({ ok: true, text: "Hello" });
    expect(seenKeys).toEqual(["limited", "revoked", "good", "good"]); // the resting keys are not tried again

    const allLimited = new OpenAICompatProvider("groq", { baseUrl, apiKeys: ["limited", "limited2"], model: "small" }, "no key");
    expect(await allLimited.run({ prompt: "hi" })).toMatchObject({ ok: false, rateLimited: true });

    const noKey = new OpenAICompatProvider("groq", { baseUrl, model: "small" }, "Set GROQ_API_KEY");
    expect(await noKey.detect()).toMatchObject({ authenticated: false, detail: "Set GROQ_API_KEY" });
    expect((await noKey.run({ prompt: "hi" })).error).toBe("Set GROQ_API_KEY");
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
