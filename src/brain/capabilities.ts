import type { ProviderId, TaskKind } from "../types.js";

type Matrix = Record<TaskKind, Record<ProviderId, number>>;

/**
 * How good each subscription is at each kind of work, 0..10.
 * A starting point: override per kind in config (routing.overrides) and the
 * brain also learns from your ratings. Notes on the reasoning:
 * - Claude: strongest agentic coder/architect, best long-form writing.
 * - Codex (ChatGPT): strong reasoning/math and code; Go/Plus plan limits are
 *   tighter, which the router handles via load + cooldowns.
 * - Gemini: huge context window, native multimodal, fast, Google grounding.
 * - Perplexity: live web search with citations; cannot edit files.
 * - Groq: open models on a fast API; answers in about a second, so it takes quick
 *   questions. Weaker at hard reasoning and code, no web, cannot edit files.
 *   (Gemini through the Antigravity CLI is slow to start, so it no longer leads on quick.)
 * - Local (Ollama, e.g. qwen3:8b): free and private but small and slow on a CPU; a last resort
 *   and fine for short writing. Cannot edit files.
 * - Manus: a cloud agent (its own browser and computer) that takes minutes and Manus credits per task.
 *   0 everywhere: the router never picks it by itself; it runs when you ask for it by name.
 */
export const BASE_CAPABILITIES: Matrix = {
  system_design: { claude: 9.5, codex: 8.5, gemini: 8.5, perplexity: 4, groq: 5, local: 4, manus: 0 },
  ui_ux: { claude: 9, codex: 7.5, gemini: 8.5, perplexity: 3, groq: 4, local: 3.5, manus: 0 },
  coding: { claude: 9.5, codex: 9, gemini: 8, perplexity: 2, groq: 6.5, local: 5, manus: 0 },
  debugging: { claude: 9.5, codex: 9, gemini: 7.5, perplexity: 2, groq: 5.5, local: 4.5, manus: 0 },
  code_review: { claude: 9, codex: 9, gemini: 8, perplexity: 2, groq: 6, local: 5, manus: 0 },
  reasoning: { claude: 9, codex: 9.5, gemini: 9, perplexity: 5, groq: 7, local: 5.5, manus: 0 },
  math: { claude: 8.5, codex: 9.5, gemini: 9, perplexity: 4, groq: 7.5, local: 5.5, manus: 0 },
  research: { claude: 6.5, codex: 5.5, gemini: 7.5, perplexity: 10, groq: 3, local: 2, manus: 0 },
  writing: { claude: 9.5, codex: 8, gemini: 8.5, perplexity: 6, groq: 7, local: 6, manus: 0 },
  long_context: { claude: 8.5, codex: 7, gemini: 10, perplexity: 3, groq: 5, local: 3, manus: 0 },
  multimodal: { claude: 7.5, codex: 7.5, gemini: 10, perplexity: 2, groq: 1, local: 1, manus: 0 },
  pcb_design: { claude: 8.5, codex: 8.5, gemini: 7.5, perplexity: 4, groq: 4, local: 3, manus: 0 },
  cad_3d: { claude: 8.5, codex: 8.5, gemini: 8, perplexity: 2, groq: 3, local: 2, manus: 0 },
  data_analysis: { claude: 8.5, codex: 9, gemini: 9, perplexity: 4, groq: 6.5, local: 5, manus: 0 },
  quick: { claude: 7, codex: 6.5, gemini: 7, perplexity: 7, groq: 9.5, local: 6.5, manus: 0 },
};

/** Providers that can act on a filesystem (run tools, edit files). */
/** Paid per task and slow: never chosen by a router on its own, only when asked for by name (pinned / overridden / your pick). */
export const ONLY_WHEN_ASKED: ProviderId[] = ["manus"];

// Manus is an agent too, but in its own cloud: it never gets this device's files or branches.
export const AGENTIC: Record<ProviderId, boolean> = { claude: true, codex: true, gemini: true, perplexity: false, groq: false, local: false, manus: false };

/** Kinds where the provider's "deep" model is worth the extra quota. */
export const DEEP_KINDS: TaskKind[] = ["system_design", "reasoning", "math", "debugging", "pcb_design"];

export type CapabilityMatrix = Matrix;

export function buildCapabilities(overrides: Record<string, Record<string, number>> = {}): Matrix {
  const m = structuredClone(BASE_CAPABILITIES);
  for (const [kind, row] of Object.entries(overrides)) {
    if (!(kind in m)) continue;
    for (const [prov, score] of Object.entries(row)) {
      if (prov in m[kind as TaskKind]) m[kind as TaskKind][prov as ProviderId] = score;
    }
  }
  return m;
}

export function describeCapabilities(m: Matrix): string {
  return (Object.keys(m) as TaskKind[])
    .map((k) => {
      const best = (Object.entries(m[k]) as [ProviderId, number][]).sort((a, b) => b[1] - a[1]).slice(0, 2);
      return `${k}: ${best.map(([p, s]) => `${p} ${s}`).join(", ")}`;
    })
    .join("\n");
}
