import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type Context, type Next } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { stream, streamSSE } from "hono/streaming";
import { z } from "zod";
import type { BranchLine, Cluster, ExecLine } from "../cluster/cluster.js";
import type { Config } from "../config.js";
import type { Orchestrator } from "../brain/orchestrator.js";
import type { Router } from "../brain/router.js";
import type { ProviderPool } from "../providers/registry.js";
import type { Store } from "../store/db.js";
import { PROVIDER_IDS, type ProviderId, type RunEvent, type RunOptions } from "../types.js";
import { buildHome, buildInsights, localDay } from "./home.js";
import type { GmailReader } from "../integrations/gmail.js";
import type { Notifier } from "./push.js";

export interface AppDeps {
  config: Config;
  store: Store;
  pool: ProviderPool;
  cluster: Cluster;
  router: Router;
  orchestrator: Orchestrator;
  /** Static UI directory, relative to the process working directory. */
  publicDir: string;
  /** Phone notifications; absent in tests. */
  notifier?: Notifier;
  /** Today's tasks from your mail; absent in tests that don't need it. */
  gmail?: GmailReader;
}

const Provider = z.enum(PROVIDER_IDS as [ProviderId, ...ProviderId[]]);
const RunOptionsBody = z.object({
  mode: z.enum(["auto", "direct", "plan", "design"]).optional(),
  provider: Provider.optional(),
  agent: z.string().optional(),
  cwd: z.string().optional(),
  permission: z.enum(["read", "edit", "full"]).optional(),
  nodes: z.array(z.string()).optional(),
  branches: z.boolean().optional(),
  ask: z.boolean().optional(),
  checkpoints: z.boolean().optional(),
});
const RunBody = RunOptionsBody.extend({ task: z.string().min(1).max(200_000), threadId: z.string().optional() });
const MessageBody = RunOptionsBody.extend({ text: z.string().min(1).max(200_000) });
const ReviewBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("continue") }),
  z.object({ action: z.literal("edit"), output: z.string().min(1) }),
  z.object({ action: z.literal("redo"), instructions: z.string().min(1).max(20_000) }),
]);
const PushSubBody = z.object({ endpoint: z.string().url(), keys: z.object({ p256dh: z.string(), auth: z.string() }), expirationTime: z.number().nullable().optional() });
const ExecBody = z.object({
  provider: Provider,
  prompt: z.string().min(1),
  system: z.string().optional(),
  model: z.string().optional(),
  deep: z.boolean().optional(),
  permission: z.enum(["read", "edit", "full"]).optional(),
  timeoutMs: z.number().optional(),
});
const BranchJobBody = z.object({
  repoUrl: z.string().min(1),
  base: z.string().regex(/^[0-9a-f]{7,64}$/i),
  // Workers only ever write to the orchestrator's own branch namespace.
  branch: z.string().regex(/^orc\/[\w./-]+$/).refine((b) => !b.includes("..")),
  mergeBranches: z.array(z.string().regex(/^orc\/[\w./-]+$/)).optional(),
  title: z.string().min(1).max(300),
  provider: Provider,
  prompt: z.string().min(1),
  system: z.string().optional(),
  model: z.string().optional(),
  deep: z.boolean().optional(),
  files: z.array(z.string()).optional(),
  testCommand: z.string(),
  timeoutMs: z.number().optional(),
});
const TaskBody = z.object({
  /** Lets a reader re-send the same message's task without duplicating it. */
  id: z.string().regex(/^[\w.:-]{1,120}$/).optional(),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  time: z.string().max(40).optional(),
  title: z.string().min(1).max(300),
  source: z.enum(["gmail", "whatsapp", "manual"]).default("manual"),
  detail: z.string().max(200).optional(),
});
const ChatBody = z.object({
  model: z.string().default("orchestrator"),
  messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.any()), z.null()]) })).min(1),
  stream: z.boolean().optional(),
});
type ChatMessages = z.infer<typeof ChatBody>["messages"];

