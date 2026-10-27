import type { Config } from "../config.js";
import type { ProviderId, ProviderRequest, ProviderResult, ProviderStatus } from "../types.js";
import type { Provider } from "./base.js";
import { ClaudeProvider } from "./claude.js";
import { CodexProvider } from "./codex.js";
import { GeminiProvider } from "./gemini.js";
import { OpenAICompatProvider } from "./openai-compat.js";
import { PerplexityProvider } from "./perplexity.js";

/** Counting semaphore so one device never floods a subscription. */
export class Semaphore {
  private waiters: (() => void)[] = [];
  active = 0;
  constructor(public limit: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
  get queued() {
    return this.waiters.length;
  }
}

export interface CooldownStore {
  loadCooldowns(): { provider: ProviderId; until: number; reason: string }[];
  saveCooldown(provider: ProviderId, until: number, reason: string): void;
}

/** Default cooldown when a provider says "limit reached" without a reset time. */
const DEFAULT_COOLDOWN_MS = 30 * 60_000;
const DETECT_TTL_MS = 5 * 60_000;

/** Owns the provider adapters on this device, with throttling and usage-limit cooldowns. */
export class ProviderPool {
  readonly providers = new Map<ProviderId, Provider>();
  private sems = new Map<ProviderId, Semaphore>();
  private cooldowns = new Map<ProviderId, { until: number; reason: string }>();
  private statusCache?: { at: number; value: ProviderStatus[] };

  constructor(
    private config: Config,
    private store?: CooldownStore,
    overrides?: Partial<Record<ProviderId, Provider>>,
  ) {
    const p = config.providers;
    const all: Provider[] = [
      overrides?.claude ?? new ClaudeProvider(p.claude),
      overrides?.codex ?? new CodexProvider(p.codex),
      overrides?.gemini ?? new GeminiProvider(p.gemini),
      overrides?.perplexity ?? new PerplexityProvider(p.perplexity),
      overrides?.groq ?? new OpenAICompatProvider("groq", p.groq, "Optional. Set GROQ_API_KEY (free at console.groq.com) for fast answers to quick questions and Gmail reading."),
    ];
    for (const prov of all) {
      if (!p[prov.id].enabled && !overrides?.[prov.id]) continue;
      this.providers.set(prov.id, prov);
      this.sems.set(prov.id, new Semaphore(p[prov.id].maxConcurrent));
    }
    for (const c of store?.loadCooldowns() ?? []) {
      if (c.until > Date.now()) this.cooldowns.set(c.provider, { until: c.until, reason: c.reason });
    }
  }

  async status(force = false): Promise<ProviderStatus[]> {
    if (!force && this.statusCache && Date.now() - this.statusCache.at < DETECT_TTL_MS) {
      return this.statusCache.value.map((s) => ({ ...s, coolingDownUntil: this.cooldownUntil(s.id) }));
    }
    const value = await Promise.all([...this.providers.values()].map((p) => p.detect()));
    this.statusCache = { at: Date.now(), value };
    return value.map((s) => ({ ...s, coolingDownUntil: this.cooldownUntil(s.id) }));
  }

  /** Providers ready to take work right now on this device. */
  async available(): Promise<ProviderId[]> {
    const st = await this.status();
    return st.filter((s) => s.installed && s.authenticated && !this.cooldownUntil(s.id)).map((s) => s.id);
  }

  cooldownUntil(id: ProviderId): number | undefined {
    const c = this.cooldowns.get(id);
    if (!c) return undefined;
    if (c.until <= Date.now()) {
      this.cooldowns.delete(id);
      return undefined;
    }
    return c.until;
  }

  /** Current load 0..1+, used by the router to spread work. */
  load(id: ProviderId): number {
    const s = this.sems.get(id);
    return s ? (s.active + s.queued) / s.limit : 1;
  }

  coolDown(id: ProviderId, until: number | undefined, reason: string) {
    const t = until && until > Date.now() ? until : Date.now() + DEFAULT_COOLDOWN_MS;
    this.cooldowns.set(id, { until: t, reason });
    this.store?.saveCooldown(id, t, reason);
  }

  clearCooldown(id: ProviderId) {
    this.cooldowns.delete(id);
    this.store?.saveCooldown(id, 0, "cleared");
  }

  async run(id: ProviderId, req: ProviderRequest): Promise<ProviderResult> {
    const prov = this.providers.get(id);
    if (!prov) return { ok: false, text: "", provider: id, durationMs: 0, error: `provider ${id} is disabled on this device` };
    const cfg = this.config.providers[id];
    const model = req.model ?? (req.deep ? cfg.deepModel : undefined);
    const release = await this.sems.get(id)!.acquire();
    try {
      const res = await prov.run({ ...req, model });
      if (res.rateLimited) this.coolDown(id, res.retryAt, res.error ?? "usage limit");
      return res;
    } finally {
      release();
    }
  }
}
