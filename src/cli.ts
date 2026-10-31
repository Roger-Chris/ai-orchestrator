#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { loadAgents } from "./agents/loader.js";
import { buildCapabilities } from "./brain/capabilities.js";
import { Orchestrator } from "./brain/orchestrator.js";
import { describeSetup } from "./brain/setup.js";
import { Router } from "./brain/router.js";
import { Cluster } from "./cluster/cluster.js";
import { workspaceMap } from "./context/graphify.js";
import { AssistantTasks } from "./integrations/assistant.js";
import { GmailReader, SEND_SCOPES } from "./integrations/gmail.js";
import { MailDesk } from "./mail/desk.js";
import { profileDir, STORE_IDS, STORES, type StoreId } from "./shop/agent.js";
import { ShopDesk } from "./shop/desk.js";
import { Memory } from "./memory/memory.js";
import { openReplica } from "./shared/setup.js";
import { buildActions } from "./actions/setup.js";
import { personKnowledge } from "./whatsapp/knowledge.js";
import { tailnetDevices, tailscaleIPv4 } from "./cluster/tailscale.js";
import { type Config, loadConfig } from "./config.js";
import { probeVersion } from "./providers/base.js";
import { ProviderPool } from "./providers/registry.js";
import { createApp } from "./server/app.js";
import { Fcm } from "./server/fcm.js";
import { localDay } from "./server/home.js";
import { Notifier } from "./server/push.js";
import { Store } from "./store/db.js";
import type { Permission, ProviderId, RunEvent, RunMode } from "./types.js";
import { learnStyle, type StyleBook } from "./whatsapp/learn.js";
import { buildPool, poolPrompt } from "./whatsapp/pool.js";
import { describe, peopleGraph, readGraphFiles } from "./whatsapp/graph.js";
import { spawn, spawnSync } from "node:child_process";
import { WhatsAppLink } from "./whatsapp/link.js";
import { describeImages, ollamaProblem, transcribe } from "./whatsapp/local.js";
import { readMediaOnline } from "./whatsapp/online.js";
import { WaStore, type WaMessage } from "./whatsapp/store.js";
import { ReplyDrafter, replyOptions } from "./whatsapp/drafter.js";
import { CallDesk } from "./calls/desk.js";
import { GroqVoice } from "./calls/groq.js";
import { ttsFromConfig } from "./voice/tts.js";
import { WakeListener, wakeOptions } from "./voice/wake.js";
import { ToolRegistry } from "./ai/tools.js";
import { ModelRouter } from "./ai/route.js";
import { BuildDesk } from "./builds/desk.js";
import { createRepo } from "./builds/repo.js";
import { keepRepo, loadRepos } from "./repos/actions.js";
import { projectsDir } from "./actions/registry.js";
import { AGENTIC } from "./brain/capabilities.js";
import { ConvoDesk, NoWhisperDevice } from "./convos/desk.js";
import { whisperFile } from "./convos/whisper.js";
import { FileClient } from "./files/client.js";
import { PhoneDesk } from "./phone/desk.js";
import { WorkDesk } from "./work/desk.js";
import { OutsideAgents } from "./outside/agents.js";
import { FileIndex } from "./files/index.js";
import { PreviewMaker } from "./builds/preview.js";
import { previewer } from "./server/builds.js";
import { preferredFor } from "./server/ai-hub.js";
import { addTerms } from "./whatsapp/address.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function buildSystem(config: Config) {
  const store = new Store(resolve(config.dataDir));
  const pool = new ProviderPool(config, store);
  const cluster = new Cluster(config, pool);
  const router = new Router(buildCapabilities(config.routing.overrides), { localBias: config.cluster.localBias, learn: config.brain.learnFromFeedback }, store);
  const agents = loadAgents([resolve(ROOT, "agents"), resolve(process.cwd(), "agents")]);
  const replica = openReplica(config);
  const memory = new Memory(config, store, undefined, replica);
  const notifier = new Notifier(store, resolve(config.dataDir), undefined, loadFcm(config));
  const orchestrator = new Orchestrator(config, store, cluster, router, agents, {
    memory,
    workspace: (cwd) => workspaceMap(cwd, config),
    onAttention: notifier.attention,
    // Built fresh for every step, so agents see the setup as it is right now.
    setup: () => setup(),
  });
  /** The live owner/setup briefing: for every step, and for calls. */
  const setup = () =>
    describeSetup({
      profile: config.profile,
      cluster,
      pool,
      store,
      active: () => orchestrator.active(),
      services: () => {
        const brain = assistant?.status();
        const mail = gmail.status();
        // One plain line per source of truth, so a model can't read "reader off" as "no Gmail tasks".
        const gmailLine = mail.connected
          ? `Gmail: read by the hub as ${mail.email}; its tasks are in today's tasks above`
          : brain?.ok
            ? "Gmail: read by their AI_Assistant brain, which turns emails into tasks; those are in today's tasks above"
            : assistant
              ? `Gmail: their AI_Assistant brain reads it, but the hub can't reach the brain right now${brain?.lastError ? ` (${brain.lastError})` : ""}, so today's tasks may be out of date`
              : "Gmail: not connected";
        const book = drafter.book();
        const waLine = book
          ? `WhatsApp: replies are drafted in their style (style book of ${book.contacts.length} chats) and shown on the phone; nothing is ever sent for them`
          : "WhatsApp: not connected";
        return [gmailLine, `Phone notifications: ${notifier.fcm ? "on (Android app via Firebase)" : "web push only"}`, waLine];
      },
    });
  // The tool registry (R1) and the model router (R2) choose which AI does the hub's own jobs.
  const tts = ttsFromConfig(config, undefined, (p, ok, ms) => store.recordUsage(`tts:${p}`, config.node.name, ok, ms));
  const tools = new ToolRegistry({ config, pool, capabilities: buildCapabilities(config.routing.overrides), usage: () => store.usage(1), tts, borrow: (id) => cluster.borrowFor(id) });
  // Daily call and spend caps (tools.overrides perDay / spendPerDay) are enforced for every run and every spoken line.
  pool.capped = (id) => tools.capped(id);
  tts.capped = (id) => tools.capped(`tts:${id}`);
  const models = new ModelRouter({ tools: () => tools.list(), pool, store, node: config.node.name, routes: config.tools.routes, preferred: preferredFor(store), cluster });
  const gmail = new GmailReader(store, pool, {
    clientFile: resolve(config.gmail.clientFile),
    dataDir: resolve(config.dataDir),
    query: config.gmail.query,
    provider: config.gmail.provider,
    node: config.node.name,
    router: models,
  });
  const assistant = config.assistant.token
    ? new AssistantTasks(store, { url: config.assistant.url, token: config.assistant.token, pollMinutes: config.assistant.pollMinutes })
    : undefined;
  addTerms(config.style.addressTerms);
  const drafter = new ReplyDrafter(
    store,
    new WaStore(store),
    pool,
    {
      dataDir: resolve(config.dataDir),
      delaySeconds: config.whatsapp.draftDelaySeconds,
      auto: config.whatsapp.autoDraft,
      groups: config.whatsapp.draftGroups,
      provider: config.whatsapp.replyProvider,
      node: config.node.name,
      // who they are, facts and open tasks with them, from the shared memory
      knowledge: replica ? (who) => personKnowledge(replica, who) : undefined,
      router: models,
    },
    (p) => void notifier.notify(p),
  );
  const groq = config.providers.groq;
  const calls = new CallDesk({
    voice: new GroqVoice({
      baseUrl: groq.baseUrl,
      keys: [...groq.apiKeys, groq.apiKey ?? ""],
      model: groq.model,
      transcribeModel: groq.transcribeModel,
      onTranscribe: (ok, ms) => store.recordUsage("whisper:groq", config.node.name, ok, ms),
    }),
    // Typed answers on a call: the router's "call" order (Claude, ChatGPT, Gemini, then Groq), skipping what is cooling.
    think: async (system, prompt) => (await models.run("call", { system, prompt, timeoutMs: 60_000 })).text,
    ack: async (id, action) => {
      if (!assistant) throw new Error("the brain is not connected (BRAIN_TOKEN)");
      await assistant.ack(id, action);
    },
    // Read-only: a call can have things researched or drafted, never sent or changed.
    start: (task) => orchestrator.submit(task, { permission: "read" }).id,
    setup,
    task: (taskId) => store.tasksFor(localDay()).find((t) => t.id === `brain:${taskId}`),
  });
  // D2: the hub (no sharedMemory.hub) keeps every device's file list; the others send theirs to it.
  const fileIndex = config.sharedMemory.hub ? undefined : new FileIndex(store.db);
  const files = new FileClient({ config, index: fileIndex, replica, peers: () => cluster.list() });
  const actions = buildActions(config, {
    store,
    pool,
    replica,
    cluster,
    notifier,
    extra: { files: { search: (q, o) => files.search(q, o), reindex: () => files.reindex() }, sendFile: (n, p, b) => files.sendFile(n, p, b) },
  });
  // Phase 2: apps built on command; a ready build gets a preview on this hub.
  let preview: ReturnType<typeof previewer> | undefined;
  const builds = new BuildDesk({
    store,
    runner: orchestrator,
    replica,
    notify: (p) => void notifier.notify(p),
    onReady: (b) => void (config.builds.autoPreview ? preview?.(b) : undefined),
    node: config.node.name,
    projectsDir: projectsDir(config),
    guidelines: () => {
      try {
        return readFileSync(resolve(ROOT, config.builds.guidelines), "utf8");
      } catch {
        return "";
      }
    },
    createRepo: async (name, spec) => {
      const dir = await createRepo(name, spec, { dir: projectsDir(config), remote: config.branches.remote });
      keepRepo({ config }, basename(dir), dir);
      return dir;
    },
    isOwned: (folder) => loadRepos({ config }).some((r) => resolve(r.dir) === folder),
    pickAgents: async () => {
      const [agent, reviewer] = (await models.routeFor("coding", "large")).chain.filter((id) => AGENTIC[id]);
      return { agent, reviewer };
    },
    // Decks, videos and Android work go to the device built for it (the laptop), never to the small hub by choice.
    pickNode: (kind, spec) => {
      const heavy = kind !== "app" || /\b(android|apk|mobile app|expo|react native|flutter)\b/i.test(spec);
      const node = config.builds.androidNode;
      return heavy && node && (node === config.node.name || cluster.isOnline(node)) ? node : undefined;
    },
    direct: config.providers.manus.free && config.providers.manus.apiKey ? (prompt) => pool.run("manus", { prompt, permission: "read" }) : undefined,
  });
  // Recorded conversations: Whisper runs on the laptop; while it is off, recordings wait.
  const whisper = { here: config.convos.whisperHere, dataDir: resolve(config.dataDir), run: (file: string) => whisperFile(file, config.style, ROOT) };
  const convos = new ConvoDesk({
    store,
    dataDir: resolve(config.dataDir),
    replica,
    owner: config.profile.name || process.env.OWNER_NAME || undefined,
    notify: (p) => void notifier.notify(p),
    transcribe: async (file) => {
      if (whisper.here) return whisper.run(file);
      const r = await cluster.transcribe(file);
      if (!r) throw new NoWhisperDevice("Waiting for the laptop to come online to transcribe this.");
      return r;
    },
    think: async (prompt) => (await models.run("convo", { prompt })).text,
    // Unconfirmed: the words may be someone else's, so these wait for your Keep on the Tasks screen.
    addTask: config.assistant.token
      ? async (t) => {
          const res = await fetch(`${config.assistant.url.replace(/\/$/, "")}/tasks`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.assistant.token}` },
            body: JSON.stringify({ title: t.title, details: t.details, due_at: t.dueAt, unconfirmed: true }),
          });
          if (!res.ok) throw new Error(`the brain answered ${res.status} for a task`);
        }
      : undefined,
  });
  setInterval(() => void convos.pump(), config.convos.retrySeconds * 1000).unref();
  // Android APKs are built on the device with the Android SDK (builds.androidNode, the laptop) when it isn't this one.
  const androidNode = config.builds.androidNode && config.builds.androidNode !== config.node.name ? config.builds.androidNode : "";
  preview = previewer(
    builds,
    new PreviewMaker({
      dataDir: resolve(config.dataDir),
      remote: config.branches.remote,
      timeoutMs: config.builds.previewTimeoutMinutes * 60_000,
      android: androidNode
        ? { node: androidNode, build: (req) => cluster.buildApk(androidNode, { ...req, timeoutMs: config.builds.apkTimeoutMinutes * 60_000 }, resolve(config.dataDir, "previews-apk", `${req.id}.apk`)) }
        : undefined,
    }),
  );
  // Work: people you give tasks to; a live WhatsApp message with them can move a task on (src/work/desk.ts).
  const work = new WorkDesk({
    store,
    wa: new WaStore(store),
    think: (kind, req) => models.run(kind, req),
    notify: (title, body) => void notifier.notify({ title, body, url: "/work", tag: `work:${title}` }),
  });
  // Mail: its own sign-in that may send (`orc gmail connect-send`), never polled, so nothing is read twice.
  const mailSender = new GmailReader(store, pool, { clientFile: resolve(config.gmail.clientFile), dataDir: resolve(config.dataDir), query: "", provider: "auto", node: config.node.name, tokenName: "gmail-send-token.json", scopes: SEND_SCOPES });
  const mail = new MailDesk({
    store,
    gmail: mailSender,
    think: async (prompt) => (await models.run("mail_write", { prompt, timeoutMs: 120_000 })).text,
    voice: () => drafter.book()?.owner.voice?.summary,
    knowledge: replica ? (name) => personKnowledge(replica, { name, chatId: "", isGroup: false }).join("\n") || undefined : undefined,
    log: actions.log,
    notify: (p) => void notifier.notify(p),
    node: config.node.name,
  });
  // Shopping: the browser agent runs on the device set for it, normally the laptop.
  const shop = new ShopDesk({
    store,
    act: (node, req, who) => actions.act(node, req, { who }),
    log: actions.log,
    notify: (p) => void notifier.notify(p),
    node: config.shopping.node || config.builds.androidNode || undefined,
    logNode: config.node.name,
    linkOnly: config.shopping.linkOnly,
    findIn: config.shopping.findIn,
  });
  return { store, pool, cluster, router, orchestrator, agents, memory, replica, actions, notifier, gmail, mail, mailSender, shop, assistant, drafter, calls, tts, tools, models, builds, preview, convos, whisper, fileIndex, files, phone: new PhoneDesk(store, config, (p) => void notifier.notify(p)), outside: new OutsideAgents(store, replica), work };
}

/** The Android app's notifications, when a Firebase service-account key is set up. */
function loadFcm(config: Config): Fcm | undefined {
  const file = resolve(config.server.fcmServiceAccount ?? process.env.FCM_SERVICE_ACCOUNT ?? "fcm-service-account.json");
  if (!existsSync(file)) return undefined;
  try {
    return new Fcm(file);
  } catch (e) {
    console.warn(`! Android notifications are off: ${(e as Error).message}`);
    return undefined;
  }
}

async function bindHosts(config: Config): Promise<string[]> {
  const h = config.server.host;
  if (h === "tailscale") {
    const ip = await tailscaleIPv4();
    if (!ip) console.warn("! server.host is 'tailscale' but Tailscale is not connected; serving on loopback only.");
    return ip ? ["127.0.0.1", ip] : ["127.0.0.1"];
  }
  const host = h === "auto" ? (config.server.token ? "0.0.0.0" : "127.0.0.1") : h;
  if (host !== "127.0.0.1" && host !== "localhost" && !config.server.token) {
    console.warn("! Refusing to expose the server without server.token (run `orc init`). Serving on loopback only.");
    return ["127.0.0.1"];
  }
  return [host];
}

async function cmdServe(config: Config) {
  const sys = buildSystem(config);
  sys.store.failStaleRuns();
  const web = resolve(ROOT, "web", "dist");
  if (!existsSync(join(web, "index.html"))) console.warn("! The app is not built yet: run `npm run build:web` (npm start does it for you).");
  const app = createApp({ ...sys, config, publicDir: relative(process.cwd(), web) || "." });
  const hosts = await bindHosts(config);
  for (const hostname of hosts) serve({ fetch: app.fetch, port: config.server.port, hostname });
  sys.cluster.start();
  sys.gmail.start(config.gmail.pollMinutes);
  sys.assistant?.start();
  sys.replica?.start(config.sharedMemory.pollSeconds);
  if (config.actions.enabled) sys.files.start();
  // "Hey Jarvis" on this computer's microphone, when turned on for this device.
  if (config.wake.enabled) void new WakeListener(wakeOptions(config, ROOT)).start().then((code) => console.warn(`! the wake word listener stopped (exit ${code}); run \`orc wake\` to see why`));

  const status = await sys.pool.status();
  console.log(`\n  AI Orchestrator · device "${config.node.name}"`);
  for (const host of hosts) console.log(`  → http://${host === "0.0.0.0" ? "localhost" : host}:${config.server.port}`);
  console.log(`  → OpenAI-compatible: http://localhost:${config.server.port}/v1  (model: orchestrator | auto | claude | codex | gemini | perplexity | groq | agent:<name>)\n`);
  for (const s of status) console.log(`  ${s.installed && s.authenticated ? "✓" : "✗"} ${s.id.padEnd(10)} ${s.version ?? ""} ${s.detail ?? ""}`);
  console.log(`  ${sys.agents.size} agents loaded · cluster ${config.cluster.enabled ? `on (tailscale discovery ${config.cluster.tailscale ? "on" : "off"})` : "off"}\n`);
}

