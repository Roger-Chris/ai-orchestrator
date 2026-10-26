import spawn from "cross-spawn";
import type { ProviderConfig } from "../config.js";
import type { ProviderId, ProviderRequest, ProviderResult, ProviderStatus } from "../types.js";

export interface Provider {
  readonly id: ProviderId;
  /** Checks the CLI is installed and logged in. Cheap: never calls the model. */
  detect(): Promise<ProviderStatus>;
  run(req: ProviderRequest): Promise<ProviderResult>;
}

const RATE_LIMIT_PATTERNS = [
  /usage limit/i,
  /rate.?limit/i,
  /\b429\b/,
  /quota/i,
  /too many requests/i,
  /limit (?:reached|exceeded)/i,
  /resource.?exhausted/i,
  /try again (?:in|at|later)/i,
  /resets? (?:at|in)/i,
];

export function looksRateLimited(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}

/**
 * Best-effort parse of when a usage limit resets, from messages like
 * "resets at 3pm", "try again in 2 hours", "retry after 120 seconds".
 */
export function parseRetryAt(text: string, now = Date.now()): number | undefined {
  const rel = text.match(/(?:in|after)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i);
  if (rel) {
    const n = parseFloat(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit.startsWith("h") ? 3_600_000 : unit.startsWith("m") ? 60_000 : 1000;
    return now + n * ms;
  }
  const abs = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (abs) {
    let h = parseInt(abs[1], 10);
    const m = abs[2] ? parseInt(abs[2], 10) : 0;
    const ampm = abs[3]?.toLowerCase();
    if (ampm === "pm" && h < 12) h += 12;
    if (ampm === "am" && h === 12) h = 0;
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return undefined;
}

export interface SpawnOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
}

/**
 * Runs a CLI, feeding the prompt on stdin (avoids Windows' 32k command-line
 * limit and shell-quoting problems) and streaming stdout line by line.
 */
export function runProcess(opts: {
  command: string;
  args: string[];
  stdin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
}): Promise<SpawnOutcome> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let buf = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const finish = (o: Partial<SpawnOutcome> & { code: number | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (buf) opts.onLine?.(buf);
      resolvePromise({ stdout, stderr, timedOut, aborted, ...o });
    };

    const kill = () => {
      try {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3000).unref();
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs ?? 30 * 60_000);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line) opts.onLine?.(line);
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => finish({ code: null, spawnError: err.message }));
    child.on("close", (code) => finish({ code }));

    child.stdin?.on("error", () => {
      /* CLI may exit before reading stdin */
    });
    child.stdin?.end(opts.stdin ?? "");
  });
}

/** Runs `<command> --version` to see if a CLI exists. */
export async function probeVersion(command: string, args = ["--version"]): Promise<string | undefined> {
  const r = await runProcess({ command, args, timeoutMs: 20_000 });
  if (r.spawnError || r.code !== 0) return undefined;
  return (r.stdout || r.stderr).trim().split(/\r?\n/)[0];
}

export function tryParseJson(line: string): any | undefined {
  const t = line.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** Builds the common failure result, flagging usage limits. */
export function failure(provider: ProviderId, started: number, message: string, model?: string): ProviderResult {
  const rateLimited = looksRateLimited(message);
  return {
    ok: false,
    text: "",
    provider,
    model,
    durationMs: Date.now() - started,
    error: message.slice(0, 4000),
    rateLimited,
    retryAt: rateLimited ? parseRetryAt(message) : undefined,
  };
}

export function outcomeError(o: SpawnOutcome): string {
  if (o.spawnError) return `could not start: ${o.spawnError}`;
  if (o.timedOut) return "timed out";
  if (o.aborted) return "cancelled";
  return (o.stderr || o.stdout).trim().slice(-2000) || `exited with code ${o.code}`;
}

export function resolveCommand(cfg: ProviderConfig, fallback: string): string {
  return cfg.command && cfg.command !== "auto" ? cfg.command : fallback;
}

/** Combines system + user prompt for CLIs without a system-prompt flag. */
export function withSystem(req: ProviderRequest): string {
  return req.system ? `<instructions>\n${req.system}\n</instructions>\n\n${req.prompt}` : req.prompt;
}