function isLoopback(addr?: string) {
  return !!addr && (addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1");
}

function tokenOk(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Flattens OpenAI-style messages into one prompt for CLI agents. */
export function messagesToPrompt(messages: ChatMessages): { system?: string; prompt: string } {
  const text = (c: unknown) =>
    typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => (p?.type === "text" ? p.text : "")).join("") : "";
  const system = messages.filter((m) => m.role === "system").map((m) => text(m.content)).join("\n\n") || undefined;
  const convo = messages.filter((m) => m.role !== "system");
  if (convo.length === 1) return { system, prompt: text(convo[0].content) };
  const prompt =
    convo.map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${text(m.content)}`).join("\n\n") +
    "\n\nRespond to the last User message, using the conversation above as context.";
  return { system, prompt };
}

/** Maps an OpenAI "model" name onto run options. */
export function modelToOptions(model: string): RunOptions {
  if (model === "orchestrator-plan") return { mode: "plan" };
  if (model === "auto") return { mode: "direct" };
  if ((PROVIDER_IDS as string[]).includes(model)) return { mode: "direct", provider: model as ProviderId };
  if (model.startsWith("agent:")) return { mode: "direct", agent: model.slice(6) };
  return { mode: "auto" };
}

export function createApp(d: AppDeps) {
  const app = new Hono();
  const token = d.config.server.token;

  // Loopback is trusted; everything else (other tailnet devices, your phone) needs the token.
  const auth = async (c: Context, next: Next) => {
    const addr = (c.env as any)?.incoming?.socket?.remoteAddress as string | undefined;
    // A local proxy (tailscale serve, a reverse proxy) also connects from loopback but carries
    // other devices' requests: only trust loopback when nothing forwarded the request.
    const proxied = ["x-forwarded-for", "forwarded", "x-forwarded-host", "tailscale-user-login"].some((h) => c.req.header(h));
    if (isLoopback(addr) && !proxied) return next();
    const header = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (token && tokenOk(header, token)) return next();
    return c.json({ error: "unauthorized: send Authorization: Bearer <server.token>" }, 401);
  };
  app.use("/api/*", auth);
  app.use("/node/*", auth);
  app.use("/v1/*", auth);

  app.get("/api/health", (c) => c.json({ ok: true, node: d.cluster.name }));

  // ---- providers & devices
  app.get("/api/providers", async (c) => c.json(await d.pool.status(c.req.query("refresh") === "1")));
  app.post("/api/providers/:id/test", async (c) => {
    const id = Provider.parse(c.req.param("id"));
    return c.json(await d.pool.run(id, { prompt: "Reply with exactly: OK", permission: "read", timeoutMs: 180_000 }));
  });
  app.post("/api/providers/:id/clear-cooldown", (c) => {
    d.pool.clearCooldown(Provider.parse(c.req.param("id")));
    return c.json({ ok: true });
  });
  app.get("/api/nodes", async (c) => c.json({ self: await d.cluster.localInfo(), peers: d.cluster.list() }));
  app.post("/api/nodes/refresh", async (c) => {
    await d.cluster.refresh();
    return c.json({ self: await d.cluster.localInfo(), peers: d.cluster.list() });
  });
  app.get("/api/agents", (c) => c.json([...d.orchestrator.agents.values()]));
  app.get("/api/capabilities", (c) => c.json(d.router.caps));
  app.get("/api/memory", (c) => c.json(d.store.searchMemory(c.req.query("q") ?? "", Number(c.req.query("limit") ?? 10))));
  app.get("/api/usage", (c) => c.json(d.store.usage(Number(c.req.query("days") ?? 7))));

  // ---- home screen
  app.get("/api/home", async (c) => c.json(await buildHome(d)));
  app.get("/api/insights", (c) => c.json(buildInsights(d.store, Math.min(90, Math.max(1, Number(c.req.query("days") ?? 7))))));
  // Today's tasks. Mail and message readers add them here; so can you.
  app.get("/api/tasks", (c) => c.json(d.store.tasksFor(c.req.query("day") ?? localDay())));
  app.post("/api/tasks", async (c) => {
    const t = TaskBody.parse(await c.req.json());
    const task = { id: t.id ?? randomUUID().slice(0, 8), day: t.day ?? localDay(), time: t.time, title: t.title, source: t.source, detail: t.detail };
    d.store.addTask(task);
    return c.json({ ...task, done: false }, 201);
  });
  app.post("/api/tasks/:id/done", async (c) => {
    const { done } = z.object({ done: z.boolean().default(true) }).parse(await c.req.json().catch(() => ({})));
    return d.store.setTaskDone(c.req.param("id"), done) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });
  app.get("/api/gmail", (c) => c.json(d.gmail?.status() ?? { configured: false, connected: false }));
  app.post("/api/gmail/check", async (c) => {
    if (!d.gmail?.status().connected) return c.json({ error: "Gmail is not connected: run `orc gmail connect` on the hub" }, 409);
    return c.json(await d.gmail.check());
  });
  app.delete("/api/tasks/:id", (c) => {
    d.store.deleteTask(c.req.param("id"));
    return c.json({ ok: true });
  });

  // ---- runs
  app.get("/api/runs",(c) => c.json(d.store.listRuns(Number(c.req.query("limit") ?? 50))));
  app.post("/api/runs", async (c) => {
    const { task, ...options } = RunBody.parse(await c.req.json());
    return c.json(d.orchestrator.submit(task, options), 201);
  });
  app.get("/api/runs/:id", (c) => {
    const run = d.orchestrator.get(c.req.param("id"));
    return run ? c.json(run) : c.json({ error: "not found" }, 404);
  });
  app.post("/api/runs/:id/cancel", (c) => c.json({ ok: d.orchestrator.cancel(c.req.param("id")) }));

  // ---- talking to the agents while they work
  const notWaiting = (c: Context, what: string) => c.json({ error: `this step is not ${what}` }, 409);
  app.post("/api/runs/:id/steps/:step/answer", async (c) => {
    const { answer } = z.object({ answer: z.string().min(1).max(20_000) }).parse(await c.req.json());
    return d.orchestrator.answer(c.req.param("id"), c.req.param("step"), answer) ? c.json({ ok: true }) : notWaiting(c, "asking a question");
  });
  app.post("/api/runs/:id/steps/:step/review", async (c) => {
    const decision = ReviewBody.parse(await c.req.json());
    return d.orchestrator.review(c.req.param("id"), c.req.param("step"), decision) ? c.json({ ok: true }) : notWaiting(c, "paused for review");
  });
  app.post("/api/runs/:id/steps/:step/edit", async (c) => {
    const { output } = z.object({ output: z.string().min(1) }).parse(await c.req.json());
    const r = d.orchestrator.editStep(c.req.param("id"), c.req.param("step"), output);
    return r.ok ? c.json(r) : c.json(r, 409);
  });
  app.post("/api/runs/:id/steps/:step/stop", (c) =>
    d.orchestrator.stopStep(c.req.param("id"), c.req.param("step")) ? c.json({ ok: true }) : notWaiting(c, "running"),
  );

  app.get("/api/active", (c) => c.json(d.orchestrator.active()));

  // ---- conversations
  app.get("/api/threads", (c) => c.json(d.store.listThreads(Number(c.req.query("limit") ?? 100))));
  app.post("/api/threads", async (c) => {
    const { title } = z.object({ title: z.string().max(200).optional() }).parse(await c.req.json().catch(() => ({})));
    const now = Date.now();
    const t = { id: randomUUID().slice(0, 8), title: title?.trim() || "New conversation", createdAt: now, updatedAt: now };
    d.store.createThread(t);
    return c.json(t, 201);
  });
  app.get("/api/threads/:id", (c) => {
    const thread = d.store.getThread(c.req.param("id"));
    if (!thread) return c.json({ error: "not found" }, 404);
    // Live runs are fresher than what is on disk.
    const runs = d.store.threadRuns(thread.id).map((r) => d.orchestrator.get(r.id) ?? r);
    return c.json({ thread, runs });
  });
  app.patch("/api/threads/:id", async (c) => {
    const { title } = z.object({ title: z.string().min(1).max(200) }).parse(await c.req.json());
    if (!d.store.getThread(c.req.param("id"))) return c.json({ error: "not found" }, 404);
    d.store.touchThread(c.req.param("id"), title);
    return c.json({ ok: true });
  });
  app.delete("/api/threads/:id", (c) => {
    d.store.deleteThread(c.req.param("id"));
    return c.json({ ok: true });
  });
  /** A new message in a conversation: a run that sees the earlier turns. */
  app.post("/api/threads/:id/messages", async (c) => {
    const thread = d.store.getThread(c.req.param("id"));
    if (!thread) return c.json({ error: "not found" }, 404);
    const { text, ...options } = MessageBody.parse(await c.req.json());
    if (thread.title === "New conversation") d.store.touchThread(thread.id, text.replace(/\s+/g, " ").trim().slice(0, 80));
    return c.json(d.orchestrator.submit(text, { ...options, threadId: thread.id }), 201);
  });

  // ---- phone notifications
  app.get("/api/push/key", (c) => (d.notifier ? c.json({ publicKey: d.notifier.publicKey }) : c.json({ error: "notifications are off" }, 404)));
  app.post("/api/push/subscribe", async (c) => {
    if (!d.notifier) return c.json({ error: "notifications are off" }, 404);
    d.notifier.subscribe(PushSubBody.parse(await c.req.json()) as never);
    return c.json({ ok: true });
  });
  app.get("/api/push/fcm", (c) => c.json({ enabled: !!d.notifier?.fcm }));
  app.post("/api/push/fcm", async (c) => {
    if (!d.notifier?.fcm) return c.json({ error: "the hub has no Firebase key (server.fcmServiceAccount)" }, 404);
    const { token } = z.object({ token: z.string().min(20).max(4096) }).parse(await c.req.json());
    d.notifier.subscribeFcm(token);
    return c.json({ ok: true });
  });
  app.post("/api/push/unsubscribe", async (c) => {
    const { endpoint } = z.object({ endpoint: z.string() }).parse(await c.req.json());
    d.notifier?.unsubscribe(endpoint);
    return c.json({ ok: true });
  });
  app.post("/api/push/test", async (c) => {
    const sent = (await d.notifier?.notify({ title: "Orchestrator", body: "Notifications work.", url: "/", tag: "test" })) ?? 0;
    return c.json({ sent });
  });
  // Branch work: merge a step's branch into the branch checked out in the run's folder.
  app.post("/api/runs/:id/steps/:step/merge", async (c) => {
    const r = await d.orchestrator.mergeBranch(c.req.param("id"), c.req.param("step"));
    return r.ok ? c.json(r) : c.json(r, 409);
  });
  // Design mode: the run waits here until you approve the design or send it back.
  app.post("/api/runs/:id/approve", async (c) => {
    const { notes } = z.object({ notes: z.string().max(20_000).optional() }).parse(await c.req.json().catch(() => ({})));
    const ok = d.orchestrator.decide(c.req.param("id"), { action: "approve", notes: notes?.trim() || undefined });
    return ok ? c.json({ ok }) : c.json({ error: "this run is not waiting for design approval" }, 409);
  });
  app.post("/api/runs/:id/revise", async (c) => {
    const { feedback } = z.object({ feedback: z.string().min(1).max(20_000) }).parse(await c.req.json());
    const ok = d.orchestrator.decide(c.req.param("id"), { action: "revise", feedback });
    return ok ? c.json({ ok }) : c.json({ error: "this run is not waiting for design approval" }, 409);
  });
  app.post("/api/runs/:id/steps/:step/rate", async (c) => {
    const { rating } = z.object({ rating: z.union([z.literal(1), z.literal(-1)]) }).parse(await c.req.json());
    const run = d.orchestrator.get(c.req.param("id"));
    const step = run?.steps.find((s) => s.id === c.req.param("step"));
    if (!run || !step?.provider) return c.json({ error: "step not found or never ran" }, 404);
    d.store.rate(run.id, step.id, step.kind, step.provider, rating);
    return c.json({ ok: true });
  });

  /** Replays stored events, then streams live ones until the run ends. */
  app.get("/api/runs/:id/events", (c) => {
    const id = c.req.param("id");
    return streamSSE(c, async (sse) => {
      const queue: RunEvent[] = [];
      let wake: (() => void) | undefined;
      const unsub = d.orchestrator.subscribe(id, (ev) => {
        queue.push(ev);
        wake?.();
      });
      sse.onAbort(unsub);
      let lastSeq = 0;
      for (const ev of d.store.events(id)) {
        lastSeq = ev.seq;
        await sse.writeSSE({ event: ev.type, data: JSON.stringify(ev), id: String(ev.seq) });
      }
      const run = d.orchestrator.get(id);
      let finished = !run || ["done", "failed", "cancelled"].includes(run.status);
      while (!finished && !sse.aborted) {
        if (!queue.length) {
          await Promise.race([new Promise<void>((r) => (wake = r)), sse.sleep(15_000)]);
          wake = undefined;
          if (!queue.length) {
            await sse.writeSSE({ event: "ping", data: "{}" });
            continue;
          }
        }
        const ev = queue.shift()!;
        // Already replayed from the store (deltas are never stored, so always pass).
        if (ev.seq <= lastSeq && ev.type !== "step.delta") continue;
        await sse.writeSSE({ event: ev.type, data: JSON.stringify(ev), id: String(ev.seq) });
        if (ev.type === "run.completed" || ev.type === "run.failed") finished = true;
      }
      unsub();
    });
  });

  // ---- device-to-device (called by other machines on your tailnet)
  app.get("/node/info", async (c) => c.json(await d.cluster.localInfo()));
  app.post("/node/exec", async (c) => {
    const body = ExecBody.parse(await c.req.json());
    const workRoot = resolve(d.config.node.workRoot);
    mkdirSync(workRoot, { recursive: true });
    c.header("Content-Type", "application/x-ndjson");
    return stream(c, async (s) => {
      const abort = new AbortController();
      s.onAbort(() => abort.abort());
      const write = (line: ExecLine) => s.write(JSON.stringify(line) + "\n");
      const result = await d.pool.run(body.provider, {
        prompt: body.prompt,
        system: body.system,
        model: body.model,
        deep: body.deep,
        // Remote steps never change files on this device: read-only, in its work root.
        permission: "read",
        cwd: workRoot,
        timeoutMs: body.timeoutMs,
        signal: abort.signal,
        onDelta: (text) => void write({ type: "delta", text }),
        onProgress: (note) => void write({ type: "progress", note }),
      });
      d.store.recordUsage(body.provider, d.cluster.name, result.ok, result.durationMs);
      await write({ type: "result", result });
    });
  });

  /** A coding step to do on its own git branch: clone/fetch, edit, test, commit, push. */
  app.post("/node/branch-job", async (c) => {
    if (!d.config.node.acceptBranchWork) return c.json({ error: `device ${d.cluster.name} does not accept branch work (set node.acceptBranchWork: true)` }, 403);
    const job = BranchJobBody.parse(await c.req.json());
    c.header("Content-Type", "application/x-ndjson");
    return stream(c, async (s) => {
      const abort = new AbortController();
      s.onAbort(() => abort.abort());
      const write = (line: BranchLine) => s.write(JSON.stringify(line) + "\n");
      const result = await d.cluster.runBranch(d.cluster.name, job, {
        signal: abort.signal,
        onDelta: (text) => void write({ type: "delta", text }),
        onProgress: (note) => void write({ type: "progress", note }),
      });
      if (result.agent) d.store.recordUsage(job.provider, d.cluster.name, result.agent.ok, result.agent.durationMs);
      await write({ type: "result", result });
    });
  });

  // ---- OpenAI-compatible API: point any OpenAI-speaking tool at http://<host>:4317/v1
  app.get("/v1/models", (c) => {
    const ids = ["orchestrator", "orchestrator-plan", "auto", ...PROVIDER_IDS, ...[...d.orchestrator.agents.keys()].map((a) => `agent:${a}`)];
    return c.json({ object: "list", data: ids.map((id) => ({ id, object: "model", created: 0, owned_by: "orchestrator" })) });
  });
  app.post("/v1/chat/completions", async (c) => {
    const body = ChatBody.parse(await c.req.json());
    const { system, prompt } = messagesToPrompt(body.messages);
    const task = system ? `${system}\n\n${prompt}` : prompt;
    const run = d.orchestrator.submit(task, modelToOptions(body.model));
    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl-${run.id}`;

    if (!body.stream) {
      const done = await d.orchestrator.wait(run.id)!;
      if (done.status !== "done") return c.json({ error: { message: done.error ?? done.status, type: "orchestrator_error" } }, 502);
      return c.json({
        id,
        object: "chat.completion",
        created,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: done.result ?? "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

    return streamSSE(c, async (sse) => {
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        sse.writeSSE({ data: JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] }) });
      await chunk({ role: "assistant" });
      // Stream the answer as it's written: the only step of a direct run, or the synthesis of a plan.
      // Intermediate steps of a multi-step plan would be confusing in a chat client.
      const isAnswerStream = (stepId?: string) => stepId === "synthesis" || (d.orchestrator.get(run.id)?.plan?.steps.length ?? 0) <= 1;
      let streamed = false;
      const pending: Promise<unknown>[] = [];
      const unsub = d.orchestrator.subscribe(run.id, (ev) => {
        if (ev.type === "step.delta" && isAnswerStream(ev.stepId)) {
          streamed = true;
          pending.push(chunk({ content: (ev.data as { text: string }).text }));
        }
      });
      sse.onAbort(() => {
        unsub();
        d.orchestrator.cancel(run.id);
      });
      const done = await d.orchestrator.wait(run.id)!;
      unsub();
      await Promise.all(pending);
      if (!streamed) await chunk({ content: done.status === "done" ? (done.result ?? "") : `Error: ${done.error}` });
      await chunk({}, "stop");
      await sse.writeSSE({ data: "[DONE]" });
    });
  });

  app.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues }, 400);
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  // ---- web UI
  app.use("/*", serveStatic({ root: d.publicDir }));
  return app;
}