function printEvent(ev: RunEvent, verbose: boolean) {
  const d = ev.data as any;
  const tag = ev.stepId ? `[${ev.stepId}] ` : "";
  switch (ev.type) {
    case "run.classified":
      console.error(`· classified: ${d.kind} (${d.complexity})${d.alsoKinds.length ? ` + ${d.alsoKinds.join(", ")}` : ""}`);
      break;
    case "plan.created":
      console.error(`· plan: ${d.steps.length} step(s)`);
      for (const s of d.steps) console.error(`   ${s.id} ${s.agent ?? s.kind}: ${s.title}${s.dependsOn.length ? ` ← ${s.dependsOn.join(", ")}` : ""}`);
      break;
    case "step.started":
      console.error(`▶ ${tag}${d.title}`);
      break;
    case "step.progress":
      console.error(`  ${tag}${d.note}`);
      break;
    case "step.delta":
      if (verbose) process.stderr.write(d.text);
      break;
    case "step.completed":
      console.error(`✓ ${tag}${d.provider} @ ${d.node} in ${(d.durationMs / 1000).toFixed(1)}s`);
      break;
    case "step.failed":
      console.error(`✗ ${tag}${d.error}`);
      break;
    case "step.fallback":
      console.error(`↻ ${tag}falling back to ${d.to} @ ${d.node}`);
      break;
    case "design.approved":
      console.error(`· design approved${d.savedTo ? `, saved to ${d.savedTo}` : ""}; planning the build`);
      break;
    case "design.revising":
      console.error("· sending the design back for revision");
      break;
  }
}

