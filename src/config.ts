import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";

const providerBase = {
  enabled: z.boolean().default(true),
  /** Executable to run. "auto" finds it on PATH (or the Codex desktop app's bundled binary). */
  command: z.string().default("auto"),
  /** Default model; empty lets the CLI pick its own default for your plan. */
  model: z.string().optional(),
  /** Model to use for heavy steps (system design, reasoning). */
  deepModel: z.string().optional(),
  extraArgs: z.array(z.string()).default([]),
  /** Concurrent jobs per device. Subscriptions throttle hard, so keep this low. */
  maxConcurrent: z.number().int().min(1).default(2),
};

const ConfigSchema = z.object({
  node: z
    .object({
      name: z.string().default(hostname().toLowerCase()),
      /** Directory remote steps run in when this device is a worker. */
      workRoot: z.string().default("./workspaces"),
      /**
       * Let other devices send this one coding steps to do on their own git branch: it clones the
       * repo, lets a model edit, runs the tests and pushes. Needs push access to your repos (gh auth login).
       */
      acceptBranchWork: z.boolean().default(false),
    })
    .prefault({}),
  server: z
    .object({
      /** "auto": loopback unless a token is set; "tailscale": bind only to this device's tailnet IP; or an explicit address. */
      host: z.string().default("auto"),
      port: z.number().int().default(4317),
      /** Shared secret for the API and for device-to-device calls. Required for anything but loopback. */
      token: z.string().optional(),
      /**
       * Firebase service-account key (JSON) for notifications to the Android app.
       * Defaults to ./fcm-service-account.json when that file exists.
       */
      fcmServiceAccount: z.string().optional(),
    })
    .prefault({}),
  dataDir: z.string().default("./data"),
  brain: z
    .object({
      /** Provider that plans and synthesizes. */
      planner: z.enum(["claude", "codex", "gemini"]).default("claude"),
      plannerModel: z.string().optional(),
      /** "model": Groq refines the keyword classification of each task (when GROQ_API_KEY is set); "keywords": keywords only. */
      classifier: z.enum(["model", "keywords"]).default("model"),
      maxParallelSteps: z.number().int().min(1).default(4),
      maxPlanSteps: z.number().int().min(1).default(8),
      defaultPermission: z.enum(["read", "edit", "full"]).default("read"),
      stepTimeoutMinutes: z.number().default(30),
      /** Cross-model review: a reviewer never runs on the same provider as the author. */
      crossReview: z.boolean().default(true),
      /** Adjust routing from your thumbs-up / thumbs-down ratings. */
      learnFromFeedback: z.boolean().default(true),
    })
    .prefault({}),
  providers: z
    .object({
      claude: z.object(providerBase).prefault({}),
      codex: z.object(providerBase).prefault({}),
      gemini: z.object(providerBase).prefault({}),
      perplexity: z
        .object({
          ...providerBase,
          apiKey: z.string().optional(),
          model: z.string().default("sonar-pro"),
          deepModel: z.string().default("sonar-deep-research"),
          baseUrl: z.string().default("https://api.perplexity.ai"),
        })
        .prefault({}),
      /**
       * Groq: a fast OpenAI-compatible API with a free tier (console.groq.com). Takes quick
       * questions and reads Gmail. Any other OpenAI-compatible service works the same way.
       */
      groq: z
        .object({
          ...providerBase,
          apiKey: z.string().optional(),
          /** Several keys to rotate through (GROQ_API_KEYS, comma-separated): when one hits its limit the next is used. */
          apiKeys: z.array(z.string()).default([]),
          baseUrl: z.string().default("https://api.groq.com/openai/v1"),
          model: z.string().default("openai/gpt-oss-120b"),
          deepModel: z.string().default("openai/gpt-oss-120b"),
          /** Speech-to-text for phone calls (Groq's free Whisper). */
          transcribeModel: z.string().default("whisper-large-v3-turbo"),
          maxConcurrent: z.number().int().min(1).default(4),
        })
        .prefault({}),
    })
    .prefault({}),
  /** Per-kind score overrides, e.g. { pcb_design: { codex: 9 } }. Merged over the built-in matrix. */
  routing: z
    .object({
      overrides: z.record(z.string(), z.record(z.string(), z.number().min(0).max(10))).prefault({}),
    })
    .prefault({}),
  /** Coding on branches across devices (run option `branches`). */
  branches: z
    .object({
      /** Remote the branches are pushed to. */
      remote: z.string().default("origin"),
      /** "auto" detects (npm test, cargo test, pytest…); "" skips tests; anything else is run as a shell command. */
      testCommand: z.string().default("auto"),
      testTimeoutMinutes: z.number().default(15),
      /** When tests fail, give the model this many chances to fix them before pushing anyway. */
      fixAttempts: z.number().int().min(0).max(3).default(1),
    })
    .prefault({}),
  /** What the brain remembers between runs. Past runs relevant to a new task are fed to the planner. */
  memory: z
    .object({
      enabled: z.boolean().default(true),
      /** Past runs to recall per task. */
      recall: z.number().int().min(0).max(10).default(3),
      /** Optional sync to a NotebookLM notebook via the unofficial `notebooklm` CLI (notebooklm-py). */
      notebooklm: z
        .object({
          enabled: z.boolean().default(false),
          /** Notebook id (partial ids work). Create one with `notebooklm create "AI Orchestrator memory"`. */
          notebook: z.string().optional(),
          command: z.string().default("notebooklm"),
          /** Also ask the notebook about each new planned task (slower: one NotebookLM chat call). */
          ask: z.boolean().default(true),
        })
        .prefault({}),
    })
    .prefault({}),
  /** Code map of the working folder for planning, built offline by Graphify (`graphify update`). */
  context: z
    .object({
      graphify: z.enum(["auto", "off"]).default("auto"),
      graphifyCommand: z.string().default("graphify"),
      graphifyTimeoutSeconds: z.number().default(180),
    })
    .prefault({}),
  /** Who the agents work for: put in every agent's briefing so answers are about you, not generic. */
  profile: z
    .object({
      /** Defaults to OWNER_NAME from .env. */
      name: z.string().optional(),
      /** A line or two: what you do, what you're working on, how you like answers. */
      about: z.string().optional(),
    })
    .prefault({}),
  /**
   * The AI_Assistant brain (../AI_Assistant) on this machine: it reads Gmail and WhatsApp and
   * extracts tasks; today's go to the home screen. On when BRAIN_TOKEN is set.
   */
  assistant: z
    .object({
      url: z.string().default("http://127.0.0.1:8000"),
      /** The brain's BRAIN_TOKEN (from AI_Assistant/.env). */
      token: z.string().optional(),
      pollMinutes: z.number().min(1).default(2),
    })
    .prefault({}),
  /**
   * What the assistant may do on this device (src/actions). Safe actions run on their own; the
   * rest wait for Approve on the phone. There is no delete action.
   */
  actions: z
    .object({
      enabled: z.boolean().default(true),
      /** Folders the assistant may read and change, e.g. ["C:/development"]. Empty: node.workRoot only. */
      roots: z.array(z.string()).default([]),
      /** Commands that run without asking (exact, or followed by arguments). Anything chained (; | && > $) asks. */
      safeCommands: z
        .array(z.string())
        .default([
          "git status", "git log", "git diff", "git branch", "git show", "git remote -v",
          "nvidia-smi", "tailscale status", "tailscale ip", "df", "free", "uptime", "whoami", "hostname",
          "pwd", "node --version", "npm --version", "python --version", "python3 --version",
          "uv --version", "flutter --version", "ollama list", "ollama ps", "docker ps", "systemctl --user status",
          "Get-Process", "Get-PSDrive",
        ]),
      /** Action names that never ask (e.g. "apps.open"). Your call; the defaults ask. */
      safe: z.array(z.string()).default([]),
      /** Action names that are always refused on this device. */
      never: z.array(z.string()).default([]),
      approvalMinutes: z.number().min(1).default(30),
      timeoutSeconds: z.number().min(5).default(120),
      outputChars: z.number().min(500).default(20_000),
    })
    .prefault({}),
  /**
   * Shared memory: one pool every device reads and writes (AI_Assistant docs/JARVIS.md). The master
   * copy is in the brain on the Linux machine; every device keeps a replica in `dataDir/file`.
   * The machine that runs the brain (BRAIN_TOKEN set) syncs with it directly; other devices sync
   * through that machine's hub (`hub`, e.g. http://100.104.185.17:4317, with the same ORC_TOKEN).
   */
  sharedMemory: z
    .object({
      enabled: z.boolean().default(true),
      file: z.string().default("shared-memory.db"),
      /** The Linux hub's address, for devices that don't run the brain. Empty: memory stays on this device. */
      hub: z.string().optional(),
      pollSeconds: z.number().min(10).default(60),
    })
    .prefault({}),
  /** Picks today's tasks out of your Gmail (read-only). Off until you run `orc gmail connect`. */
  gmail: z
    .object({
      /** OAuth client (Desktop app) downloaded from Google Cloud. */
      clientFile: z.string().default("gmail-client.json"),
      pollMinutes: z.number().min(2).default(15),
      /** Gmail search for mail worth reading. */
      query: z.string().default("in:inbox newer_than:2d -category:promotions -category:social -category:forums"),
      /** Model that reads the mail: auto uses the first ready of Groq, Claude, Gemini, ChatGPT. */
      provider: z.enum(["auto", "groq", "claude", "codex", "gemini"]).default("auto"),
    })
    .prefault({}),
  /** Your WhatsApp as a read-only linked device (`orc whatsapp link`). Nothing is ever sent. */
  whatsapp: z
    .object({
      /** "full" asks the phone for all the history it will give; it only arrives when you link. */
      history: z.enum(["off", "recent", "full"]).default("full"),
      /** Download voice notes so the local Whisper can transcribe them. */
      voiceNotes: z.boolean().default(true),
      /** Download photos sent to you in direct chats so the local vision model can describe them. */
      images: z.boolean().default(true),
      /** Chat ids to leave alone, e.g. 9190000…@s.whatsapp.net or …@g.us. */
      ignore: z.array(z.string()).default([]),
      /**
       * The hub that drafts replies, e.g. http://100.104.185.17:4317. The device running the link
       * forwards new messages there and `orc style push` sends the style book. Empty: this device.
       */
      hub: z.string().default(""),
      /** Draft a reply when someone messages you (the hub; needs a style book). */
      autoDraft: z.boolean().default(true),
      /** Also draft for groups; off drafts only for direct chats. */
      draftGroups: z.boolean().default(false),
      /** Seconds to wait after their last message, so a burst of messages gets one draft. */
      draftDelaySeconds: z.number().min(0).default(45),
      /** Model that writes the drafts: auto uses the first ready of Claude, Gemini, ChatGPT, Groq. */
      replyProvider: z.enum(["auto", "claude", "codex", "gemini", "groq"]).default("auto"),
    })
    .prefault({}),
  /** Learning your writing style from WhatsApp with local models (`orc style learn`). */
  style: z
    .object({
      ollamaUrl: z.string().default("http://127.0.0.1:11434"),
      /** Ollama model that reads your chats and writes the style notes. */
      model: z.string().default("qwen3:8b"),
      /** Ollama model that can see images: describes photos people send you before a reply is drafted. */
      visionModel: z.string().default("gemma3:4b"),
      /** faster-whisper model for voice notes. */
      whisperModel: z.string().default("large-v3-turbo"),
      /** Whisper language code (e.g. "ta"); empty detects it per voice note. */
      whisperLanguage: z.string().default(""),
      uv: z.string().default("uv"),
      /** Chats where you sent fewer messages than this are not studied. */
      minMessages: z.number().int().min(1).default(15),
      /** Extra terms of address or nicknames, each with its spellings: ["chinna chinnu", "kanna kannu"]. */
      addressTerms: z.array(z.string()).default([]),
      maxContacts: z.number().int().min(1).default(80),
    })
    .prefault({}),
  cluster: z
    .object({
      enabled: z.boolean().default(true),
      /** Discover other devices running the orchestrator via `tailscale status`. */
      tailscale: z.boolean().default(true),
      /** Extra peers by URL, e.g. http://laptop.tailnet-name.ts.net:4317 */
      peers: z.array(z.string()).default([]),
      pollSeconds: z.number().default(20),
      /** Score bonus for running on this device (avoids network hops when equal). */
      localBias: z.number().default(0.5),
    })
    .prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ProviderConfig = Config["providers"]["claude"];

/** Replace ${VAR} and ${VAR:-default} with environment values. */
export function interpolateEnv(text: string, env: NodeJS.ProcessEnv = process.env): string {
  return text.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_, name: string, def?: string) => env[name] ?? def ?? "");
}

