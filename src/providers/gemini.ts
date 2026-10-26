import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderConfig } from "../config.js";
import type { Permission, ProviderRequest, ProviderResult, ProviderStatus } from "../types.js";
import { type Provider, failure, outcomeError, probeVersion, resolveCommand, runProcess, tryParseJson, withSystem } from "./base.js";

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

/** Google AI Pro via the Gemini CLI (`gemini -p`), logged in with your Google account. */
export class GeminiProvider implements Provider {
  readonly id = "gemini" as const;
  constructor(private cfg: ProviderConfig) {}

  private get command() {
    return resolveCommand(this.cfg, "gemini");
  }

  async detect(): Promise<ProviderStatus> {
    const version = await probeVersion(this.command);
    const auth = geminiAuthState();
    return {
      id: this.id,
      installed: !!version,
      authenticated: !!version && auth.ok,
      command: this.command,
      version,
      detail: !version
        ? "Install: npm i -g @google/gemini-cli"
        : !auth.ok
          ? "Run `gemini` once in a terminal and choose Login with Google (uses your Google AI Pro plan)."
          : `auth: ${auth.how}`,
    };
  }

  buildArgs(req: ProviderRequest): string[] {
    // The real prompt arrives on stdin; -p switches to headless mode and is appended to it.
    const args = ["-p", "Follow the instructions above.", "-o", "stream-json", "--skip-trust", ...approvalArgs(req.permission ?? "read")];
    const model = req.model ?? this.cfg.model;
    if (model) args.push("-m", model);
    args.push(...this.cfg.extraArgs);
    return args;
  }

  async run(req: ProviderRequest): Promise<ProviderResult> {
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