/** Shows the draft and the goldfish reviews, then asks you to approve, revise or cancel. */
async function askDesign(orc: Orchestrator, id: string) {
  const run = orc.get(id)!;
  const d = run.design!;
  const step = (sid: string) => run.steps.find((s) => s.id === sid);
  console.log(`\n===== DESIGN (round ${d.round}) =====\n\n${step(d.draftStepId)?.output ?? ""}`);
  for (const sid of d.reviewStepIds) {
    const s = step(sid);
    console.log(`\n===== GOLDFISH REVIEW · ${s?.provider ?? "?"} =====\n\n${s?.output ?? `review failed: ${s?.error}`}`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
  const answer = (await ask("\n[a]pprove and build, [r]evise, [c]ancel? ")).trim().toLowerCase();
  if (answer.startsWith("a")) {
    const notes = (await ask("Which findings to address, or other notes (Enter for none): ")).trim();
    orc.decide(id, { action: "approve", notes: notes || undefined });
  } else if (answer.startsWith("r")) {
    const feedback = (await ask("What should change? ")).trim();
    orc.decide(id, { action: "revise", feedback: feedback || "Address the review findings you agree with." });
  } else orc.cancel(id);
  rl.close();
}

async function cmdRun(config: Config, task: string, v: Record<string, unknown>) {
  if (!task) throw new Error('usage: orc run "<task>" [--mode auto|direct|plan|design] [--provider p] [--agent name] [--cwd dir] [--permission read|edit|full] [--branches]');
  const sys = buildSystem(config);
  if (config.cluster.enabled) await sys.cluster.refresh();
  const run = sys.orchestrator.submit(task, {
    mode: v.mode as RunMode | undefined,
    provider: v.provider as ProviderId | undefined,
    agent: v.agent as string | undefined,
    cwd: v.cwd as string | undefined,
    permission: v.permission as Permission | undefined,
    branches: !!v.branches,
  });
  sys.orchestrator.subscribe(run.id, (ev) => {
    printEvent(ev, !!v.verbose);
    if (ev.type === "design.review_ready") void askDesign(sys.orchestrator, run.id);
  });
  const done = await sys.orchestrator.wait(run.id)!;
  if (done.status === "done") console.log(`\n${done.result}`);
  else console.error(`\nrun ${done.status}: ${done.error}`);
  sys.store.close();
  process.exitCode = done.status === "done" ? 0 : 1;
}

async function cmdDoctor(config: Config, live: boolean) {
  const sys = buildSystem(config);
  for (const s of await sys.pool.status(true)) {
    console.log(`${s.installed && s.authenticated ? "✓" : "✗"} ${s.id.padEnd(10)} ${s.command ?? ""} ${s.version ?? ""}`);
    if (s.detail) console.log(`    ${s.detail}`);
    if (live && s.installed && s.authenticated) {
      const r = await sys.pool.run(s.id, { prompt: "Reply with exactly: OK", permission: "read", timeoutMs: 180_000 });
      console.log(`    live test: ${r.ok ? `OK (${(r.durationMs / 1000).toFixed(1)}s${r.model ? `, ${r.model}` : ""})` : `FAILED: ${r.error?.slice(0, 300)}`}`);
    }
  }
  const devices = await tailnetDevices();
  console.log(devices.length ? `\nTailscale: ${devices.length} device(s) on your tailnet` : "\nTailscale: not running or logged out (multi-device discovery disabled)");
  for (const d of devices) console.log(`  ${d.self ? "*" : " "} ${d.hostName.padEnd(20)} ${d.ips[0] ?? ""} ${d.online ? "online" : "offline"} ${d.os ?? ""}`);
  console.log(`· branches   this device ${config.node.acceptBranchWork ? "takes" : "does not take"} coding steps on git branches from other devices (node.acceptBranchWork)`);
  const graphify = await probeVersion(config.context.graphifyCommand);
  console.log(`\n${graphify ? "✓" : "✗"} graphify   ${graphify ?? "not installed (optional: uv tool install graphifyy). Gives the planner a code map."}`);
  console.log(`· android    notifications ${sys.notifier.fcm ? "on (Firebase key loaded)" : "off (no fcm-service-account.json)"}`);
  if (sys.assistant) {
    const n = await sys.assistant.sync().catch(() => undefined);
    console.log(`· brain      ${n === undefined ? `not reachable: ${sys.assistant.status().lastError}` : `${config.assistant.url}, ${n} task(s) on today's list`}`);
  } else console.log("· brain      off (set BRAIN_TOKEN in .env to show the AI_Assistant brain's tasks on Today)");
  const mail = sys.gmail.status();
  console.log(`· gmail      ${mail.connected ? `connected as ${mail.email}` : mail.configured ? "not connected (run `orc gmail connect`)" : `off (no ${config.gmail.clientFile}; see Gmail in the README)`}`);
  console.log(`· memory     local${config.memory.enabled ? "" : " (disabled)"} · NotebookLM: ${await sys.memory.notebookStatus()}`);
  if (!live) console.log("\nRun `orc doctor --live` to send a tiny test prompt to each logged-in model.");
  sys.store.close();
}

/** Opens the cart agent's own browser profile at a store, so the owner can sign in there by hand. */
function cmdShop(config: Config, sub = "", store = "") {
  if (sub !== "login" || !STORE_IDS.includes(store as StoreId)) {
    console.log(`usage: orc shop login <${STORE_IDS.join("|")}>`);
    return;
  }
  const chrome = process.platform === "win32" ? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe` : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome";
  spawn(chrome, [`--user-data-dir=${profileDir(resolve(config.dataDir))}`, STORES[store as StoreId].home], { detached: true, stdio: "ignore" }).unref();
  console.log(`Sign in to ${STORES[store as StoreId].name} in the window that opened, then close it. Jarvis never sees your password; it only reuses the sign-in.`);
}

/** Connect, check, inspect or disconnect the Gmail reader. */
async function cmdGmail(config: Config, sub = "status") {
  const sys = buildSystem(config);
  try {
    if (sub === "connect-send") {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const pasted = new Promise<string>((r) => rl.once("line", r));
      try {
        const email = await sys.mailSender.connect({ print: (s) => console.log(s), pasted });
        console.log(`\n✓ Jarvis can send as ${email}, and only after your Send on the phone.`);
      } finally {
        rl.close();
      }
      return;
    }
    if (sub === "connect") {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const pasted = new Promise<string>((r) => rl.once("line", r));
      try {
        const email = await sys.gmail.connect({ print: (s) => console.log(s), pasted });
        console.log(`\n✓ Gmail connected as ${email}. Checking your mail now…`);
      } finally {
        rl.close();
      }
      sub = "check";
    }
    if (sub === "check") {
      const r = await sys.gmail.check();
      console.log(`Read ${r.scanned} new email(s), added ${r.added} task(s).`);
      for (const t of sys.store.tasksFor(localDay()).filter((t) => t.source === "gmail")) console.log(`  ${(t.time ?? "today").padEnd(10)} ${t.title}${t.detail ? `  (${t.detail})` : ""}`);
    } else if (sub === "disconnect") {
      await sys.gmail.disconnect();
      console.log("Gmail disconnected and access revoked.");
    } else {
      const s = sys.gmail.status();
      console.log(s.connected ? `Connected as ${s.email}.` : s.configured ? "Not connected: run `orc gmail connect`." : `No OAuth client at ${config.gmail.clientFile}: see Gmail in the README.`);
    }
  } finally {
    sys.store.close();
  }
}

/** Links WhatsApp (read-only) and keeps it running so history, new messages and voice notes are saved. */
async function cmdWhatsApp(config: Config, sub = "status") {
  const store = new Store(resolve(config.dataDir));
  const wa = new WaStore(store);
  let undecryptableCount = () => 0;
  let linked: WhatsAppLink | undefined;
  const show = () => {
    const n = wa.counts();
    const u = linked?.status().undecrypted;
    const lost = u && u.direct + u.group ? ` · undecryptable: ${u.direct} direct, ${u.group} group, ${u.recovered} recovered by retry (${undecryptableCount()} decrypt errors)` : "";
    console.log(`${n.messages} messages (${n.mine} yours) in ${n.chats} chats · ${n.voice} voice notes, ${n.transcribed} transcribed${lost}`);
  };
  if (sub !== "link") {
    show();
    if (!readCreds(config)) console.log("Not linked yet: run `orc whatsapp link`.");
    return store.close();
  }
  undecryptableCount = quietSignalNoise();
  // Baileys sometimes rejects a retry request after the socket closed ("428 Connection Closed")
  // with nothing awaiting it; Node would exit. The link reconnects on its own, so note and go on.
  process.on("unhandledRejection", (e) => console.warn(`! WhatsApp: ${(e as Error)?.message ?? e} (reconnecting by itself)`));
  const forward = hubForwarder(config);
  console.log(`New messages go to the hub at ${hubUrl(config)} for reply drafts.`);

  // A live voice note or photo waits for this device's Whisper / vision model, so the hub drafts
  // from what was said or shown. If that fails it goes on as "[voice note]" / "[image]" after all.
  const held = new Map<string, WaMessage>();
  let whisper = Promise.resolve();
  const release = (id: string) => {
    const m = held.get(id);
    if (!m) return;
    held.delete(id);
    const transcript = wa.messages(m.chatId, 50).find((x) => x.id === id)?.transcript;
    if (transcript) console.log(`${m.mediaType === "image" ? "photo described" : "voice note transcribed"}: "${transcript.slice(0, 60)}${transcript.length > 60 ? "…" : ""}"`);
    forward.send([{ ...m, transcript }]);
  };
  const groq = config.providers.groq;
  const onlineMedia = {
    voice: new GroqVoice({ baseUrl: groq.baseUrl, keys: [...groq.apiKeys, groq.apiKey ?? ""], model: groq.model, transcribeModel: groq.transcribeModel, onTranscribe: (ok, ms) => store.recordUsage("whisper:groq", config.node.name, ok, ms) }),
    gemini: { apiKey: config.tts.gemini.apiKey, baseUrl: config.tts.gemini.baseUrl, model: config.whatsapp.onlineVisionModel },
  };
  const online = config.whatsapp.media === "online";
  const link: WhatsAppLink = new WhatsAppLink(wa, {
    dataDir: resolve(config.dataDir),
    history: config.whatsapp.history,
    voiceNotes: config.whatsapp.voiceNotes,
    images: config.whatsapp.images,
    historyVoice: !online,
    ignore: config.whatsapp.ignore,
    print: (s) => console.log(s),
    onLive: (ms) => {
      console.log(`new: ${ms.length} message(s)`);
      const media = ms.filter((m) => link.wantsMedia(m) && !m.transcript);
      forward.send(ms.filter((m) => !media.includes(m)));
      for (const m of media) {
        held.set(m.id, m);
        setTimeout(() => release(m.id), 180_000).unref(); // never hold one for ever
      }
    },
    onMedia: (m, ok) => {
      if (!held.has(m.id)) return; // a history note: `orc style learn` transcribes those
      if (!ok) return release(m.id);
      whisper = whisper
        .then(async () => void (online ? await readMediaOnline(wa, m, onlineMedia) : m.mediaType === "image" ? await describeImages(wa, config.style) : await transcribe(wa, config.style, () => {}, ROOT)))
        .then(
          () => {},
          (e) => console.warn(`! ${m.mediaType === "image" ? "photo not described" : "voice note not transcribed"}: ${(e as Error).message}`),
        )
        .then(() => release(m.id));
    },
  });
  await link.start();
  console.log("Keep this running while history arrives (Ctrl+C to stop; run it again any time to catch up).");
  linked = link;
  // The hub needs hidden-id chats' numbers so "Send in WhatsApp" opens the chat, not a share menu.
  const sendPhones = async () => {
    const phones = link.phones();
    if (!Object.keys(phones).length) return;
    for (const base of [hubUrl(config), localHub(config)]) {
      const r = await hubCall(config, "POST", "/api/whatsapp/phones", { phones }, base).catch(() => undefined);
      if (r) return console.log(`${Object.keys(phones).length} hidden-id chats' numbers sent to ${base} (${r.updated} new).`);
    }
  };
  setTimeout(() => void sendPhones(), 20_000).unref();
  setInterval(() => void sendPhones(), 6 * 3600_000).unref();
  const timer = setInterval(show, 60_000);
  process.once("SIGINT", () => {
    clearInterval(timer);
    link.stop();
    show();
    store.close();
    process.exit(0);
  });
}

/** Learns your writing style from the saved chats with the local models; the book goes to data/style/. */
async function cmdStyle(config: Config, sub = "show", opts: { who?: string; ask?: string; draft?: boolean; raw?: boolean } = {}) {
  addTerms(config.style.addressTerms);
  const store = new Store(resolve(config.dataDir));
  const wa = new WaStore(store);
  const file = join(resolve(config.dataDir), "style", "stylebook.json");
  const previous: StyleBook | undefined = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  try {
    if (sub === "push") {
      // The hub drafts from the book plus each chat's recent messages, so both go over.
      if (!previous) throw new Error("No style book yet: run `orc style learn` first.");
      const r = await hubCall(config, "PUT", "/api/style", previous);
      console.log(`Style book sent to ${hubUrl(config)}: ${r.contacts} chats.`);
      const recent = previous.contacts.flatMap((c) => wa.messages(c.chatId, 60).map((m) => ({ ...m, mediaPath: undefined, chatName: c.name.startsWith("+") ? undefined : c.name })));
      let saved = 0;
      for (let i = 0; i < recent.length; i += 2000) saved += (await hubCall(config, "POST", "/api/whatsapp/messages", { messages: recent.slice(i, i + 2000), live: false })).saved;
      console.log(`Sent ${recent.length} recent messages for context (${saved} new on the hub).`);
      const graph = readGraphFiles(resolve(config.dataDir));
      if (Object.keys(graph).length) console.log(`People graph sent: ${(await hubCall(config, "PUT", "/api/style/graph", { files: graph })).saved.join(", ")}.`);
      else console.log("No people graph here yet: `orc style graph` makes one, then push again.");
    } else if (sub === "pull") {
      await pullMessages(config, store, wa);
    } else if (sub === "learn") {
      const problem = await ollamaProblem(config.style);
      if (problem) throw new Error(problem);
      // The link may run on the hub: learn from what it has saved since last time.
      if (config.whatsapp.hub) await pullMessages(config, store, wa).catch((e) => console.warn(`! Learning from what is here: could not pull from the hub (${(e as Error).message})`));
      const t = await transcribe(wa, config.style, (s) => console.log(s), ROOT);
      if (t.done || t.failed) console.log(`Voice notes: ${t.done} transcribed${t.failed ? `, ${t.failed} could not be read` : ""}.`);
      console.log(`Studying your chats with ${config.style.model}…`);
      const book = await learnStyle(
        wa,
        { ...config.style, minMine: config.style.minMessages, maxContacts: config.style.maxContacts, me: readCreds(config)?.me, log: (s) => console.log(s) },
        previous,
      );
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(book, null, 2));
      console.log(`\nStyle book saved to ${file}: ${book.contacts.filter((c) => c.card).length} of ${book.contacts.length} chats described.`);
      if (book.owner.voice) console.log(`\nYour voice: ${book.owner.voice.summary}`);
    } else if (sub === "graph") {
      // orc style graph: every person as a node (what you call them, how often, tone…), drawn by Graphify.
      if (!previous) throw new Error("No style book yet: run `orc style learn` first.");
      const dir = join(resolve(config.dataDir), "style", "graph");
      mkdirSync(join(dir, "graphify-out"), { recursive: true });
      const graph = peopleGraph(previous, (id) => wa.activity(id));
      writeFileSync(join(dir, "graphify-out", "graph.json"), JSON.stringify(graph, null, 1));
      // Graphify's panel shows only the start of a profile, so the whole of each one is also in people.md.
      const people = [...previous.contacts].sort((a, b) => b.stats.mine + b.stats.theirs - (a.stats.mine + a.stats.theirs));
      writeFileSync(
        join(dir, "people.md"),
        [`# Your WhatsApp people (${people.length})`, "", ...people.flatMap((c) => [`## ${c.name}${c.isGroup ? " (group)" : ""}`, "", ...describe(c, wa.activity(c.chatId)).slice(1).map((l) => `- ${l}`), ""])].join("\n"),
      );
      console.log(`${graph.nodes.length} nodes, ${graph.links.length} links → ${join(dir, "graphify-out", "graph.json")}`);
      const r = spawnSync(config.context.graphifyCommand, ["cluster-only", dir, "--no-label"], { stdio: "inherit" }); // no shell: the path has a space
      if (r.status !== 0) throw new Error(`graphify cluster-only failed (${r.error?.message ?? `exit ${r.status}`}); install it with \`uv tool install graphifyy\``);
      console.log(`\nOpen ${join(dir, "graphify-out", "graph.html")} to check every person. Nothing here leaves this machine.`);
    } else if (sub === "pool") {
      // orc style pool <name or number> [--ask "what to say"] [--draft]: the context the next reply is written from.
      if (!previous) throw new Error("No style book yet: run `orc style learn` first.");
      const want = (opts.who ?? "").toLowerCase().trim();
      const digits = want.replace(/\D/g, "");
      const chat = want ? wa.chats().find((c) => (digits.length >= 6 && c.id.split("@")[0].endsWith(digits)) || (c.name ?? "").toLowerCase().includes(want)) : undefined;
      if (!chat) throw new Error(`no chat matches "${opts.who ?? ""}": give part of a name or the number`);
      const pool = buildPool(previous, { chatId: chat.id, name: chat.name, isGroup: chat.isGroup }, wa.messages(chat.id, 200));
      const { system, prompt } = poolPrompt(pool, opts.ask);
      console.log(`=== Context pool for ${pool.name} (${pool.basis}${pool.similar.length ? `; borrows from ${pool.similar.join(", ")}` : ""}) ===\n\n[system]\n${system}\n\n[prompt]\n${prompt}`);
      if (opts.draft) {
        const providers = new ProviderPool(config, store);
        const ready = await providers.available();
        const id = (["claude", "codex", "groq", "gemini"] as ProviderId[]).find((p) => ready.includes(p));
        if (!id) throw new Error("no online model is ready (Claude, Gemini, ChatGPT or Groq)");
        const r = await providers.run(id, { system, prompt, permission: "read", timeoutMs: 180_000 });
        if (!r.ok) throw new Error(`${id} failed: ${r.error}`);
        const options = replyOptions(r.text, pool);
        console.log(`\n=== Options from ${id} (as the phone shows them) ===`);
        for (const o of options) console.log(`[${o.label}] ${o.text}`);
        if (!options.length) console.log(`(none: ${pool.incoming.length ? "the model saw nothing worth answering" : "your message is the last one, so there is nothing to answer; add --ask to write one anyway"})`);
        if (opts.raw) console.log(`\n--- model's own answer ---\n${r.text.trim()}`);
      }
    } else if (!previous) console.log("No style book yet: link WhatsApp (`orc whatsapp link`), then run `orc style learn`.");
    else {
      if (previous.owner.voice) console.log(`Your voice: ${previous.owner.voice.summary}\n`);
      for (const c of previous.contacts.filter((c) => c.card)) console.log(`${c.name.padEnd(24)} ${c.card!.relationship} · ${c.card!.language} · calls them ${c.card!.addressAs.join("/") || "-"}`);
    }
  } finally {
    store.close();
  }
}

