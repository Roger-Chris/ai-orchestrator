import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "../config.js";
import type { Permission, ProviderRequest, ProviderResult, ProviderStatus } from "../types.js";
import { type Provider, failure, outcomeError, probeVersion, runProcess, tryParseJson, withSystem } from "./base.js";

function approvalArgs(p: Permission): string[] {
  return ["--approval-mode", p === "full" ? "yolo" : p === "edit" ? "auto_edit" : "plan"];
}

/** Whether the Gemini CLI has a login (Google account OAuth or an API key). */
export function geminiAuthState(home = homedir()): { ok: boolean; how?: string } {
  if (process.env.GEMINI_API_KEY) return { ok: true, how: "GEMINI_API_KEY" };
  if (process.env.GOOGLE_GENAI_USE_GCA || process.env.GOOGLE_GENAI_USE_VERTEXAI) return { ok: true, how: "env" };
  const dir = join(home, ".gemini");
  let selected: string | undefined;
  try {
    const s = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    selected = s?.security?.auth?.selectedType ?? s?.selectedAuthType;
  } catch {
    /* no settings yet */
  }
  if (selected && existsSync(join(dir, "oauth_creds.json"))) return { ok: true, how: selected };
  return { ok: false };
}

/**
 * The Antigravity CLI (`agy`). Since June 2026 Google AI Pro/Ultra plans only work through it;
 * the Gemini CLI's Google sign-in is rejected for personal accounts.
 */
export function findAgy(home = homedir()): string | undefined {
  const candidates =
    process.platform === "win32"
      ? [join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "agy", "bin", "agy.exe")]
      : [join(home, ".local", "bin", "agy"), "/opt/homebrew/bin/agy", "/usr/local/bin/agy"];
  return candidates.find((p) => existsSync(p));
}

/** Google AI Pro via the Antigravity CLI (`agy -p`), or the legacy Gemini CLI as a fallback. */
export class GeminiProvider implements Provider {
  readonly id = "gemini" as const;
  constructor(private cfg: ProviderConfig) {}

  private get command() {
    if (this.cfg.command && this.cfg.command !== "auto") return this.cfg.command;
    return findAgy() ?? "gemini";
  }

  private get isAgy() {
    return /(^|[\\/])agy(\.exe|\.cmd)?$/i.test(this.command);
  }

  async detect(): Promise<ProviderStatus> {
    const version = await probeVersion(this.command);
    if (this.isAgy || !version) {
      return {
        id: this.id,
        installed: !!version,
        // agy keeps its login in the OS keychain; `orc doctor --live` makes a real call to check it.
        authenticated: !!version,
        command: this.command,
        version,
        detail: version
          ? "Antigravity CLI. If calls fail with `authentication required`, run `agy` once and sign in with Google."
          : "Install the Antigravity CLI (https://antigravity.google/docs/getting-started), then run `agy` once and sign in with your Google AI Pro account.",
      };
    }
    const found = geminiAuthState();
    // Google rejects personal-account sign-in in the Gemini CLI since June 2026.
    const auth = found.how === "oauth-personal" ? { ok: false } : found;
    return {
      id: this.id,
      installed: !!version,
      authenticated: !!version && auth.ok,
      command: this.command,
      version,
      detail: !auth.ok
        ? "Gemini CLI Google sign-in no longer works for Google AI Pro. Install the Antigravity CLI (agy) or set GEMINI_API_KEY."
        : `legacy Gemini CLI, auth: ${auth.how}`,
    };
  }

  /** Prompt goes on stdin as one stream-json message, so long prompts avoid the Windows command-line limit. */
  buildAgyArgs(req: ProviderRequest): string[] {
    // -p takes a value; an empty one keeps headless mode while the real prompt comes from stdin.
    const args = ["-p=", "--input-format", "stream-json", "--output-format", "stream-json"];
    // agy has no per-tool "edit only" mode: edit/full auto-approve, read leaves tool calls unapproved.
    if (req.permission === "edit" || req.permission === "full") args.push("--dangerously-skip-permissions");
    const model = req.model ?? this.cfg.model;
    if (model) args.push("--model", model);
    if (req.deep) args.push("--effort", "high");
    if (req.timeoutMs) args.push("--print-timeout", `${Math.ceil(req.timeoutMs / 60_000)}m`);
    args.push(...this.cfg.extraArgs);
    return args;
  }

