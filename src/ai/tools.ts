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
import type { ProviderId, TaskKind } from "../types.js";
import type { Tts, TtsProviderId } from "../voice/tts.js";

/** local: runs on your own machine; free: a free tier; subscription: a plan you already pay for; paid: billed per use. */
export type CostClass = "local" | "free" | "subscription" | "paid";
export const COST_ORDER: CostClass[] = ["local", "free", "subscription", "paid"];

/** What a tool does: agent (can work on files), chat (text in, text out), speech, transcribe, vision. */
export type ToolKind = "agent" | "chat" | "speech" | "transcribe" | "vision";

/** ready: can take work; busy: all its slots are taken; cooling: resting after a limit until `until`; limit: today's cap reached; off: disabled; not_set_up: no login or key. */
export type ToolState = "ready" | "busy" | "cooling" | "limit" | "off" | "not_set_up";

export interface ToolInfo {
  id: string;
  name: string;
  kind: ToolKind;
  cost: CostClass;
  /** Kinds of work it is best at (score >= 8.5), best first. Empty for non-chat tools. */
  strengths: TaskKind[];
  /** Its score per kind of work (chat and agent tools). */
  scores?: Partial<Record<TaskKind, number>>;
  /** Can run tools and edit files. */
  agentic: boolean;
  limits: { maxConcurrent?: number; perDay?: number; note?: string };
  state: ToolState;
  /** When cooling or at its daily cap: when it can be used again. */
  until?: number;
  /** Slots in use / slots, 0..1+. */
  load: number;
  usageToday: { calls: number; failed: number; avgMs: number };
  /** Why it isn't ready, or what model/version it is. */
  detail?: string;
}

/** What each subscription costs and what its plan allows, as the owner described it (override in config `tools`). */
const PROVIDER_FACTS: Record<ProviderId, { name: string; cost: CostClass; note: string }> = {
  claude: { name: "Claude (Claude Code)", cost: "subscription", note: "Claude plan: usage resets every 5 hours; heavy coding uses it up fastest." },
  codex: { name: "ChatGPT (Codex CLI)", cost: "subscription", note: "ChatGPT Go: tighter limits than Plus; a limit cools it down until the reset time it gives." },
  gemini: { name: "Gemini (Antigravity)", cost: "subscription", note: "Google AI Pro through the agy CLI: generous limits, slow to start." },
  perplexity: { name: "Perplexity", cost: "paid", note: "API key: billed per request; for live web research." },
  groq: { name: "Groq", cost: "free", note: "Free tier: per-minute and per-day request limits per model; keys rotate on 429." },
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
  usageToday(): Map<string, { calls: number; failed: number; avgMs: number }> {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const out = new Map<string, { calls: number; failed: number; ms: number }>();
    for (const r of this.d.usage() as UsageRow[]) {
      if (r.day !== day) continue;
      const u = out.get(r.provider) ?? { calls: 0, failed: 0, ms: 0 };
      u.calls += r.calls;
      u.failed += r.failed;
      u.ms += r.duration_ms;
      out.set(r.provider, u);
    }
    return new Map([...out].map(([k, u]) => [k, { calls: u.calls, failed: u.failed, avgMs: u.calls ? Math.round(u.ms / u.calls) : 0 }]));
  }

  /** Every tool with its live state. `fresh` re-detects logins instead of using the 5-minute cache. */
  async list(fresh = false): Promise<ToolInfo[]> {
    const usage = this.usageToday();
    const zero = { calls: 0, failed: 0, avgMs: 0 };
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
        this.finish({
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
      this.finish({
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
        this.finish({
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

    // Local models on this machine (Ollama), the ones the config uses.
    const local = await this.ollamaModels();
    const style = this.d.config.style;
    for (const [model, kind] of [
      [style.model, "chat"],
      [style.visionModel, "vision"],
    ] as const) {
      const have = local?.some((m) => m === model || m === `${model}:latest`);
      tools.push(
        this.finish({
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
  private finish(t: ToolInfo): ToolInfo {
    const o = this.d.config.tools.overrides[t.id];
    if (o?.cost) t.cost = o.cost;
    if (o?.note) t.limits.note = o.note;
    if (o?.perDay) t.limits.perDay = o.perDay;
    if (o?.enabled === false) (t.state = "off"), (t.detail = "turned off in config (tools.overrides)");
    if (t.state === "ready" && t.limits.perDay && t.usageToday.calls >= t.limits.perDay) {
      t.state = "limit";
      t.until = nextUtcDay(this.now());
      t.detail = `daily cap of ${t.limits.perDay} reached`;
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

function nextUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