/**
 * Baileys' encryption library prints a stack trace for every message it cannot decrypt ("Bad MAC",
 * common for a while after a reconnect as sessions resync). Those lines are counted instead of
 * flooding the terminal; returns the count so far.
 */
function quietSignalNoise(): () => number {
  let n = 0;
  const noisy = (a: unknown) => typeof a === "string" && /^(Failed to decrypt message|Session error:|Closing (open )?session|Decrypted message with closed session)/.test(a);
  for (const level of ["log", "error", "warn", "info"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      if (noisy(args[0])) {
        if (String(args[0]).startsWith("Failed to decrypt")) n++;
        return;
      }
      original(...args);
    };
  }
  return () => n;
}

/**
 * Copies the messages the hub's link saved to this device, in pages. The last 500 are read again
 * each time, because a voice note's transcript can land just after its message.
 */
async function pullMessages(config: Config, store: Store, wa: WaStore) {
  if (!config.whatsapp.hub) throw new Error("whatsapp.hub is not set: this device is the hub");
  let after = Math.max(0, Number(store.getPref("whatsapp.pulled") ?? 0) - 500);
  let added = 0;
  for (;;) {
    const page = (await hubGet(config, `/api/whatsapp/messages?after=${after}&limit=2000`)) as { messages: WaMessage[]; next: number };
    if (!page.messages.length) break;
    added += wa.save(page.messages);
    after = page.next;
    store.setPref("whatsapp.pulled", String(after));
  }
  console.log(`${added} new message(s) from ${hubUrl(config)}.`);
}