  async run(req: ProviderRequest): Promise<ProviderResult> {
    return this.isAgy ? this.runAgy(req) : this.runGeminiCli(req);
  }

  private async runAgy(req: ProviderRequest): Promise<ProviderResult> {
    const started = Date.now();
    let text = "";
    let model: string | undefined = req.model ?? this.cfg.model;
    let result: any;

    const outcome = await runProcess({
      command: this.command,
      args: this.buildAgyArgs(req),
      stdin: JSON.stringify({ event: "user", message: { content: withSystem(req) } }) + "\n",
      cwd: req.cwd,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      onLine: (line) => {
        const ev = tryParseJson(line);
        if (!ev) return;
        if (ev.event === "init") model = ev.init?.model ?? model;
        else if (ev.event === "step_update") {
          const s = ev.step_update ?? {};
          if (s.step_type === "agent_response" && s.text_delta) {
            text += s.text_delta;
            req.onDelta?.(s.text_delta);
          } else if (s.step_type === "tool" && s.state === "ACTIVE" && s.tool_name) req.onProgress?.(s.tool_name);
        } else if (ev.event === "result") result = ev.result ?? ev;
      },
    });

    const answer = (typeof result?.response === "string" && result.response) || text;
    // WAITING means it stopped at a tool approval (read-only runs); keep whatever it answered.
    const okStatus = result?.status === "SUCCESS" || (result?.status === "WAITING" && answer);
    if (okStatus && answer && !outcome.timedOut && !outcome.aborted) {
      return {
        ok: true,
        text: answer,
        provider: this.id,
        model,
        durationMs: Date.now() - started,
        usage: { inputTokens: result?.usage?.input_tokens, outputTokens: result?.usage?.output_tokens },
      };
    }
    const err = result?.error;
    const msg = (typeof err === "string" ? err : err?.message) ?? (result?.status ? `status ${result.status}` : outcomeError(outcome));
    return failure(this.id, started, String(msg), model);
  }

  buildArgs(req: ProviderRequest): string[] {
    // The real prompt arrives on stdin; -p switches to headless mode and is appended to it.
    const args = ["-p", "Follow the instructions above.", "-o", "stream-json", "--skip-trust", ...approvalArgs(req.permission ?? "read")];
    const model = req.model ?? this.cfg.model;
    if (model) args.push("-m", model);
    args.push(...this.cfg.extraArgs);
    return args;
  }

  private async runGeminiCli(req: ProviderRequest): Promise<ProviderResult> {
    const started = Date.now();
    let text = "";
    let model: string | undefined = req.model ?? this.cfg.model;
    let result: any;
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
        if (ev.type === "init") model = ev.model ?? model;
        else if (ev.type === "message" && ev.role === "assistant" && ev.content) {
          text += ev.content;
          req.onDelta?.(ev.content);
        } else if (ev.type === "tool_use") req.onProgress?.(`${ev.tool_name ?? "tool"}`);
        else if (ev.type === "error" && ev.severity !== "warning") fatal = ev.message;
        else if (ev.type === "result") result = ev;
        else if (!ev.type && ev.error) fatal = ev.error.message ?? JSON.stringify(ev.error);
      },
    });

    const failed = fatal || (result && result.status && result.status !== "success") || !text;
    if (!failed && !outcome.timedOut && !outcome.aborted) {
      return {
        ok: true,
        text,
        provider: this.id,
        model,
        durationMs: Date.now() - started,
        usage: { inputTokens: result?.stats?.input_tokens, outputTokens: result?.stats?.output_tokens },
      };
    }
    const msg = fatal ?? result?.error?.message ?? outcomeError(outcome);
    return failure(this.id, started, msg, model);
  }
}
