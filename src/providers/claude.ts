import type { ProviderConfig } from "../config.js";
import type { LimitWindow, Permission, ProviderRequest, ProviderResult, ProviderStatus } from "../types.js";
import { type Provider, failure, outcomeError, probeVersion, resolveCommand, runProcess, tryParseJson } from "./base.js";

/** Trims ~10k tokens of plugin/skill/MCP context from every call. Override with extraArgs. */
const LEAN_ARGS = ["--disable-slash-commands", "--strict-mcp-config", "--no-session-persistence"];
const READ_TOOLS = "Read,Grep,Glob,WebSearch,WebFetch";

function permissionArgs(p: Permission): string[] {
  if (p === "full") return ["--dangerously-skip-permissions"];
  if (p === "edit") return ["--permission-mode", "acceptEdits"];
  return ["--allowedTools", READ_TOOLS];
}

/** Claude Pro/Max via the Claude Code CLI (`claude -p`), logged in with your subscription. */
export class ClaudeProvider implements Provider {
  readonly id = "claude" as const;
  constructor(private cfg: ProviderConfig) {}

  private get command() {
    return resolveCommand(this.cfg, "claude");
  }

  async detect(): Promise<ProviderStatus> {
    const version = await probeVersion(this.command);
    return {
      id: this.id,
      installed: !!version,
      // Claude Code keeps auth in the OS keychain; a real call is the only reliable check (see `orc doctor`).
      authenticated: !!version,
      command: this.command,
      version,
      detail: version ? undefined : "Install: npm i -g @anthropic-ai/claude-code, then run `claude` once and log in with your Claude account.",
    };
  }

  buildArgs(req: ProviderRequest): string[] {
    const args = ["-p", "--output-format", "stream-json", "--verbose", ...LEAN_ARGS];
    const model = req.model ?? this.cfg.model;
    if (model) args.push("--model", model);
    if (req.system && req.system.length < 8000) args.push("--append-system-prompt", req.system);
    args.push(...permissionArgs(req.permission ?? "read"), ...this.cfg.extraArgs);
    return args;
  }

  async run(req: ProviderRequest): Promise<ProviderResult> {
    const started = Date.now();
    const inlineSystem = req.system && req.system.length >= 8000;
    const stdin = inlineSystem ? `<instructions>\n${req.system}\n</instructions>\n\n${req.prompt}` : req.prompt;

    let text = "";
    let final: any;
    let limits: LimitWindow[] | undefined;
    const outcome = await runProcess({
      command: this.command,
      args: this.buildArgs(req),
      stdin,
      cwd: req.cwd,
      timeoutMs: req.timeoutMs,
      signal: req.signal,
      onLine: (line) => {
        const ev = tryParseJson(line);
        if (!ev) return;
        if (ev.type === "assistant") {
          for (const block of ev.message?.content ?? []) {
            if (block.type === "text" && block.text) {
              text += (text ? "\n" : "") + block.text;
              req.onDelta?.(block.text);
            } else if (block.type === "tool_use") {
              req.onProgress?.(`${block.name} ${summarizeInput(block.input)}`);
            }
          }
        } else if (ev.type === "rate_limit_event") {
          limits = claudeLimits(ev.rate_limit_info) ?? limits;
        } else if (ev.type === "result") {
          final = ev;
        }
      },
    });

    const model = req.model ?? this.cfg.model;
    if (final && !final.is_error) {
      return {
        ok: true,
        text: typeof final.result === "string" && final.result ? final.result : text,
        provider: this.id,
        model: mainModel(final.modelUsage) ?? model,
        durationMs: Date.now() - started,
        usage: {
          inputTokens: final.usage?.input_tokens,
          outputTokens: final.usage?.output_tokens,
          costUsd: final.total_cost_usd,
          limits,
        },
      };
    }
    const msg = final?.result || final?.error || outcomeError(outcome);
    return { ...failure(this.id, started, String(msg), model), usage: limits && { limits } };
  }
}

/** The plan's own windows from Claude Code's `rate_limit_event`: {five_hour: {utilization: 0.02, resetsAt: <seconds>}, …}. */
export function claudeLimits(info: any): LimitWindow[] | undefined {
  const windows = Object.entries((info?.unifiedWindows ?? {}) as Record<string, { utilization?: number; resetsAt?: number }>).filter(([, w]) => typeof w?.utilization === "number");
  if (!windows.length) return undefined;
  const names: Record<string, string> = { five_hour: "5 hours", seven_day: "7 days" };
  return windows.map(([k, w]) => ({ label: names[k] ?? k.replace(/_/g, " "), usedPercent: Math.round(w.utilization! * 100), resetsAt: w.resetsAt ? w.resetsAt * 1000 : undefined }));
}

/** Claude Code also uses small helper models; the answer comes from the one that wrote the most. */
export function mainModel(usage?: Record<string, { outputTokens?: number }>): string | undefined {
  const entries = Object.entries(usage ?? {});
  entries.sort((a, b) => (b[1].outputTokens ?? 0) - (a[1].outputTokens ?? 0));
  return entries[0]?.[0];
}

export function summarizeInput(input: any): string {
  if (!input || typeof input !== "object") return "";
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? "";
  return String(v).slice(0, 120);
}