function loadDotEnv(dir: string) {
  const p = resolve(dir, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

export function parseConfig(raw: unknown): Config {
  const cfg = ConfigSchema.parse(raw ?? {});
  // Empty strings from unset env vars mean "not configured".
  if (!cfg.server.token) cfg.server.token = process.env.ORC_TOKEN || undefined;
  // Without a key Perplexity stays listed but reports itself as not logged in.
  if (!cfg.providers.perplexity.apiKey) cfg.providers.perplexity.apiKey = process.env.PERPLEXITY_API_KEY || undefined;
  if (!cfg.profile.name) cfg.profile.name = process.env.OWNER_NAME || undefined;
  if (!cfg.assistant.token) cfg.assistant.token = process.env.BRAIN_TOKEN || undefined;
  if (!cfg.sharedMemory.hub) cfg.sharedMemory.hub = process.env.MEMORY_HUB || undefined;
  if (!cfg.providers.groq.apiKey) cfg.providers.groq.apiKey = process.env.GROQ_API_KEY || undefined;
  if (!cfg.providers.groq.apiKeys.length) cfg.providers.groq.apiKeys = (process.env.GROQ_API_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  return cfg;
}

export function loadConfig(path?: string): { config: Config; path?: string } {
  const cwd = process.cwd();
  loadDotEnv(cwd);
  const candidate = path ?? process.env.ORC_CONFIG ?? resolve(cwd, "orchestrator.config.yaml");
  if (!existsSync(candidate)) return { config: parseConfig({}) };
  const raw = YAML.parse(interpolateEnv(readFileSync(candidate, "utf8")));
  return { config: parseConfig(dropNulls(raw)), path: candidate };
}

/** `key:` with nothing after it (e.g. an unset ${VAR}) parses as null; treat it as not set. */
export function dropNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropNulls);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)]));
  return v;
}