/** Where reply drafting happens: `whatsapp.hub`, else the hub on this device. */
const hubUrl = (config: Config) => (config.whatsapp.hub || `http://127.0.0.1:${config.server.port}`).replace(/\/$/, "");

/** The orchestrator on this device: the backup hub when `whatsapp.hub` (the Linux machine) is down. */
const localHub = (config: Config) => `http://127.0.0.1:${config.server.port}`;

async function hubCall(config: Config, method: string, path: string, body: unknown, base = hubUrl(config)): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(config.server.token ? { Authorization: `Bearer ${config.server.token}` } : {}) },
    body: JSON.stringify(body),
  });
  const out = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`hub ${res.status}: ${out.error ?? res.statusText}`);
  return out;
}

async function hubGet(config: Config, path: string): Promise<any> {
  const res = await fetch(`${hubUrl(config)}${path}`, { headers: config.server.token ? { Authorization: `Bearer ${config.server.token}` } : {} });
  const out = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`hub ${res.status}: ${out.error ?? res.statusText}`);
  return out;
}

/**
 * Sends new messages to the hub in order. When it does not answer at all (a power cut on the Linux
 * machine), they go to the orchestrator on this device instead, which drafts from the same style book
 * and which the phone app moves to; when neither answers they wait and are retried.
 */
