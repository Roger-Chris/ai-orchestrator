import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "../config.js";
import type { LimitWindow, Permission, ProviderRequest, ProviderResult, ProviderStatus } from "../types.js";
import { type Provider, failure, outcomeError, probeVersion, resolveCommand, runProcess, tryParseJson, withSystem } from "./base.js";

function sandboxArgs(p: Permission): string[] {
  if (p === "full") return ["--dangerously-bypass-approvals-and-sandbox"];
  return ["-s", p === "edit" ? "workspace-write" : "read-only"];
}

/**
 * The Codex desktop app on Windows ships a newer CLI than npm often has, and
 * older CLIs reject current models for ChatGPT-plan accounts. Prefer it.
 */
export function findDesktopCodex(): string | undefined {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return undefined;
  const root = join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  if (!existsSync(root)) return undefined;
  const candidates = readdirSync(root)
    .map((d) => join(root, d, "codex.exe"))
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0];
}

/** ChatGPT Plus/Pro via the Codex CLI (`codex exec`), logged in with your ChatGPT account. */
export class CodexProvider implements Provider {
  readonly id = "codex" as const;
  private resolved?: string;
  constructor(private cfg: ProviderConfig) {}

  private get command() {
    this.resolved ??= resolveCommand(this.cfg, findDesktopCodex() ?? "codex");
    return this.resolved;
  }

  async detect(): Promise<ProviderStatus> {
    const version = await probeVersion(this.command);
    const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const authenticated = existsSync(join(codexHome, "auth.json"));
    return {
      id: this.id,
      installed: !!version,
      authenticated: !!version && authenticated,
      command: this.command,
      version,
      detail: !version
        ? "Install: npm i -g @openai/codex@latest, then run `codex login` and choose Sign in with ChatGPT."
        : !authenticated
          ? "Run `codex login` and choose Sign in with ChatGPT."
          : undefined,
    };
  }

  buildArgs(req: ProviderRequest): string[] {
    const args = ["exec", "--json", "--skip-git-repo-check", ...sandboxArgs(req.permission ?? "read")];
    // Without this Codex used the owner's MCP servers (the orchestrator's own) and shell for the brain's
    // JSON steps, then answered "that tool needs approval / isn't available" instead of the next step.
    if (req.plain) args.push("--ignore-user-config", "--ephemeral");
    const model = req.model ?? this.cfg.model;
    if (model) args.push("-m", model);
    if (req.cwd) args.push("-C", req.cwd);
    args.push(...this.cfg.extraArgs, "-");
    return args;
  }

  async run(req: ProviderRequest): Promise<ProviderResult> {
    const started = Date.now();
    const messages: string[] = [];
    let usage: any;
    let fatal: string | undefined;

    const outcome = await runProcess({
      command: this.command,
      args: this.buildArgs(req),
      stdin: withSystem(req),
      cwd: req.cwd,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      onLine: (line) => {
        const ev = tryParseJson(line);
        if (!ev) return;
        if (ev.type === "item.completed" || ev.type === "item.started") {
          const item = ev.item ?? {};
          if (ev.type === "item.completed" && item.type === "agent_message" && item.text) {
            messages.push(item.text);
            req.onDelta?.(item.text);
          } else if (ev.type === "item.started" && item.type === "command_execution") {
            req.onProgress?.(`run ${String(item.command ?? "").slice(0, 120)}`);
          } else if (ev.type === "item.completed" && item.type === "file_change") {
            req.onProgress?.(`edit ${(item.changes ?? []).map((c: any) => c.path).join(", ")}`);
          }
        } else if (ev.type === "turn.completed") {
          usage = ev.usage;
        } else if (ev.type === "turn.failed") {
          fatal = ev.error?.message ?? "turn failed";
        } else if (ev.type === "error") {
          fatal = ev.message ?? "error";
        }
      },
    });

    const model = req.model ?? this.cfg.model;
    if (!fatal && messages.length && !outcome.timedOut && !outcome.aborted) {
      return {
        ok: true,
        // Codex narrates as it works; the last message is the answer.
        text: messages[messages.length - 1],
        provider: this.id,
        model,
        durationMs: Date.now() - started,
        // Codex counts cached input inside input_tokens; Claude does not, and the totals should mean the same.
        usage: { inputTokens: usage?.input_tokens === undefined ? undefined : usage.input_tokens - (usage.cached_input_tokens ?? 0), outputTokens: usage?.output_tokens, limits: codexLimits(started) },
      };
    }
    return failure(this.id, started, extractApiMessage(fatal) ?? outcomeError(outcome), model);
  }
}

/**
 * `codex exec --json` does not report the plan's limits, but the session file it writes does
 * (`token_count` events with `rate_limits`). The newest file, if it was written during this run.
 */
export function codexLimits(since: number, home = process.env.CODEX_HOME ?? join(homedir(), ".codex")): LimitWindow[] | undefined {
  try {
    let dir = join(home, "sessions");
    for (let i = 0; i < 3; i++) dir = join(dir, readdirSync(dir).sort().at(-1)!); // sessions/<year>/<month>/<day>
    const file = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    const { size, mtimeMs } = statSync(file);
    if (mtimeMs < since) return undefined;
    const length = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(length);
    const fd = openSync(file, "r");
    readSync(fd, buf, 0, length, size - length);
    closeSync(fd);
    for (const line of buf.toString("utf8").split("\n").reverse()) {
      if (!line.includes('"rate_limits"')) continue;
      const rl = tryParseJson(line)?.payload?.rate_limits;
      const windows = [rl?.primary, rl?.secondary].filter((w) => typeof w?.used_percent === "number");
      if (windows.length) return windows.map((w) => ({ label: windowLabel(w.window_minutes), usedPercent: Math.round(w.used_percent), resetsAt: w.resets_at ? w.resets_at * 1000 : undefined }));
    }
  } catch {
    /* no session files here: the limits are simply unknown */
  }
  return undefined;
}

const windowLabel = (minutes?: number) => (!minutes ? "limit" : minutes >= 1440 ? `${Math.round(minutes / 1440)} days` : `${Math.round(minutes / 60)} hours`);

/** Codex wraps API errors as JSON inside the message string; surface the readable part. */
function extractApiMessage(s?: string): string | undefined {
  if (!s) return undefined;
  const inner = tryParseJson(s);
  return inner?.error?.message ?? s;
}
