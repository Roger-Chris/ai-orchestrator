import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { cpus, freemem, homedir, hostname, loadavg, platform, release, totalmem, uptime } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import { runProcess } from "../providers/base.js";
import type { ProviderPool } from "../providers/registry.js";
import type { MemoryReplica } from "../shared/replica.js";
import type { ProviderId } from "../types.js";

/**
 * What the assistant can do on a device (AI_Assistant docs/JARVIS.md, "Hands").
 *
 * Every action has a risk:
 * - safe:  runs on its own (reading, searching, status, read-only AI questions, safe-listed commands)
 * - ask:   runs only after the owner taps Approve on the phone (anything that changes things)
 * - never: refused (secrets, passwords)
 *
 * There is deliberately no delete action, and nothing overwrites a file without keeping the old
 * one: a changed file is backed up first, so the old version is there until the new one is checked.
 */

export type Risk = "safe" | "ask" | "never";

export interface ActionContext {
  config: Config;
  pool?: ProviderPool;
  replica?: MemoryReplica;
  signal?: AbortSignal;
  /** For tests: the clock used in backup names. */
  now?: () => Date;
}

export interface ActionResult {
  ok: boolean;
  output: string;
  data?: unknown;
}

export interface ActionDef<A extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  describe: string;
  args: A;
  /** The risk of this call, before config overrides. */
  risk: (args: z.infer<A>, ctx: ActionContext) => Risk;
  /** One line the owner reads before approving. */
  summary: (args: z.infer<A>) => string;
  run: (args: z.infer<A>, ctx: ActionContext) => Promise<ActionResult>;
}

const def = <A extends z.ZodTypeAny>(d: ActionDef<A>) => d as unknown as ActionDef;

// ---------------------------------------------------------------- guards

/** File names that hold secrets: never read, written or moved by the assistant. */
const SECRET = /(^|[\\/])(\.env(\.[\w.-]+)?|\.ssh|\.gnupg|id_(rsa|ed25519|ecdsa)[^\\/]*|[^\\/]*\.(pem|key|p12|pfx|keystore|jks)|credentials?(\.json)?|[^\\/]*token[^\\/]*\.json|[^\\/]*secret[^\\/]*|key\.properties|fcm-service-account\.json|gmail-client\.json|\.git-credentials|\.netrc)$/i;

export function isSecretPath(p: string): boolean {
  const parts = p.split(/[\\/]+/);
  return parts.some((_, i) => SECRET.test(parts.slice(0, i + 1).join("/")));
}

/** Tokens that must never leave a device in an action's output (a remote URL can hold one). */
const TOKEN_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgsk_[A-Za-z0-9]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/g, // user:password@ in URLs
];

export function redact(text: string): string {
  let out = text;
  for (const p of TOKEN_PATTERNS) out = out.replace(p, (m, scheme) => (typeof scheme === "string" && m.startsWith(scheme) ? `${scheme}***@` : "***"));
  return out;
}

/** Folders the assistant may touch on this device: `actions.roots`, else the node's work root. */
export function roots(config: Config): string[] {
  const list = config.actions.roots.length ? config.actions.roots : [config.node.workRoot];
  return list.map((r) => resolve(r.replace(/^~(?=$|[\\/])/, homedir())));
}

const norm = (p: string) => (platform() === "win32" ? p.toLowerCase() : p);