function hubForwarder(config: Config) {
  const queue: WaMessage[] = [];
  let busy = false;
  let warned = false;
  const send = async (batch: unknown[]) => {
    const body = { messages: batch, live: true };
    try {
      await hubCall(config, "POST", "/api/whatsapp/messages", body);
    } catch (e) {
      // Only a hub that did not answer (fetch failed), not one that answered with an error.
      if (!(e instanceof TypeError) || hubUrl(config) === localHub(config)) throw e;
      await hubCall(config, "POST", "/api/whatsapp/messages", body, localHub(config));
      if (!warned) console.warn(`! ${hubUrl(config)} is not answering; drafting on this device until it is back`);
      warned = true;
      return;
    }
    if (warned) console.log(`${hubUrl(config)} is answering again.`);
    warned = false;
  };
  const drain = async () => {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const batch = queue.slice(0, 200).map((m) => ({ ...m, mediaPath: undefined }));
      try {
        await send(batch);
        queue.splice(0, batch.length);
      } catch (e) {
        if (!warned) console.warn(`! hub unreachable (${(e as Error).message}); keeping ${queue.length} message(s) to retry`);
        warned = true;
        await new Promise((r) => setTimeout(r, 15_000));
      }
    }
    busy = false;
  };
  return { send: (ms: WaMessage[]) => (queue.push(...ms), void drain()) };
}

/** Your own WhatsApp id from the link's saved sign-in; undefined until linked. */
function readCreds(config: Config): { me?: string } | undefined {
  const f = join(resolve(config.dataDir), "whatsapp", "auth", "creds.json");
  if (!existsSync(f)) return undefined;
  const id: string | undefined = JSON.parse(readFileSync(f, "utf8")).me?.id;
  if (!id) return undefined;
  return { me: `${id.split(":")[0].split("@")[0]}@s.whatsapp.net` };
}

