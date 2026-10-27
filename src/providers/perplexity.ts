import type { Config } from "../config.js";
import type { ProviderResult } from "../types.js";
import { OpenAICompatProvider, type RunExtras } from "./openai-compat.js";

type PerplexityConfig = Config["providers"]["perplexity"];

/**
 * Perplexity Pro has no CLI, but Pro includes monthly API credit
 * (perplexity.ai/settings/api). Used for live web research with citations.
 */
export class PerplexityProvider extends OpenAICompatProvider {
  constructor(cfg: PerplexityConfig) {
    super(
      "perplexity",
      cfg,
      "Optional. Set PERPLEXITY_API_KEY if you have API credit (billed separately from Pro); otherwise research uses Claude, ChatGPT and Gemini web search.",
    );
  }

  protected override onEvent(ev: any, extras: RunExtras) {
    if (Array.isArray(ev.citations)) extras.citations = ev.citations;
    if (Array.isArray(ev.search_results)) extras.citations = ev.search_results.map((s: any) => s.url).filter(Boolean);
  }

  protected override finish(r: ProviderResult, extras: RunExtras): ProviderResult {
    const citations: string[] = extras.citations ?? [];
    if (!citations.length) return r;
    return { ...r, citations, text: `${r.text}\n\nSources:\n${citations.map((c, n) => `[${n + 1}] ${c}`).join("\n")}` };
  }
}
