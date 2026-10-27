import type { Config } from "../config.js";
import type { ProviderRequest, ProviderResult, ProviderStatus } from "../types.js";
import { type Provider, failure, parseRetryAt } from "./base.js";

type PerplexityConfig = Config["providers"]["perplexity"];

/**
 * Perplexity Pro has no CLI, but Pro includes monthly API credit
 * (perplexity.ai/settings/api). Used for live web research with citations.
 */
export class PerplexityProvider implements Provider {
  readonly id = "perplexity" as const;
  constructor(private cfg: PerplexityConfig) {}

  async detect(): Promise<ProviderStatus> {
    const has = !!this.cfg.apiKey;
    return {
      id: this.id,
      installed: true,
      authenticated: has,
      detail: has ? `model ${this.cfg.model}` : "Optional. Set PERPLEXITY_API_KEY if you have API credit (billed separately from Pro); otherwise research uses Claude, ChatGPT and Gemini web search.",
    };
  }

  async run(req: ProviderRequest): Promise<ProviderResult> {
    const started = Date.now();
    const model = req.model ?? this.cfg.model;
    if (!this.cfg.apiKey) return failure(this.id, started, "PERPLEXITY_API_KEY not set", model);

    const timeout = AbortSignal.timeout(req.timeoutMs ?? 10 * 60_000);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const messages = [
      ...(req.system ? [{ role: "system", content: req.system }] : []),
      { role: "user", content: req.prompt },
    ];

    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.cfg.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, stream: true }),
        signal,
      });
    } catch (e) {
      return failure(this.id, started, (e as Error).message, model);
    }
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      const r = failure(this.id, started, `HTTP ${res.status}: ${body.slice(0, 500)}`, model);
      if (res.status === 429) {
        r.rateLimited = true;
        const after = Number(res.headers.get("retry-after"));
        r.retryAt = after ? Date.now() + after * 1000 : parseRetryAt(body);
      }
      return r;
    }

    let text = "";
    let citations: string[] = [];
    let usage: any;
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
            if (Array.isArray(ev.citations)) citations = ev.citations;
            if (Array.isArray(ev.search_results)) citations = ev.search_results.map((s: any) => s.url).filter(Boolean);
            if (ev.usage) usage = ev.usage;
          } catch {
            /* partial line */
          }
        }
      }
    } catch (e) {
      if (!text) return failure(this.id, started, (e as Error).message, model);
    }

    if (citations.length) text += "\n\nSources:\n" + citations.map((c, n) => `[${n + 1}] ${c}`).join("\n");
    return {
      ok: !!text,
      text,
      provider: this.id,
      model,
      durationMs: Date.now() - started,
      citations,
      usage: { inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens, costUsd: usage?.cost?.total_cost },
      error: text ? undefined : "empty response",
    };
  }
}