async function cmdNodes(config: Config) {
  const sys = buildSystem(config);
  await sys.cluster.refresh();
  const self = await sys.cluster.localInfo();
  const line = (n: { name: string; providers: { id: string; ready: boolean }[] }, extra = "") =>
    console.log(`${n.name.padEnd(20)} ${n.providers.map((p) => `${p.ready ? "✓" : "✗"}${p.id}`).join("  ")} ${extra}`);
  line(self, "(this device)");
  for (const p of sys.cluster.list()) line(p, `${p.url} ${p.online ? "" : `OFFLINE ${p.error ?? ""}`}`);
  if (!sys.cluster.list().length) console.log("\nNo peers found. Start `orc serve` on your other devices (same ORC_TOKEN, Tailscale connected).");
  sys.store.close();
}

function cmdInit() {
  const cfg = resolve(process.cwd(), "orchestrator.config.yaml");
  if (!existsSync(cfg)) {
    copyFileSync(resolve(ROOT, "orchestrator.config.example.yaml"), cfg);
    console.log(`created ${cfg}`);
  } else console.log(`kept existing ${cfg}`);
  const envPath = resolve(process.cwd(), ".env");
  const env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  if (!/^ORC_TOKEN=/m.test(env)) {
    writeFileSync(envPath, `${env}${env && !env.endsWith("\n") ? "\n" : ""}ORC_TOKEN=${randomBytes(32).toString("hex")}\n# PERPLEXITY_API_KEY=pplx-...\n# GROQ_API_KEY=gsk_...\n`);
    console.log(`wrote a new ORC_TOKEN to ${envPath}; copy the SAME token to every device`);
  }
}

/** Minimal MCP (stdio) server that forwards to the running orchestrator, so Claude Code, Codex or Gemini can delegate to it. */
/** Shared memory for every AI tool on this device (Claude Code, Codex, Gemini CLI, Antigravity). */
const MEMORY_TOOLS = [
  {
    name: "memory_search",
    description:
      "Search the owner's shared memory (the same on all his devices): people, projects, past work and decisions, facts, tasks, files on every device. Use it before answering anything about his life, work, people or files.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        kind: { type: "string", description: "Optional filter: person, project, org, fact, note, decision, work, task, event, file, relation" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_about",
    description: "Everything shared memory holds about one person, project, place or device: the record, its relations, and facts/decisions/work about it.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "A name or a uid like person:jayesh-daga" } }, required: ["name"] },
  },
  {
    name: "memory_remember",
    description:
      "Save something to the owner's shared memory so every device and AI tool knows it: a fact, a note, or a decision (with its reason). Set `subject` to the person/project it is about.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        kind: { type: "string", enum: ["fact", "note", "decision"] },
        subject: { type: "string", description: "Name or uid of what it is about" },
        title: { type: "string" },
      },
      required: ["text"],
    },
  },
  {
    name: "memory_recent",
    description: "The most recently added or changed memory records (optionally one kind), e.g. recent work done on any device.",
    inputSchema: { type: "object", properties: { kind: { type: "string" }, limit: { type: "number" } } },
  },
];

function formatMemory(records: { uid: string; kind: string; title: string; body: string; device?: string; updated_at?: string }[]): string {
  if (!records.length) return "Nothing in memory matches.";
  return records
    .map((r) => `[${r.kind}] ${r.title}  (${r.uid}${r.device ? `, from ${r.device}` : ""}${r.updated_at ? `, ${r.updated_at.slice(0, 10)}` : ""})${r.body ? `\n${r.body.slice(0, 800)}` : ""}`)
    .join("\n\n");
}

function formatAbout(a: { record: any; relations: { src: string; rel: string; dst: string; title: string }[]; linked: any[] }): string {
  const parts = [formatMemory([a.record])];
  if (a.relations.length) parts.push("Relations:\n" + a.relations.map((r) => `- ${r.title}`).join("\n"));
  if (a.linked.length) parts.push("About it:\n" + formatMemory(a.linked));
  return parts.join("\n\n");
}

async function memoryViaServer(base: string, name: string, args: any): Promise<string> {
  const get = async (path: string) => {
    const res = await fetch(`${base}/api/shared-memory/${path}`);
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`orc serve: HTTP ${res.status}`);
    return res.json() as Promise<any>;
  };
  if (name === "memory_search") {
    const q = new URLSearchParams({ q: String(args.query ?? ""), limit: String(args.limit ?? 8), ...(args.kind ? { kind: args.kind } : {}) });
    return formatMemory((await get(`search?${q}`)) ?? []);
  }
  if (name === "memory_about") {
    const a = await get(`about?name=${encodeURIComponent(String(args.name ?? ""))}`);
    return a ? formatAbout(a) : `Nothing in memory about ${args.name}.`;
  }
  if (name === "memory_recent") {
    const q = new URLSearchParams({ limit: String(args.limit ?? 15), ...(args.kind ? { kind: args.kind } : {}) });
    return formatMemory((await get(`recent?${q}`)) ?? []);
  }
  if (name === "memory_remember") {
    const res = await fetch(`${base}/api/shared-memory/remember`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: args.text, kind: args.kind ?? "note", subject: args.subject, title: args.title }),
    });
    if (!res.ok) throw new Error(`orc serve: HTTP ${res.status} ${await res.text()}`);
    const rec = (await res.json()) as { uid: string };
    return `Saved to shared memory as ${rec.uid}.`;
  }
  return `unknown memory tool ${name}`;
}

function memoryDirect(r: NonNullable<ReturnType<typeof openReplica>>, name: string, args: any): string {
  if (name === "memory_search") return formatMemory(r.search(String(args.query ?? ""), { kind: args.kind, limit: args.limit ?? 8 }));
  if (name === "memory_about") {
    const a = r.about(String(args.name ?? ""));
    return a ? formatAbout(a) : `Nothing in memory about ${args.name}.`;
  }
  if (name === "memory_recent") return formatMemory(r.recent({ kind: args.kind, limit: args.limit ?? 15 }));
  if (name === "memory_remember") {
    const subject = args.subject ? r.resolve(String(args.subject))?.uid : undefined;
    const kind = ["fact", "note", "decision"].includes(args.kind) ? args.kind : "note";
    const text = String(args.text ?? "");
    const rec = r.put({ kind, title: args.title ?? text.split(/\s+/).join(" ").slice(0, 80), body: text, subject: subject ?? null, source: "mcp" });
    return `Saved to this device's memory as ${rec.uid}; it syncs when \`orc serve\` runs.`;
  }
  return `unknown memory tool ${name}`;
}

