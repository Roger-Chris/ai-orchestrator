/**
 * The tool registry (Jarvis phase 1, R1): every AI the hub can use, in one list, with what it is good
 * at, what it costs, its limits, whether it can take work right now and how much it was used today.
 * The model router (R2) picks from this list; the AI hub screen (R4) shows it.
 *
 * Tools are the provider subscriptions and APIs (Claude, ChatGPT, Gemini, Perplexity, Groq), the
 * speech services (src/voice/tts.ts), Groq's Whisper, and local Ollama models on this machine.
 */

import { AGENTIC, type CapabilityMatrix } from "../brain/capabilities.js";
import type { Config } from "../config.js";
import type { ProviderPool } from "../providers/registry.js";
import { COST_ORDER, type CostClass, type ProviderId, type TaskKind, type ToolInfo, type ToolState, type Usage } from "../types.js";

// The shapes live in types.ts so the app can import them too.
export { COST_ORDER, type CostClass, type ToolInfo, type ToolKind, type ToolState, type Usage } from "../types.js";
import type { Tts, TtsProviderId } from "../voice/tts.js";

/** What each subscription costs and what its plan allows, as the owner described it (override in config `tools`). */
const PROVIDER_FACTS: Record<ProviderId, { name: string; cost: CostClass; note: string }> = {
  claude: { name: "Claude (Claude Code)", cost: "subscription", note: "Claude plan: usage resets every 5 hours; heavy coding uses it up fastest." },
  codex: { name: "ChatGPT (Codex CLI)", cost: "subscription", note: "ChatGPT Go: tighter limits than Plus; a limit cools it down until the reset time it gives." },
  gemini: { name: "Gemini (Antigravity)", cost: "subscription", note: "Google AI Pro through the agy CLI: generous limits, slow to start." },
  perplexity: { name: "Perplexity", cost: "paid", note: "API key: billed per request; for live web research." },
  groq: { name: "Groq", cost: "free", note: "Free tier: per-minute and per-day request limits per model; keys rotate on 429." },
  local: { name: "Local model (Ollama)", cost: "local", note: "Runs on this machine: free and private; small, and slow without a GPU." },
  manus: { name: "Manus", cost: "paid", note: "API key: a cloud agent with its own browser; each task uses Manus credits and takes minutes." },
};

const TTS_FACTS: Record<TtsProviderId, { name: string; cost: CostClass; note: string }> = {
  openai: { name: "OpenAI voice", cost: "paid", note: "Billed per character." },
  gemini: { name: "Gemini voice", cost: "free", note: "Gemini API free tier (daily request limit), paid beyond it." },
  groq: { name: "Groq voice (Orpheus)", cost: "free", note: "Free tier, 200 characters per request." },
};

export interface ToolRegistryDeps {
  config: Config;
  pool: ProviderPool;
  capabilities: CapabilityMatrix;
  /** Rows of the usage table (day, provider, calls, failed, duration_ms…). */
  usage: () => unknown[];
  tts?: Tts;
  http?: typeof fetch;
  now?: () => number;
}

interface UsageRow {
  day: string;
  provider: string;
  calls: number;
  failed: number;
  duration_ms: number;
  cost_usd?: number;
}

const STRONG = 8.5;
const OLLAMA_TTL_MS = 60_000;

export class ToolRegistry {
  private ollama?: { at: number; models: string[] | null };

  constructor(private d: ToolRegistryDeps) {}

  private now() {
    return (this.d.now ?? Date.now)();
  }

  /** Usage per tool id for today (UTC day, as the usage table keeps it), across every device that reported here. */
  usageToday(): Map<string, Usage> {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const out = new Map<string, { calls: number; failed: number; ms: number; cost: number }>();
    for (const r of this.d.usage() as UsageRow[]) {
      if (r.day !== day) continue;
      const u = out.get(r.provider) ?? { calls: 0, failed: 0, ms: 0, cost: 0 };
      u.calls += r.calls;
      u.failed += r.failed;
      u.ms += r.duration_ms;
      u.cost += r.cost_usd ?? 0;
      out.set(r.provider, u);
    }
    return new Map(
      [...out].map(([k, u]) => {
        // What the service reported, or the owner's per-call estimate when that is higher (most don't report).
        const estimate = u.calls * (this.d.config.tools.overrides[k]?.costPerCall ?? 0);
        return [k, { calls: u.calls, failed: u.failed, avgMs: u.calls ? Math.round(u.ms / u.calls) : 0, spentUsd: round2(Math.max(u.cost, estimate)) }];
      }),
    );
  }

  /**
   * Why this tool may not be used again today (its daily call cap or spend cap is reached), or
   * undefined. Synchronous, so the provider pool and the speech services can ask before every call.
   */
  capped(id: string, usage = this.usageToday()): string | undefined {
    const o = this.d.config.tools.overrides[id];
    if (!o?.perDay && !o?.spendPerDay) return undefined;
    const u = usage.get(id);
    if (!u) return undefined;
    if (o.perDay && u.calls >= o.perDay) return `daily cap of ${o.perDay} reached`;
    if (o.spendPerDay && u.spentUsd >= o.spendPerDay) return `spend cap of $${o.spendPerDay} a day reached ($${u.spentUsd.toFixed(2)} today)`;
    return undefined;
  }