/** Resolves `p` inside one of the roots (following links), or throws. */
export function insideRoots(p: string, config: Config, mustExist = true): string {
  const rs = roots(config);
  const abs = isAbsolute(p) ? resolve(p) : resolve(rs[0], p);
  if (!existsSync(abs) && mustExist) throw new Error(`not found: ${p}`);
  // Resolve links on the deepest part that exists: "root/link/new/file" with link -> /etc must
  // be judged as /etc/new/file, or a new folder could be made outside the roots.
  let existing = abs;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    rest.unshift(basename(existing));
    const up = dirname(existing);
    if (up === existing) break;
    existing = up;
  }
  const real = existsSync(existing) ? join(realpathSync(existing), ...rest) : abs;
  const ok = rs.some((r) => {
    const root = existsSync(r) ? realpathSync(r) : r;
    const rel = relative(norm(root), norm(real));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
  if (!ok) throw new Error(`${p} is outside the folders the assistant may use (actions.roots: ${rs.join(", ")})`);
  if (isSecretPath(real)) throw new Error(`${basename(real)} looks like a secret; the assistant never touches those`);
  return real;
}

// Chaining, redirection and substitution in bash and PowerShell. PowerShell also runs `( )`, `{ }`
// and `@( )` inside arguments ("git status (Remove-Item x)"), so those always ask too.
const SHELL_META = /[;&|<>`$\n\r(){}@]/;

/** A command runs without asking only when it is on the safe list and chains nothing else. */
export function shellRisk(command: string, config: Config): Risk {
  const c = command.trim();
  if (/\b(password|passwd|runas|sudo|ssh-keygen)\b/i.test(c)) return "never";
  if (SHELL_META.test(c)) return "ask";
  const safe = config.actions.safeCommands.some((s) => c === s || c.startsWith(`${s} `));
  return safe ? "safe" : "ask";
}

function cap(text: string, config: Config): string {
  const max = config.actions.outputChars;
  const t = redact(text);
  return t.length > max ? `${t.slice(0, max)}\n… (${t.length - max} more characters cut)` : t;
}

async function sh(command: string, cwd: string, ctx: ActionContext, timeoutMs?: number) {
  const win = platform() === "win32";
  const r = await runProcess({
    command: win ? "powershell.exe" : "/bin/bash",
    args: win ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-lc", command],
    cwd,
    timeoutMs: timeoutMs ?? ctx.config.actions.timeoutSeconds * 1000,
    signal: ctx.signal,
  });
  return r;
}

/** AI tools by the names people use for them. */
const AI_TOOLS: Record<string, ProviderId> = {
  claude: "claude", "claude-code": "claude",
  codex: "codex", chatgpt: "codex", openai: "codex",
  gemini: "gemini", antigravity: "gemini", agy: "gemini",
  perplexity: "perplexity", groq: "groq",
};

function backupName(file: string, now: Date) {
  const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `${file}.bak-${stamp}`;
}

// ---------------------------------------------------------------- actions

const PathArg = z.object({ path: z.string().min(1) });

export const ACTIONS: ActionDef[] = [
  def({
    name: "system.info",
    describe: "This device: OS, uptime, CPU, memory, free disk in the assistant's folders, GPU.",
    args: z.object({}).passthrough(),
    risk: () => "safe",
    summary: () => "Read system information",
    run: async (_a, ctx) => {
      const disks = roots(ctx.config).filter(existsSync).map((r) => {
        const s = statfsSync(r);
        return { path: r, freeGb: Math.round((s.bavail * s.bsize) / 1e8) / 10, totalGb: Math.round((s.blocks * s.bsize) / 1e8) / 10 };
      });
      const gpu = await runProcess({ command: "nvidia-smi", args: ["--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu", "--format=csv,noheader"], timeoutMs: 5000 });
      const info = {
        host: hostname(), os: `${platform()} ${release()}`, uptimeHours: Math.round(uptime() / 360) / 10,
        cpu: `${cpus().length} × ${cpus()[0]?.model ?? "?"}`, load: loadavg().map((x) => Math.round(x * 100) / 100),
        memoryGb: { free: Math.round(freemem() / 1e8) / 10, total: Math.round(totalmem() / 1e8) / 10 },
        disks, gpu: gpu.code === 0 ? gpu.stdout.trim() : undefined,
      };
      return { ok: true, output: JSON.stringify(info, null, 2), data: info };
    },
  }),
  def({
    name: "files.list",
    describe: "List a folder (inside the allowed folders).",
    args: z.object({ path: z.string().default(".") }),
    risk: () => "safe",
    summary: (a) => `List ${a.path}`,
    run: async (a, ctx) => {
      const dir = insideRoots(a.path, ctx.config);
      const entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => !isSecretPath(join(dir, e.name)))
        .slice(0, 500)
        .map((e) => {
          const p = join(dir, e.name);
          let size: number | undefined, mtime: string | undefined;
          try {
            const s = statSync(p);
            size = e.isFile() ? s.size : undefined;
            mtime = s.mtime.toISOString();
          } catch { /* unreadable entry */ }
          return { name: e.name, dir: e.isDirectory(), size, mtime };
        });
      return { ok: true, output: entries.map((e) => `${e.dir ? "📁" : "  "} ${e.name}${e.size !== undefined ? `  (${e.size} B)` : ""}`).join("\n") || "(empty)", data: { path: dir, entries } };
    },
  }),
  def({
    name: "files.find",
    describe: "Find files whose name contains a text, under a folder (inside the allowed folders).",
    args: z.object({ name: z.string().min(1), path: z.string().default("."), limit: z.number().int().min(1).max(200).default(50) }),
    risk: () => "safe",
    summary: (a) => `Find "${a.name}" under ${a.path}`,
    run: async (a, ctx) => {
      const start = insideRoots(a.path, ctx.config);
      const want = a.name.toLowerCase();
      const found: string[] = [];
      const skip = new Set(["node_modules", ".git", ".dart_tool", "__pycache__", ".venv", "build", "dist", ".next"]);
      const walk = (d: string, depth: number) => {
        if (found.length >= a.limit || depth > 8) return;
        let items;
        try {
          items = readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of items) {
          if (found.length >= a.limit) return;
          const p = join(d, e.name);
          if (isSecretPath(p)) continue;
          if (e.name.toLowerCase().includes(want)) found.push(p);
          if (e.isDirectory() && !skip.has(e.name)) walk(p, depth + 1);
        }
      };
      walk(start, 0);
      return { ok: true, output: found.join("\n") || "Nothing found.", data: found };
    },
  }),
  def({
    name: "files.read",
    describe: "Read a text file (up to 100 kB, inside the allowed folders).",
    args: PathArg,
    risk: () => "safe",
    summary: (a) => `Read ${a.path}`,
    run: async (a, ctx) => {
      const p = insideRoots(a.path, ctx.config);
      const buf = readFileSync(p);
      if (buf.subarray(0, 8000).includes(0)) return { ok: false, output: `${basename(p)} is not a text file` };
      return { ok: true, output: cap(buf.subarray(0, 100_000).toString("utf8"), ctx.config) };
    },
  }),
  def({
    name: "files.write",
    describe: "Write a text file. An existing file is backed up first (name.bak-<time>), never lost.",
    args: z.object({ path: z.string().min(1), content: z.string() }),
    risk: () => "ask",
    summary: (a) => {
      const head = a.content.replace(/\s+/g, " ").trim();
      return `Write ${a.content.length} characters to ${a.path}: "${head.slice(0, 160)}${head.length > 160 ? "…" : ""}"`;
    },
    run: async (a, ctx) => {
      const p = insideRoots(a.path, ctx.config, false);
      mkdirSync(dirname(p), { recursive: true });
      let note = "";
      if (existsSync(p)) {
        const bak = backupName(p, ctx.now?.() ?? new Date());
        copyFileSync(p, bak);
        note = ` (old version kept as ${basename(bak)})`;
      }
      writeFileSync(p, a.content);
      return { ok: true, output: `Wrote ${p}${note}` };
    },
  }),
  def({
    name: "files.copy",
    describe: "Copy a file. Refuses to replace an existing file.",
    args: z.object({ from: z.string().min(1), to: z.string().min(1) }),
    risk: () => "ask",
    summary: (a) => `Copy ${a.from} to ${a.to}`,
    run: async (a, ctx) => {
      const from = insideRoots(a.from, ctx.config);
      const to = insideRoots(a.to, ctx.config, false);
      if (existsSync(to)) return { ok: false, output: `${a.to} already exists; nothing was replaced` };
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      return { ok: true, output: `Copied to ${to}` };
    },
  }),
  def({
    name: "files.move",
    describe: "Move or rename a file or folder. Refuses to replace anything.",
    args: z.object({ from: z.string().min(1), to: z.string().min(1) }),
    risk: () => "ask",
    summary: (a) => `Move ${a.from} to ${a.to}`,
    run: async (a, ctx) => {
      const from = insideRoots(a.from, ctx.config);
      const to = insideRoots(a.to, ctx.config, false);
      if (existsSync(to)) return { ok: false, output: `${a.to} already exists; nothing was moved` };
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      return { ok: true, output: `Moved to ${to}` };
    },
  }),
  def({
    name: "shell.run",
    describe:
      "Run a command (PowerShell on Windows, bash elsewhere) in a folder inside the allowed folders. Safe-listed read-only commands run at once; anything else asks the owner.",
    args: z.object({ command: z.string().min(1).max(2000), cwd: z.string().optional(), timeoutSeconds: z.number().int().min(1).max(1800).optional() }),
    risk: (a, ctx) => shellRisk(a.command, ctx.config),
    summary: (a) => `Run: ${a.command}${a.cwd ? `  (in ${a.cwd})` : ""}`,
    run: async (a, ctx) => {
      const cwd = insideRoots(a.cwd ?? ".", ctx.config);
      const r = await sh(a.command, cwd, ctx, a.timeoutSeconds ? a.timeoutSeconds * 1000 : undefined);
      const out = [r.stdout.trim(), r.stderr.trim() && `stderr:\n${r.stderr.trim()}`].filter(Boolean).join("\n");
      const ok = r.code === 0 && !r.timedOut;
      return { ok, output: cap(`${out || "(no output)"}${r.timedOut ? "\n(timed out)" : ""}${!ok && !r.timedOut ? `\n(exit code ${r.code})` : ""}`, ctx.config), data: { code: r.code } };
    },
  }),
  def({
    name: "apps.list",
    describe: "The busiest running programs on this device.",
    args: z.object({}).passthrough(),
    risk: () => "safe",
    summary: () => "List running programs",
    run: async (_a, ctx) => {
      const cmd = platform() === "win32"
        ? "Get-Process | Sort-Object CPU -Descending | Select-Object -First 25 Name,Id,@{n='CPU';e={[int]$_.CPU}},@{n='MB';e={[int]($_.WorkingSet64/1MB)}} | Format-Table -AutoSize | Out-String -Width 200"
        : "ps -eo pid,comm,%cpu,rss --sort=-%cpu | head -26";
      const r = await sh(cmd, roots(ctx.config).find(existsSync) ?? homedir(), ctx, 20_000);
      return { ok: r.code === 0, output: cap(r.stdout.trim() || r.stderr.trim(), ctx.config) };
    },
  }),
  def({
    name: "apps.open",
    describe: "Open a file, folder, web address or program on this device's screen.",
    args: z.object({ target: z.string().min(1) }),
    risk: () => "ask",
    summary: (a) => `Open ${a.target}`,
    run: async (a, ctx) => {
      const t = a.target;
      const isUrl = /^https?:\/\//i.test(t);
      if (!isUrl && (t.includes("/") || t.includes("\\"))) insideRoots(t, ctx.config); // a path must be allowed
      const win = platform() === "win32";
      const r = win
        ? await runProcess({ command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $args[0]", t], timeoutMs: 20_000 })
        : await runProcess({ command: platform() === "darwin" ? "open" : "xdg-open", args: [t], timeoutMs: 20_000 });
      return { ok: r.code === 0, output: r.code === 0 ? `Opened ${t}` : redact(r.stderr.trim() || `could not open ${t}`) };
    },
  }),
  def({
    name: "ai.run",
    describe:
      "Give a task to one of the owner's AI tools on this device: claude (Claude Code), codex (ChatGPT), gemini (Antigravity / Gemini), perplexity, groq. write=false is read-only and runs at once; write=true lets it change files in `cwd` and asks first.",
    args: z.object({
      tool: z.string(),
      task: z.string().min(1),
      cwd: z.string().optional(),
      write: z.boolean().default(false),
      timeoutMinutes: z.number().min(1).max(120).default(20),
    }),
    risk: (a) => (a.write ? "ask" : "safe"),
    summary: (a) => `${a.write ? "Let" : "Ask"} ${a.tool} ${a.write ? "change files" : "(read-only)"}${a.cwd ? ` in ${a.cwd}` : ""}: ${a.task.slice(0, 160)}`,
    run: async (a, ctx) => {
      const provider = AI_TOOLS[a.tool.toLowerCase()];
      if (!provider) return { ok: false, output: `unknown AI tool ${a.tool}; use one of ${Object.keys(AI_TOOLS).join(", ")}` };
      if (!ctx.pool) return { ok: false, output: "AI tools are not available here" };
      const cwd = insideRoots(a.cwd ?? ".", ctx.config);
      const r = await ctx.pool.run(provider, {
        prompt: a.task,
        permission: a.write ? "edit" : "read",
        cwd,
        timeoutMs: a.timeoutMinutes * 60_000,
        signal: ctx.signal,
      });
      return { ok: r.ok, output: cap(r.ok ? r.text : `${provider} failed: ${r.error ?? "unknown error"}`, ctx.config), data: { provider, durationMs: r.durationMs } };
    },
  }),
  def({
    name: "memory.search",
    describe: "Search the shared memory from this device.",
    args: z.object({ query: z.string().min(1), kind: z.string().optional(), limit: z.number().int().min(1).max(30).default(8) }),
    risk: () => "safe",
    summary: (a) => `Search memory for ${a.query}`,
    run: async (a, ctx) => {
      if (!ctx.replica) return { ok: false, output: "shared memory is off on this device" };
      const hits = ctx.replica.search(a.query, { kind: a.kind, limit: a.limit });
      return { ok: true, output: hits.map((h) => `[${h.kind}] ${h.title} (${h.uid})`).join("\n") || "Nothing found.", data: hits };
    },
  }),
];

export const ACTION_NAMES = ACTIONS.map((a) => a.name);

export function findAction(name: string): ActionDef | undefined {
  return ACTIONS.find((a) => a.name === name);
}

/** The action's risk for these args, after the owner's config (`actions.safe`, `actions.never`). */
export function riskOf(d: ActionDef, args: unknown, ctx: ActionContext): Risk {
  const base = d.risk(args, ctx);
  if (base === "never" || ctx.config.actions.never.includes(d.name)) return "never";
  if (ctx.config.actions.safe.includes(d.name)) return "safe";
  return base;
}

