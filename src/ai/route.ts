/**
 * The model router (Jarvis phase 1, R2): which AI should do this job, and who takes over when it
 * fails. `routeFor(kind, size, override?)` reads the tool registry (R1) and returns an ordered
 * fallback chain; `run()` walks that chain until one answers, recording usage per try.
 *
 * Jobs are the hub's own small model calls (WhatsApp drafts, Gmail tasks, a call's next step, the
 * brain's thinking through `raw:auto`) or any TaskKind from the capability matrix. Each job kind
 * has a preferred order (the owner's earlier choices, overridable with config `tools.routes`);
 * a TaskKind is ordered by capability score. Tools that are off, not set up, at their daily cap or
 * cooling are left out; busy ones go after the ready ones. Big prompts push Groq (small free-tier
 * context) to the end; small ones let a cheaper tool go first among equals.
 */

import type { ProviderPool } from "../providers/registry.js";
import type { Store } from "../store/db.js";
import { PROVIDER_IDS, type ProviderId, type ProviderRequest, type TaskKind } from "../types.js";
import { COST_ORDER, type ToolInfo } from "./tools.js";

/** The hub's own jobs. */
export const JOB_KINDS = ["whatsapp_draft", "mail", "call", "brain"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export type JobSize = "small" | "medium" | "large";

/** Preferred order per job, as the owner set it before the router existed. */
export const DEFAULT_ROUTES: Record<JobKind, ProviderId[]> = {
  // Gemini last: its free tier is often busy; ChatGPT (codex) and Groq answer first.
  whatsapp_draft: ["claude", "codex", "groq", "gemini"],
  // Groq first: fast and free, and mail is many small batches.
  mail: ["groq", "claude", "gemini", "codex"],
  // A call waits on this, so the quick ones first; Groq last as the final fallback.
  call: ["claude", "codex", "gemini", "groq"],
  // The brain thinks with the ChatGPT session (PLANNER_MODEL=codex) and falls back from there.
  brain: ["codex", "claude", "gemini", "groq"],
};

/** Characters above which a prompt counts as large (about 6k tokens) and below which small. */
export const LARGE_CHARS = 24_000;
export const SMALL_CHARS = 2_000;

export function sizeOf(text: string): JobSize {
  return text.length >= LARGE_CHARS ? "large" : text.length <= SMALL_CHARS ? "small" : "medium";
}

export interface Route {
  kind: JobKind | TaskKind;
  size: JobSize;
  /** Try these in order. Empty when nothing can take the job right now. */
  chain: ProviderId[];
  /** Tools left out and why (off, not set up, cooling, daily cap). */
  skipped: { id: ProviderId; why: string }[];
  /** One line on how the chain was chosen. */
  reason: string;
}

export interface RouteOptions {
  /** A provider to use first; "auto" or undefined lets the router choose. */
  override?: "auto" | ProviderId;
  /** With an override: only that provider, no fallbacks (what a pinned config setting meant before). */
  strict?: boolean;
}

export interface ModelRouterDeps {
  /** The tool registry's list (ToolRegistry.list). */
  tools: () => Promise<ToolInfo[]>;
  pool: ProviderPool;
  store?: Store;
  node: string;
  /** Config `tools.routes`: job kind -> preferred order. */
  routes?: Partial<Record<string, ProviderId[]>>;
}

export interface RoutedResult {
  provider: ProviderId;
  text: string;
  route: Route;
  /** Providers that failed before this one answered. */
  failed: { id: ProviderId; error: string }[];
}

export class RouteError extends Error {
  constructor(
    message: string,
    readonly route: Route,
    readonly rateLimited = false,
  ) {
    super(message);
  }
}

const isJob = (k: string): k is JobKind => (JOB_KINDS as readonly string[]).includes(k);

export class ModelRouter {
  constructor(private d: ModelRouterDeps) {}

  /** The order of providers to try for this job. */
  async routeFor(kind: JobKind | TaskKind, size: JobSize = "medium", opts: RouteOptions = {}): Promise<Route> {
    const tools = new Map((await this.d.tools()).filter((t) => (PROVIDER_IDS as string[]).includes(t.id)).map((t) => [t.id as ProviderId, t]));
    const skipped: Route["skipped"] = [];
    const usable = (id: ProviderId) => {
      const t = tools.get(id);
      if (!t) return skipped.push({ id, why: "not on this hub" }), false;
      if (t.state === "ready" || t.state === "busy") return true;
      const why = t.state === "cooling" && t.until ? `cooling until ${new Date(t.until).toISOString().slice(11, 16)} UTC` : t.state === "not_set_up" ? "not set up" : t.state === "limit" ? (t.detail ?? "daily cap reached") : (t.detail ?? t.state);
      skipped.push({ id, why });
      return false;
    };

    const override = opts.override && opts.override !== "auto" ? opts.override : undefined;
    if (override && opts.strict) {
      const chain = usable(override) ? [override] : [];
      return { kind, size, chain, skipped, reason: `pinned to ${override}` };
    }

    let order: ProviderId[];
    let reason: string;
    if (isJob(kind)) {
      const custom = this.d.routes?.[kind];
      order = custom?.length ? [...custom] : [...DEFAULT_ROUTES[kind]];
      reason = custom?.length ? `${kind}: your order (tools.routes)` : `${kind}: default order`;
      // anything not in the job's list may still help as a last resort, except Perplexity (paid, web search)
      for (const id of PROVIDER_IDS) if (!order.includes(id) && id !== "perplexity") order.push(id);
    } else {
      // A kind of work: best score first; a small job lets a cheaper tool lead when scores are close.
      const score = (id: ProviderId) => tools.get(id)?.scores?.[kind] ?? 0;
      const cost = (id: ProviderId) => COST_ORDER.indexOf(tools.get(id)?.cost ?? "paid");
      order = [...PROVIDER_IDS].sort((a, b) => {
        const diff = score(b) - score(a);
        if (size === "small" && Math.abs(diff) <= 1) return cost(a) - cost(b) || diff;
        return diff;
      });
      reason = `${kind}: best capability score first${size === "small" ? ", cheaper first when close" : ""}`;
    }
    if (override) {
      order = [override, ...order.filter((id) => id !== override)];
      reason = `${override} first (asked), then ${reason}`;
    }
    if (size === "large" && order.includes("groq") && order[order.length - 1] !== "groq") {
      // Groq's free tier caps tokens per minute; a long prompt is likely to be refused there.
      order = [...order.filter((id) => id !== "groq"), "groq"];
      reason += "; Groq last for a long prompt";
    }

    const live = order.filter(usable);
    // Ready before busy, keeping the order within each group.
    const chain = [...live.filter((id) => tools.get(id)!.state === "ready"), ...live.filter((id) => tools.get(id)!.state === "busy")];
    return { kind, size, chain, skipped, reason };
  }

  /**
   * Route the job and run it: each provider in the chain in turn until one answers. A failed or
   * rate-limited one hands over to the next (the pool already cools a limited one down).
   */
  async run(kind: JobKind | TaskKind, req: ProviderRequest, opts: RouteOptions & { size?: JobSize } = {}): Promise<RoutedResult> {
    const size = opts.size ?? sizeOf(`${req.system ?? ""}${req.prompt}`);
    const route = await this.routeFor(kind, size, opts);
    if (!route.chain.length) {
      const why = route.skipped.map((s) => `${s.id} ${s.why}`).join(", ");
      throw new RouteError(`no model can take this ${kind} job right now${why ? ` (${why})` : ""}`, route);
    }
    const failed: RoutedResult["failed"] = [];
    let limited = true;
    for (const id of route.chain) {
      const r = await this.d.pool.run(id, { permission: "read", ...req });
      this.d.store?.recordUsage(id, this.d.node, r.ok, r.durationMs);
      if (r.ok) return { provider: id, text: r.text, route, failed };
      limited &&= !!r.rateLimited;
      failed.push({ id, error: r.error ?? "failed" });
    }
    const last = failed[failed.length - 1];
    throw new RouteError(`every model failed for this ${kind} job; last: ${last.id}: ${last.error}`, route, limited);
  }
}