  /** Every tool with its live state. `fresh` re-detects logins instead of using the 5-minute cache. */
  async list(fresh = false): Promise<ToolInfo[]> {
    const usage = this.usageToday();
    const zero: Usage = { calls: 0, failed: 0, avgMs: 0, spentUsd: 0 };
    const tools: ToolInfo[] = [];

    const status = await this.d.pool.status(fresh);
    for (const id of Object.keys(PROVIDER_FACTS) as ProviderId[]) {
      const facts = PROVIDER_FACTS[id];
      const cfg = this.d.config.providers[id];
      const s = status.find((x) => x.id === id);
      const scores = Object.fromEntries((Object.keys(this.d.capabilities) as TaskKind[]).map((k) => [k, this.d.capabilities[k][id]])) as Record<TaskKind, number>;
      let state: ToolState = "ready";
      let until: number | undefined;
      let detail = s?.detail ?? s?.version;
      if (!cfg.enabled || !s) (state = "off"), (detail = "disabled in config");
      else if (!s.installed || !s.authenticated) state = "not_set_up";
      else if (s.coolingDownUntil) (state = "cooling"), (until = s.coolingDownUntil);
      else if (this.d.pool.load(id) >= 1) state = "busy";
      tools.push(
        this.finish(usage, {
          id,
          name: facts.name,
          kind: AGENTIC[id] ? "agent" : "chat",
          cost: facts.cost,
          strengths: strengthsOf(scores),
          scores,
          agentic: AGENTIC[id],
          limits: { maxConcurrent: cfg.maxConcurrent, note: facts.note },
          state,
          until,
          load: s ? this.d.pool.load(id) : 0,
          usageToday: usage.get(id) ?? zero,
          detail,
        }),
      );
    }

    // Groq's Whisper: the same keys as the Groq provider.
    const groq = this.d.config.providers.groq;
    const groqKeys = [...groq.apiKeys, groq.apiKey ?? ""].some((k) => k.trim());
    tools.push(
      this.finish(usage, {
        id: "whisper:groq",
        name: "Groq Whisper",
        kind: "transcribe",
        cost: "free",
        strengths: [],
        agentic: false,
        limits: { note: "Free tier: audio minutes per hour and per day." },
        state: groqKeys ? "ready" : "not_set_up",
        load: 0,
        usageToday: usage.get("whisper:groq") ?? zero,
        detail: groqKeys ? groq.transcribeModel : "no Groq key (GROQ_API_KEY)",
      }),
    );

    // Speech services.
    const tts = this.d.tts?.status();
    for (const id of Object.keys(TTS_FACTS) as TtsProviderId[]) {
      const p = tts?.providers.find((x) => x.id === id);
      const facts = TTS_FACTS[id];
      const set = !!p && (p.ready || !!p.restingUntil);
      tools.push(
        this.finish(usage, {
          id: `tts:${id}`,
          name: facts.name,
          kind: "speech",
          cost: facts.cost,
          strengths: [],
          agentic: false,
          limits: { note: facts.note },
          state: !this.d.tts || this.d.config.tts.provider === "off" ? "off" : !set ? "not_set_up" : p.restingUntil ? "cooling" : "ready",
          until: p?.restingUntil,
          load: 0,
          usageToday: usage.get(`tts:${id}`) ?? zero,
          detail: p?.lastError ?? (set ? `voice ${p.voice}` : "no key on the hub"),
        }),
      );
    }

    // Other local models on this machine (Ollama) the config uses; the chat model the `local`
    // provider runs is already listed above as `local`.
    const local = await this.ollamaModels();
    const style = this.d.config.style;
    const localChat = this.d.config.providers.local.model ?? style.model;
    for (const [model, kind] of [
      [style.model, "chat"],
      [style.visionModel, "vision"],
    ] as const) {
      if (model === localChat && kind === "chat") continue;
      const have = local?.some((m) => m === model || m === `${model}:latest`);
      tools.push(
        this.finish(usage, {
          id: `ollama:${model}`,
          name: `${model} (Ollama, this machine)`,
          kind,
          cost: "local",
          strengths: [],
          agentic: false,
          limits: { note: "Runs on this machine: free, private, as fast as its GPU." },
          state: have ? "ready" : "not_set_up",
          load: 0,
          usageToday: usage.get(`ollama:${model}`) ?? zero,
          detail: local === null ? "Ollama is not running here" : have ? undefined : `not pulled (ollama pull ${model})`,
        }),
      );
    }
    return tools;
  }

  /** Config overrides (`tools.<id>`): cost class, daily cap, a note, or turning a tool off. */
  private finish(usage: Map<string, Usage>, t: ToolInfo): ToolInfo {
    const o = this.d.config.tools.overrides[t.id];
    if (o?.cost) t.cost = o.cost;
    if (o?.note) t.limits.note = o.note;
    if (o?.perDay) t.limits.perDay = o.perDay;
    if (o?.spendPerDay) t.limits.spendPerDay = o.spendPerDay;
    if (o?.enabled === false) (t.state = "off"), (t.detail = "turned off in config (tools.overrides)");
    const cap = this.capped(t.id, usage);
    if (cap && (t.state === "ready" || t.state === "busy")) {
      t.state = "limit";
      t.until = nextUtcDay(this.now());
      t.detail = cap;
    }
    return t;
  }

  /** Model names Ollama has here; null when it isn't running. Cached a minute. */
  private async ollamaModels(): Promise<string[] | null> {
    if (this.ollama && this.now() - this.ollama.at < OLLAMA_TTL_MS) return this.ollama.models;
    let models: string[] | null = null;
    try {
      const res = await (this.d.http ?? fetch)(`${this.d.config.style.ollamaUrl.replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) models = (((await res.json()) as { models?: { name: string }[] }).models ?? []).map((m) => m.name);
    } catch {
      models = null;
    }
    this.ollama = { at: this.now(), models };
    return models;
  }
}

export function strengthsOf(scores: Partial<Record<TaskKind, number>>): TaskKind[] {
  return (Object.entries(scores) as [TaskKind, number][])
    .filter(([, s]) => s >= STRONG)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function nextUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