async function cmdMcp(config: Config) {
  const base = `http://127.0.0.1:${config.server.port}`;
  const headers = { "Content-Type": "application/json" };
  const tools = [
    {
      name: "orchestrate",
      description:
        "Hand a task to the multi-model orchestrator. It plans, routes sub-tasks to the best model (Claude, ChatGPT/Codex, Gemini, Perplexity, Groq) across your devices, and returns the merged result.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string" },
          mode: { type: "string", enum: ["auto", "direct", "plan"] },
          provider: { type: "string", enum: ["claude", "codex", "gemini", "perplexity", "groq"] },
          agent: { type: "string", description: "Specialist agent name, e.g. researcher, pcb-designer, cad-modeler" },
        },
        required: ["task"],
      },
    },
    { name: "list_agents", description: "List the orchestrator's specialist agents.", inputSchema: { type: "object", properties: {} } },
    ...MEMORY_TOOLS,
  ];
  // Memory tools answer from this device's replica: through `orc serve` when it runs (it also
  // syncs), else straight from the replica file (writes are pushed when serve next syncs).
  let direct: ReturnType<typeof openReplica> | null = null;
  const memoryCall = async (name: string, args: any): Promise<string> => {
    try {
      return await memoryViaServer(base, name, args);
    } catch (e) {
      if (!(e instanceof TypeError)) throw e; // a real answer from serve (e.g. 404) is not "offline"
      direct ??= openReplica(config) ?? null;
      if (!direct) return "Shared memory is off on this device (sharedMemory.enabled).";
      return memoryDirect(direct, name, args);
    }
  };
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === undefined) continue; // notifications need no reply
    try {
      if (msg.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ai-orchestrator", version: "0.1.0" } },
        });
      } else if (msg.method === "tools/list") {
        send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
      } else if (msg.method === "tools/call") {
        const { name, arguments: args } = msg.params;
        let text: string;
        if (name.startsWith("memory_")) {
          text = await memoryCall(name, args ?? {});
        } else if (name === "list_agents") {
          const agents = (await (await fetch(`${base}/api/agents`)).json()) as { name: string; kind: string; description: string }[];
          text = agents.map((a) => `${a.name} (${a.kind}): ${a.description}`).join("\n");
        } else {
          const res = await fetch(`${base}/api/runs`, { method: "POST", headers, body: JSON.stringify(args) });
          const run = (await res.json()) as { id: string };
          let rec: any;
          do {
            await new Promise((r) => setTimeout(r, 2000));
            rec = await (await fetch(`${base}/api/runs/${run.id}`)).json();
          } while (!["done", "failed", "cancelled"].includes(rec.status));
          text = rec.status === "done" ? rec.result : `Run ${rec.status}: ${rec.error}`;
        }
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
      } else if (msg.method === "ping") {
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
      }
    } catch (e) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { isError: true, content: [{ type: "text", text: `orchestrator not reachable at ${base}; is \`orc serve\` running? (${(e as Error).message})` }] },
      });
    }
  }
}

/**
 * `orc record`: record this computer's microphone until Enter, then send it to the hub, which has
 * the laptop's Whisper transcribe it and turns it into tasks and memory. A failed send keeps the file:
 * `orc record --file <path>` sends it again.
 */
async function cmdRecord(config: Config, o: { seconds?: number; file?: string }) {
  let file = o.file;
  let seconds: number | undefined;
  if (!file) {
    const dir = join(resolve(config.dataDir), "recordings");
    mkdirSync(dir, { recursive: true });
    file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.wav`);
    console.log("Starting the microphone (the first run downloads what it needs)…");
    const child = spawn(config.style.uv, ["run", resolve(ROOT, "tools", "record.py"), file, ...(o.seconds ? ["--seconds", String(o.seconds)] : [])], { stdio: ["inherit", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const code = await new Promise<number | null>((ok, no) => {
      child.on("error", no);
      child.on("close", ok);
    });
    if (code !== 0) throw new Error(`recording stopped with code ${code}`);
    seconds = Number(out.trim()) || undefined;
  }
  const form = new FormData();
  form.append("audio", new File([readFileSync(file)], basename(file), { type: "audio/wav" }));
  form.append("source", "laptop");
  if (seconds) form.append("durationSec", String(seconds));
  const url = `${hubUrl(config)}/api/convos`;
  try {
    const res = await fetch(url, { method: "POST", headers: config.server.token ? { Authorization: `Bearer ${config.server.token}` } : {}, body: form });
    if (!res.ok) throw new Error(`the hub answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    console.log(`Sent. It is being transcribed; you get a notice when tasks and notes are ready. (Saved in ${file})`);
  } catch (e) {
    throw new Error(`could not send it to ${url}: ${(e as Error).message}\nThe recording is safe. Send it later with: orc record --file "${file}"`);
  }
}

/** `orc wake`: listen for "Hey Jarvis" on this computer and talk to the hub's assistant. Ctrl+C stops. */
async function cmdWake(config: Config, over: { threshold?: number; device?: string }) {
  if (over.threshold !== undefined && !(over.threshold > 0 && over.threshold < 1)) throw new Error("--threshold is between 0 and 1 (default 0.5; lower wakes more easily)");
  const listener = new WakeListener(wakeOptions(config, ROOT, over));
  process.on("SIGINT", () => listener.stop());
  console.log('Starting the wake word listener (the first run downloads openWakeWord and its models)… Say "Hey Jarvis".');
  const code = await listener.start();
  if (code) process.exitCode = code;
}

async function main() {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      port: { type: "string", short: "p" },
      mode: { type: "string" },
      provider: { type: "string" },
      agent: { type: "string" },
      cwd: { type: "string" },
      permission: { type: "string" },
      branches: { type: "boolean" },
      verbose: { type: "boolean", short: "v" },
      live: { type: "boolean" },
      ask: { type: "string" },
      draft: { type: "boolean" },
      raw: { type: "boolean" },
      threshold: { type: "string" },
      seconds: { type: "string" },
      file: { type: "string" },
      device: { type: "string" },
    },
  });
  const [cmd = "serve", ...rest] = positionals;
  if (cmd === "init") return cmdInit();
  const { config } = loadConfig(v.config);
  if (v.port) config.server.port = Number(v.port);

  switch (cmd) {
    case "serve":
      return cmdServe(config);
    case "run":
      return cmdRun(config, rest.join(" "), v);
    case "doctor":
    case "providers":
      return cmdDoctor(config, !!v.live);
    case "nodes":
      return cmdNodes(config);
    case "agents":
      for (const a of buildSystem(config).agents.values()) console.log(`${a.name.padEnd(22)} ${a.kind.padEnd(14)} ${a.description}`);
      return;
    case "mcp":
      return cmdMcp(config);
    case "gmail":
      return cmdGmail(config, rest[0]);
    case "shop":
      return cmdShop(config, rest[0], rest[1]);
    case "whatsapp":
      return cmdWhatsApp(config, rest[0]);
    case "wake":
      return cmdWake(config, { threshold: v.threshold ? Number(v.threshold) : undefined, device: v.device as string | undefined });
    case "record":
      return cmdRecord(config, { seconds: v.seconds ? Number(v.seconds) : undefined, file: v.file as string | undefined });
    case "style":
      return cmdStyle(config, rest[0], { who: rest.slice(1).join(" "), ask: v.ask as string | undefined, draft: !!v.draft, raw: !!v.raw });
    default:
      console.log(`usage: orc <serve|run "task"|doctor [--live]|nodes|agents|gmail [connect|connect-send|check|status|disconnect]|shop login <store>|whatsapp [link|status]|style [learn|push|pull|show|graph|pool <name> [--ask "…"] [--draft]]|wake [--threshold 0.5] [--device <mic>]|init|mcp>`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
