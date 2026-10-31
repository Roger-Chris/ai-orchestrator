import type { LimitWindow, ProviderId, ProviderRequest, ProviderResult, ProviderStatus } from "../types.js";
import { type Provider, failure, parseRetryAt } from "./base.js";

/** What any OpenAI-compatible chat API needs: where it is, the key(s) and the models. */
export interface OpenAICompatConfig {
  baseUrl: string;
  apiKey?: string;
  /** More keys to rotate through: when one hits its limit or is rejected, the next is used. */
  apiKeys?: string[];
  model: string;
  deepModel?: string;
}

/** A rejected key (revoked, typo) is retried after this long, in case it was a passing problem. */
const BAD_KEY_MS = 60 * 60_000;

/** Per-run scratch space for service-specific extras (e.g. citations). */
export type RunExtras = Record<string, any>;

/**
 * A model behind an OpenAI-compatible `/chat/completions` API (Groq, Perplexity, and the
 * same shape for OpenRouter, Mistral or Cloudflare). Answers stream back; it cannot touch
 * files, so the router never gives it workspace steps.
 */
export class OpenAICompatProvider implements Provider {
  private keys: string[];
  /** Key index → when it may be used again. */
  private resting = new Map<number, number>();
  /** Where the next request starts, so keys share the load. */
  private next = 0;

  constructor(
    readonly id: ProviderId,
    protected cfg: OpenAICompatConfig,
    /** Shown in `orc doctor` and the app when the key is missing. */
    private missingKey: string,
  ) {
    this.keys = [...new Set([...(cfg.apiKeys ?? []), cfg.apiKey].map((k) => k?.trim()).filter((k): k is string => !!k))];
  }

  async detect(): Promise<ProviderStatus> {
    const n = this.keys.length;
    return { id: this.id, installed: true, authenticated: n > 0, detail: n ? `model ${this.cfg.model}${n > 1 ? `, ${n} keys in rotation` : ""}` : this.missingKey };
  }

  /** Keys to try for one request: the ones not resting, starting with the next in turn. */
  private order(): number[] {
    const now = Date.now();
    const n = this.keys.length;
    const start = this.next++ % n;
    return Array.from({ length: n }, (_, i) => (start + i) % n).filter((k) => (this.resting.get(k) ?? 0) <= now);
  }

  /** Extra fields a service sends on stream events; none by default. */
  protected onEvent(_ev: any, _extras: RunExtras) {}

  /** Last touch on a finished answer. */
  protected finish(result: ProviderResult, _extras: RunExtras): ProviderResult {
    return result;
  }

  async run(req: ProviderRequest): Promise<ProviderResult> {
    const started = Date.now();
    const model = req.model ?? (req.deep && this.cfg.deepModel ? this.cfg.deepModel : this.cfg.model);
    if (!this.keys.length) return failure(this.id, started, this.missingKey, model);

    const timeout = AbortSignal.timeout(req.timeoutMs ?? 10 * 60_000);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const messages = [...(req.system ? [{ role: "system", content: req.system }] : []), { role: "user", content: req.prompt }];

    // Try each usable key until one is accepted; a limit or a rejected key moves on to the next.
    let res: Response | undefined;
    let last: ProviderResult | undefined;
    let limited = false;
    for (const k of this.order()) {
      try {
        res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.keys[k]}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages, stream: true }),
          signal,
        });
      } catch (e) {
        return failure(this.id, started, (e as Error).message, model);
      }
      if (res.ok && res.body) break;
      const status = res.status;
      const after = Number(res.headers.get("retry-after"));
      const body = await res.text().catch(() => "");
      res = undefined;
      last = failure(this.id, started, `HTTP ${status}${this.keys.length > 1 ? ` (key ${k + 1} of ${this.keys.length})` : ""}: ${body.slice(0, 500)}`, model);
      if (status === 429) {
        limited = true;
        this.resting.set(k, after ? Date.now() + after * 1000 : (parseRetryAt(body) ?? Date.now() + 60_000));
      } else if (status === 401 || status === 403) {
        this.resting.set(k, Date.now() + BAD_KEY_MS);
      } else {
        return last; // a problem with the request or the service, not the key
      }
    }
    if (!res) {
      const r = last ?? failure(this.id, started, `all ${this.keys.length} API keys are resting after limits or rejections`, model);
      const back = [...this.resting.values()].filter((t) => t > Date.now());
      // No key left to try: when a limit was involved, tell the pool when the first key comes back.
      if (back.length && (limited || !last)) Object.assign(r, { rateLimited: true, retryAt: Math.min(...back) });
      return r;
    }

    let text = "";
    let usage: any;
    const extras: RunExtras = {};
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const ev = JSON.parse(data);
            const delta = ev.choices?.[0]?.delta?.content;
            if (delta) {
              text += delta;
              req.onDelta?.(delta);
            }
            // Groq puts usage under x_groq on the last chunk; others at the top level.
            if (ev.usage ?? ev.x_groq?.usage) usage = ev.usage ?? ev.x_groq.usage;
            this.onEvent(ev, extras);
          } catch {
            /* partial line */
          }
        }
      }
    } catch (e) {
      if (!text) return failure(this.id, started, (e as Error).message, model);
    }

    const result: ProviderResult = {
      ok: !!text,
      text,
      provider: this.id,
      model,
      durationMs: Date.now() - started,
      usage: { inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens, costUsd: usage?.cost?.total_cost, limits: headerLimits(res.headers) },
      error: text ? undefined : "empty response",
    };
    return text ? this.finish(result, extras) : result;
  }
}

/** "2m59.5s", "7.66s", "1h2m": how long until a limit resets, in a service's rate-limit headers. */
function resetMs(s: string | null): number | undefined {
  if (!s) return undefined;
  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  const parts = [...s.matchAll(/([\d.]+)(ms|h|m|s)/g)];
  return parts.length ? parts.reduce((t, [, n, u]) => t + Number(n) * unit[u], 0) : undefined;
}

/** The x-ratelimit-* headers (Groq), for the key that answered. */
export function headerLimits(h: Headers, now = Date.now()): LimitWindow[] | undefined {
  const windows = (["tokens", "requests"] as const).flatMap((label) => {
    const limit = Number(h.get(`x-ratelimit-limit-${label}`));
    const left = Number(h.get(`x-ratelimit-remaining-${label}`));
    if (!limit || !Number.isFinite(left) || h.get(`x-ratelimit-remaining-${label}`) === null) return [];
    const reset = resetMs(h.get(`x-ratelimit-reset-${label}`));
    return [{ label, usedPercent: Math.round((1 - left / limit) * 100), resetsAt: reset === undefined ? undefined : now + reset }];
  });
  return windows.length ? windows : undefined;
}
