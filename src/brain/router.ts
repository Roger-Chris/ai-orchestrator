import type { ProviderId, TaskKind } from "../types.js";
import { AGENTIC, type CapabilityMatrix, ONLY_WHEN_ASKED } from "./capabilities.js";

/** A provider on a specific device that could run a step. */
export interface Candidate {
  node: string;
  provider: ProviderId;
  local: boolean;
  /** 0 = idle, 1 = at its concurrency limit, >1 = queued. */
  load: number;
  /** Device takes coding steps on git branches. */
  branchWork?: boolean;
}

export interface RouteRequest {
  kind: TaskKind;
  needsWorkspace?: boolean;
  /** Step edits code on its own git branch: any device that accepts branch work will do. */
  branchWork?: boolean;
  needsWeb?: boolean;
  /** Agent's preferred providers, best first. */
  prefer?: ProviderId[];
  /** Providers that must not be used (e.g. the author of code under review). */
  exclude?: ProviderId[];
  /** Hard pin. */
  pin?: ProviderId;
  nodes?: string[];
}

export interface Scored extends Candidate {
  score: number;
  why: string;
}

export interface FeedbackSource {
  feedbackStats(kind: TaskKind): Partial<Record<ProviderId, { up: number; down: number }>>;
}

export class Router {
  constructor(
    readonly caps: CapabilityMatrix,
    private opts: { localBias: number; learn: boolean },
    private feedback?: FeedbackSource,
  ) {}

  /** Ranks every viable candidate; the executor tries them in order as fallbacks. */
  rank(req: RouteRequest, candidates: Candidate[]): Scored[] {
    const stats = this.opts.learn ? (this.feedback?.feedbackStats(req.kind) ?? {}) : {};
    const out: Scored[] = [];
    for (const c of candidates) {
      if (req.pin && c.provider !== req.pin) continue;
      if (req.exclude?.includes(c.provider) && !req.pin) continue;
      if (ONLY_WHEN_ASKED.includes(c.provider) && req.pin !== c.provider) continue;
      if (req.nodes?.length && !req.nodes.includes(c.node)) continue;
      if (req.branchWork && (!c.branchWork || !AGENTIC[c.provider])) continue;
      if (!req.branchWork && req.needsWorkspace && (!c.local || !AGENTIC[c.provider])) continue;

      const base = this.caps[req.kind][c.provider];
      const fb = stats[c.provider];
      // Bayesian-smoothed rating: needs a few votes before it moves the needle. Range about ±2.
      const learned = fb ? ((fb.up - fb.down) / (fb.up + fb.down + 4)) * 2 : 0;
      const prefIdx = req.prefer?.indexOf(c.provider) ?? -1;
      const pref = prefIdx === 0 ? 1 : prefIdx === 1 ? 0.5 : 0;
      const web = req.needsWeb ? (c.provider === "perplexity" ? 1 : c.provider === "gemini" ? 0.3 : 0) : 0;
      const busy = Math.min(c.load, 3) * 1.5;
      const local = c.local ? this.opts.localBias : 0;
      const score = base + learned + pref + web + local - busy;

      const parts = [`cap ${base}`];
      if (learned) parts.push(`learned ${learned >= 0 ? "+" : ""}${learned.toFixed(2)}`);
      if (pref) parts.push(`agent pref +${pref}`);
      if (web) parts.push(`web +${web}`);
      if (busy) parts.push(`busy -${busy.toFixed(1)}`);
      if (local) parts.push(`local +${local}`);
      out.push({ ...c, score, why: parts.join(", ") });
    }
    return out.sort((a, b) => b.score - a.score);
  }
}
