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
import { PROVIDER_IDS, type ProviderId, type RunEvent, type RunOptions, TASK_KINDS, type TaskKind } from "../types.js";
import { buildHome, buildInsights, localDay } from "./home.js";
import type { AssistantTasks } from "../integrations/assistant.js";
import type { GmailReader } from "../integrations/gmail.js";
import { type Notifier, alertPayload } from "./push.js";
import { letGo } from "../whatsapp/convo.js";
import { people } from "../whatsapp/people.js";
import type { ReplyDrafter } from "../whatsapp/drafter.js";
import { CallError, type CallDesk } from "../calls/desk.js";
import { type AskReply, sayFor, type TalkReply } from "../voice/talk.js";
import { TTS_PROVIDERS, type Tts, TtsError } from "../voice/tts.js";
import type { ToolRegistry } from "../ai/tools.js";
import { JOB_KINDS, type JobKind, type ModelRouter, RouteError, sizeOf } from "../ai/route.js";
import { buildAiHub, setPreferred } from "./ai-hub.js";
import { mountApkNode, mountBuilds } from "./builds.js";
import { mountFiles } from "./files.js";
import { mountPhone } from "./phone.js";
import { mountOutside } from "./outside.js";
import { mountWork } from "./work.js";
import type { WorkDesk } from "../work/desk.js";
import type { OutsideAgents } from "../outside/agents.js";
import type { PhoneDesk } from "../phone/desk.js";
import type { FileClient } from "../files/client.js";
import type { FileIndex } from "../files/index.js";
import type { BuildDesk } from "../builds/desk.js";
import type { Build } from "../types.js";
import type { StyleBook } from "../whatsapp/learn.js";
import type { MemoryReplica } from "../shared/replica.js";
import { type Ask, AskBody, askBrain, mountSharedMemory } from "./shared-memory.js";
import type { ActionHub } from "../actions/desk.js";
import { mountActions } from "./actions.js";
import { mountBrain } from "./brain.js";

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
  /** Today's tasks from the AI_Assistant brain; absent when BRAIN_TOKEN is not set. */
  assistant?: AssistantTasks;
  /** WhatsApp replies in your style; absent in tests that don't need it. */
  drafter?: ReplyDrafter;
  /** Voice calls about brain alerts; absent in tests that don't need it. */
  calls?: CallDesk;
  /** Jarvis's voice from a speech service; absent means the phone speaks for itself. */
  tts?: Tts;
  /** Every AI tool with cost, limits, live state and usage today (src/ai/tools.ts). */
  tools?: ToolRegistry;
  /** The model router (R2): fallback chains for the hub's own jobs and raw:auto. */
  models?: ModelRouter;
  /** Builds of apps on command (phase 2) and their previews. */
  builds?: BuildDesk;
  preview?: (b: Build) => Promise<void>;
  /** The file index of every device (on the hub) and this device's side of it (D2). */
  fileIndex?: FileIndex;
  files?: FileClient;
  /** Things to do on the phone, waiting for the owner's tap (D3). */
  phone?: PhoneDesk;
  /** Outside agents with their own tokens and scopes, over MCP at /mcp (phase 4). */
  outside?: OutsideAgents;
  /** Work: people you give tasks to, followed through WhatsApp. */
  work?: WorkDesk;
  /** This device's copy of the shared memory pool; absent when sharedMemory.enabled is false. */
  replica?: MemoryReplica;
  /** How /node/memory/* reaches the brain; tests pass a fake. */
  brainFetch?: typeof fetch;
  /** Device actions and their approvals; absent in tests that don't need them. */
  actions?: ActionHub;
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
/** An alert from the AI_Assistant brain (brain/app/alerts.py as_dict). */
const NotifyBody = z.object({
  id: z.number().int(),
  level: z.number().int().min(1).max(4),
  kind: z.string().max(40),
  title: z.string().min(1).max(200),
  body: z.string().max(2000).default(""),
  task_id: z.number().int().nullable().optional(),
  created_at: z.string().optional(),
});
const AckBody = z.object({ action: z.enum(["done", "snooze", "dismiss"]) });
/** A call turn as JSON: typed words, or a base64 voice clip. (The app sends voice as multipart.) */
const TurnBody = z.object({ text: z.string().max(4000).optional(), audio: z.string().max(14_000_000).optional(), mime: z.string().max(60).optional() });
/** Voice clips above this are refused (Groq's own limit is 25 MB; a minute of speech is ~0.5 MB). */
const MAX_CLIP = 10 * 1024 * 1024;
const CLIP_EXT: Record<string, string> = { "audio/mp4": "m4a", "audio/m4a": "m4a", "audio/x-m4a": "m4a", "audio/aac": "m4a", "audio/webm": "webm", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/ogg": "ogg", "audio/3gpp": "3gp" };
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
  mountSharedMemory(app, d);
  mountActions(app, d);
  mountBrain(app, d);
  mountBuilds(app, d);
  mountWork(app, d);
  mountApkNode(app, d);
  mountFiles(app, d);
  mountPhone(app, d);
  mountOutside(app, {
    outside: d.outside,
    replica: d.replica,
    actions: d.actions,
    devices: () => [{ name: d.cluster.name, online: true, platform: process.platform }, ...d.cluster.list().map((p) => ({ name: p.name, online: p.online, platform: p.platform }))],
  });

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
  // The tool registry: every AI the hub can use, its cost class, limits, state and use today. ?fresh=1 re-detects logins.
  app.get("/api/tools", async (c) => {
    if (!d.tools) return c.json({ error: "the tool registry is not set up on this hub" }, 404);
    return c.json({ tools: await d.tools.list(c.req.query("fresh") === "1") });
  });
  // The model router's choice for a job, without running it: ?kind=whatsapp_draft|mail|call|brain|<task kind>&size=small|medium|large&override=<provider>
  app.get("/api/tools/route", async (c) => {
    if (!d.models) return c.json({ error: "the model router is not set up on this hub" }, 404);
    const kind = c.req.query("kind") ?? "brain";
    if (!(JOB_KINDS as readonly string[]).includes(kind) && !(TASK_KINDS as readonly string[]).includes(kind)) return c.json({ error: `unknown kind ${kind}` }, 400);
    const size = z.enum(["small", "medium", "large"]).catch("medium").parse(c.req.query("size"));
    const override = Provider.safeParse(c.req.query("override"));
    return c.json(await d.models.routeFor(kind as JobKind | TaskKind, size, { override: override.success ? override.data : undefined }));
  });
  // The app's AI hub screen (R4): tools, what each job would use now, caps, the week. ?fresh=1 re-detects logins.
  app.get("/api/ai-hub", async (c) => {
    if (!d.tools || !d.models) return c.json({ error: "the AI hub is not set up on this hub" }, 404);
    return c.json(await buildAiHub({ tools: d.tools, models: d.models, store: d.store }, c.req.query("fresh") === "1"));
  });
  app.put("/api/ai-hub/prefer", async (c) => c.json(await setPreferred(c, d.store)));
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
    // A brain task is ticked off in the brain first, so the two never disagree.
    if (c.req.param("id").startsWith("brain:")) {
      if (!d.assistant) return c.json({ error: "this task is from the brain, which is not connected (BRAIN_TOKEN)" }, 409);
      try {
        await d.assistant.setDone(c.req.param("id"), done);
      } catch (e) {
        return c.json({ error: (e as Error).message }, 502);
      }
    }
    return d.store.setTaskDone(c.req.param("id"), done) ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
  });
  app.get("/api/assistant", (c) => c.json(d.assistant ? { configured: true, ...d.assistant.status() } : { configured: false, ok: false }));
  app.get("/api/gmail", (c) => c.json(d.gmail?.status() ?? { configured: false, connected: false }));
  // WhatsApp replies in your style. The device running `orc whatsapp link` sends messages here;
  // `orc style push` sends the style book. Nothing on the hub can send a WhatsApp message.
  const noDrafter = (c: Context) => c.json({ error: "WhatsApp drafting is off on this hub" }, 404);
  app.get("/api/style", (c) => (d.drafter ? c.json(d.drafter.status()) : noDrafter(c)));
  // The people in the style book (cards and counts, no messages) for the app's People screen.
  app.get("/api/style/people", (c) => {
    if (!d.drafter) return noDrafter(c);
    const book = d.drafter.book();
    return c.json({ builtAt: book?.builtAt ?? null, people: book ? people(book) : [] });
  });
  app.put("/api/style", async (c) => {
    if (!d.drafter) return noDrafter(c);
    const book = (await c.req.json()) as StyleBook;
    if (book?.version !== 1 || !Array.isArray(book.contacts)) return c.json({ error: "not a style book" }, 400);
    d.drafter.saveBook(book);
    return c.json({ ok: true, contacts: book.contacts.length });
  });
  const WaMessageBody = z.object({
    id: z.string().min(1),
    chatId: z.string().min(3),
    chatName: z.string().optional(),
    senderId: z.string(),
    senderName: z.string().optional(),
    fromMe: z.boolean(),
    isGroup: z.boolean(),
    text: z.string(),
    mediaType: z.string().optional(),
    transcript: z.string().optional(),
    quoted: z.string().optional(),
    ts: z.number(),
    chatPhone: z.string().regex(/^\d{6,15}$/).optional(),
  });
  app.post("/api/whatsapp/messages", async (c) => {
    if (!d.drafter) return noDrafter(c);
    const body = z.object({ messages: z.array(WaMessageBody).max(5000), live: z.boolean().default(true) }).parse(await c.req.json());
    const out = d.drafter.ingest(body.messages, body.live);
    // a live message with one of your Work people can move their task on (in the background)
    if (body.live && d.work) void d.work.onMessages(body.messages).catch(() => undefined);
    return c.json(out);
  });
  // Hidden-id chats' phone numbers, which the link learns from WhatsApp: "Send in WhatsApp" then opens that chat.
  app.post("/api/whatsapp/phones", async (c) => {
    if (!d.drafter) return noDrafter(c);
    const pairs = z.record(z.string().regex(/@lid$/), z.string().regex(/^\d{6,15}$/)).parse((await c.req.json()).phones ?? {});
    return c.json({ updated: d.drafter.wa.setPhones(pairs) });
  });
  app.get("/api/whatsapp/drafts", (c) => (d.drafter ? c.json(d.drafter.drafts()) : noDrafter(c)));
  // A chat that went quiet after your message: hide it from Home until it moves again.
  app.post("/api/whatsapp/quiet/:chatId/let-go", (c) => {
    letGo(d.store.db, c.req.param("chatId"));
    return c.json({ ok: true });
  });
  app.post("/api/whatsapp/drafts", async (c) => {
    if (!d.drafter) return noDrafter(c);
    const { chatId, ask } = z.object({ chatId: z.string(), ask: z.string().max(1000).optional() }).parse(await c.req.json());
    try {
      const draft = await d.drafter.draft(chatId, ask);
      return draft ? c.json(draft, 201) : c.json({ skipped: true, reason: "nothing to answer: your message is the last one" });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  });
  // The phone saw a WhatsApp message in WhatsApp's own notification and wants reply options for it.
  // Nothing is stored or sent here: the phone shows them and WhatsApp itself sends your pick.
  app.post("/api/whatsapp/suggest", async (c) => {
    if (!d.drafter) return noDrafter(c);
    const { name, text, isGroup } = z.object({ name: z.string().min(1).max(200), text: z.string().min(1).max(4000), isGroup: z.boolean().default(false) }).parse(await c.req.json());
    try {
      return c.json(await d.drafter.suggest(name, text, isGroup));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  });
  app.post("/api/whatsapp/drafts/:id/:status{sent|dismissed}", (c) =>
    d.drafter ? c.json({ ok: d.drafter.close(c.req.param("id"), c.req.param("status") as "sent" | "dismissed") }) : noDrafter(c),
  );
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
  // The AI_Assistant brain's alerts: it decides what is worth interrupting you for and when
  // (quiet hours, snooze); the hub puts it on the phone and lists it on Home until you answer.
  app.post("/api/notify", async (c) => {
    const a = NotifyBody.parse(await c.req.json());
    d.assistant?.remember(a);
    const sent = (await d.notifier?.notify(alertPayload(a))) ?? 0;
    return c.json({ ok: true, sent });
  });
  app.post("/api/alerts/:id/ack", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ error: "bad alert id" }, 400);
    const { action } = AckBody.parse(await c.req.json());
    if (!d.assistant) return c.json({ error: "the brain is not connected (BRAIN_TOKEN)" }, 409);
    try {
      await d.assistant.ack(id, action);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
    return c.json({ ok: true });
  });
  // Calls: the phone rings for a level-4 alert (or when you ask to talk one through), speaks what
  // the hub says and sends back what you answer. Only safe actions; see src/calls/desk.ts.
  const callAlert = (c: Context) => {
    const id = Number(c.req.param("alertId"));
    if (!Number.isInteger(id)) return { error: c.json({ error: "bad alert id" }, 400) };
    if (!d.calls) return { error: c.json({ error: "calls are off on this hub" }, 404) };
    if (!d.assistant) return { error: c.json({ error: "the brain is not connected (BRAIN_TOKEN)" }, 409) };
    const alert = d.assistant.alerts().find((a) => a.id === id);
    if (!alert) return { error: c.json({ error: "this alert is no longer open" }, 404) };
    return { alert, calls: d.calls };
  };
  const callFailed = (c: Context, e: unknown) => {
    if (e instanceof CallError) return c.json({ error: e.message, ...(e.status === 409 ? { fallback: "text" } : {}) }, e.status);
    throw e;
  };
  app.get("/api/calls/:alertId", (c) => {
    const r = callAlert(c);
    if (r.error) return r.error;
    const st = r.calls.state(r.alert.id);
    return c.json({ alert: r.alert, voice: r.calls.voice, available: r.calls.available, lines: st?.lines ?? [], ended: st?.ended ?? false });
  });
  app.post("/api/calls/:alertId/answer", async (c) => {
    const r = callAlert(c);
    if (r.error) return r.error;
    return c.json({ ...(await r.calls.answer(r.alert)), voice: r.calls.voice });
  });
  app.post("/api/calls/:alertId/turn", async (c) => {
    const r = callAlert(c);
    if (r.error) return r.error;
    let input: { text?: string; audio?: { data: Blob; filename: string } };
    if ((c.req.header("content-type") ?? "").startsWith("multipart/form-data")) {
      const form = await c.req.parseBody();
      const file = form.audio;
      if (file instanceof File) {
        if (file.size > MAX_CLIP) return c.json({ error: "that voice clip is too long" }, 413);
        input = { audio: { data: file, filename: file.name || `clip.${CLIP_EXT[file.type] ?? "m4a"}` } };
      } else input = { text: typeof form.text === "string" ? form.text : undefined };
    } else {
      const b = TurnBody.parse(await c.req.json());
      if (b.audio) {
        const bytes = Buffer.from(b.audio, "base64");
        if (bytes.length > MAX_CLIP) return c.json({ error: "that voice clip is too long" }, 413);
        const mime = b.mime ?? "audio/mp4";
        input = { audio: { data: new Blob([bytes], { type: mime }), filename: `clip.${CLIP_EXT[mime] ?? "m4a"}` } };
      } else input = { text: b.text };
    }
    if (!input.audio && !input.text?.trim()) return c.json({ error: "say or type something" }, 400);
    try {
      return c.json(await r.calls.turn(r.alert, input));
    } catch (e) {
      return callFailed(c, e);
    }
  });
  // ---- talking to Jarvis (any time, not about one alert): voice or text -> the brain's thinking loop
  // -> the full answer for the screen and `say` for the phone to speak (src/voice/talk.ts).
  app.post("/api/assistant/voice", async (c) => {
    let text = "";
    let audio: { data: Blob; filename: string } | undefined;
    let history: Ask["history"] = [];
    if ((c.req.header("content-type") ?? "").startsWith("multipart/form-data")) {
      const form = await c.req.parseBody();
      const file = form.audio;
      if (file instanceof File) {
        if (file.size > MAX_CLIP) return c.json({ error: "that voice clip is too long" }, 413);
        audio = { data: file, filename: file.name || `clip.${CLIP_EXT[file.type] ?? "m4a"}` };
      }
      if (typeof form.text === "string") text = form.text;
      if (typeof form.history === "string") history = AskBody.shape.history.parse(JSON.parse(form.history));
    } else {
      const b = TurnBody.extend({ history: AskBody.shape.history }).parse(await c.req.json());
      text = b.text ?? "";
      history = b.history;
      if (b.audio) {
        const bytes = Buffer.from(b.audio, "base64");
        if (bytes.length > MAX_CLIP) return c.json({ error: "that voice clip is too long" }, 413);
        const mime = b.mime ?? "audio/mp4";
        audio = { data: new Blob([bytes], { type: mime }), filename: `clip.${CLIP_EXT[mime] ?? "m4a"}` };
      }
    }
    if (audio) {
      if (!d.calls) return c.json({ error: "this hub can't hear voice clips; use the phone's speech recognition or type" }, 409);
      try {
        text = await d.calls.hear(audio);
      } catch (e) {
        return callFailed(c, e);
      }
    }
    text = text.trim();
    if (!text) return c.json({ heard: "", answer: "", say: "Sorry, I didn't catch that. Could you say it again?", steps: [], pending: [] } satisfies TalkReply);
    const r = await askBrain(d, { text, source: "voice", history });
    let reply: AskReply;
    try {
      reply = JSON.parse(r.body);
    } catch {
      return c.json({ error: "the brain answered something unreadable" }, 502);
    }
    if (r.status >= 400) return c.json({ ...reply, heard: text }, r.status as 404 | 502);
    return c.json({ ...reply, heard: text, say: sayFor(reply) } satisfies TalkReply);
  });
  // ---- Jarvis's voice: a line in, audio out (src/voice/tts.ts). 409 {fallback: "phone"} = use the phone's TTS.
  // GET /api/tts/audio?text=… exists so the app's audio player can stream it straight from a URL.
  const TtsBody = z.object({ text: z.string().min(1).max(4000), provider: z.enum(TTS_PROVIDERS).optional(), voice: z.string().max(60).optional(), format: z.enum(["mp3", "wav"]).optional() });
  const speakNow = async (c: Context, body: unknown) => {
    const parsed = TtsBody.safeParse(body);
    if (!parsed.success) return c.json({ error: "send {text, provider?, voice?}" }, 400);
    if (!d.tts) return c.json({ error: "this hub has no speech service; the phone speaks instead", fallback: "phone" }, 409);
    try {
      const s = await d.tts.speak(parsed.data.text, parsed.data);
      return c.body(s.audio.slice().buffer as ArrayBuffer, 200, { "Content-Type": s.mime, "Cache-Control": "private, max-age=3600", "X-Tts-Provider": s.provider, "X-Tts-Voice": s.voice });
    } catch (e) {
      const status = e instanceof TtsError ? e.status : 502;
      return c.json({ error: (e as Error).message, fallback: "phone" }, status === 400 ? 400 : status === 409 ? 409 : status === 503 ? 503 : 502);
    }
  };
  app.get("/api/tts", (c) => c.json(d.tts?.status() ?? { enabled: false, default: null, providers: [] }));
  app.post("/api/tts", async (c) => speakNow(c, await c.req.json().catch(() => ({}))));
  app.get("/api/tts/audio", (c) => speakNow(c, { text: c.req.query("text") ?? "", provider: c.req.query("provider") || undefined, voice: c.req.query("voice") || undefined, format: c.req.query("format") || undefined }));
  app.post("/api/calls/:alertId/end", (c) => {
    const id = Number(c.req.param("alertId"));
    if (!Number.isInteger(id)) return c.json({ error: "bad alert id" }, 400);
    d.calls?.end(id);
    return c.json({ ok: true });
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
      d.store.recordUsage(body.provider, d.cluster.name, result.ok, result.durationMs, result.usage?.costUsd);
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
    const ids = ["orchestrator", "orchestrator-plan", "auto", "raw:auto", ...PROVIDER_IDS.map((p) => `raw:${p}`), ...PROVIDER_IDS, ...[...d.orchestrator.agents.keys()].map((a) => `agent:${a}`)];
    return c.json({ object: "list", data: ids.map((id) => ({ id, object: "model", created: 0, owned_by: "orchestrator" })) });
  });
  app.post("/v1/chat/completions", async (c) => {
    const body = ChatBody.parse(await c.req.json());
    const { system, prompt } = messagesToPrompt(body.messages);
    // "raw:<provider>": one plain call to your logged-in session (codex = ChatGPT), no run, no plan,
    // no notification or memory entry. The AI_Assistant brain thinks through this (PLANNER_BASE_URL=hub).
    // "raw:auto": the same plain call, but the model router (R2) picks the session and falls back
    // through the others when it fails or is cooling (job "brain", sized by the prompt).
    if (body.model === "raw:auto" && d.models) {
      try {
        const r = await d.models.run("brain", { system, prompt, plain: true, timeoutMs: 240_000 }, { size: sizeOf(`${system ?? ""}${prompt}`) });
        return c.json({
          id: `chatcmpl-raw-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: `raw:${r.provider}`,
          choices: [{ index: 0, message: { role: "assistant", content: r.text }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      } catch (e) {
        const limited = e instanceof RouteError && (e.rateLimited || !e.route.chain.length);
        return c.json({ error: { message: (e as Error).message, type: limited ? "rate_limit" : "provider_error" } }, limited ? 429 : 502);
      }
    }
    const raw = body.model.startsWith("raw:") ? Provider.safeParse(body.model.slice(4)) : undefined;
    if (raw) {
      if (!raw.success) return c.json({ error: { message: `unknown provider in ${body.model}`, type: "invalid_request_error" } }, 400);
      const r = await d.pool.run(raw.data, { system, prompt, permission: "read", plain: true, timeoutMs: 240_000 });
      d.store.recordUsage(raw.data, d.cluster.name, r.ok, r.durationMs, r.usage?.costUsd);
      if (!r.ok) return c.json({ error: { message: r.error ?? "failed", type: r.rateLimited ? "rate_limit" : "provider_error" } }, r.rateLimited ? 429 : 502);
      return c.json({
        id: `chatcmpl-raw-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: r.text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
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
