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
