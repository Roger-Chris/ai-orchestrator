import type { Config } from "../config.js";
import type { ProviderRequest, ProviderResult, ProviderStatus } from "../types.js";
import { failure, type Provider, withSystem } from "./base.js";

type ManusConfig = Config["providers"]["manus"];
type Fetch = typeof fetch;

/** A rejected key, or one out of credits, is tried again after this long. */
const BAD_KEY_MS = 60 * 60_000;

class ManusError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfter: number) {
    super(message);
  }
}

/**
 * Manus (manus.ai): an autonomous agent with its own browser and computer in the cloud, through its
 * API v2 (open.manus.ai). A request becomes a Manus task: `task.create`, then `task.listMessages` is
 * polled until the agent stops, and its result message (with file links) is the answer. Slow and
 * billed in Manus credits, so the router only uses it when asked by name (it scores low everywhere).
 *
 * Safety: when Manus stops to ask for confirmation (e.g. before sending an email from a connector),
 * the hub never confirms; it fails with the task link so you decide in the Manus app.
 *
 * Several keys rotate at task.create: a limit, no credits or a rejected key moves on to the next. A
 * task belongs to the key's account, so following it stays on the key that created it.
 */
export class ManusProvider implements Provider {
  readonly id = "manus" as const;
  private keys: string[];
  /** Key index → when it may be used again. */
  private resting = new Map<number, number>();
  /** Where the next task starts, so keys share the load. */
  private next = 0;

  constructor(
    private cfg: ManusConfig,
    private http: Fetch = fetch,
    private sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.keys = [...new Set([...cfg.apiKeys, cfg.apiKey].map((k) => k?.trim()).filter((k): k is string => !!k))];
  }

  async detect(): Promise<ProviderStatus> {
    const n = this.keys.length;
    return {
      id: this.id,
      installed: n > 0,
      authenticated: n > 0,
      command: "api",
      detail: n > 1 ? `${n} keys in rotation` : n ? undefined : "Optional. Set MANUS_API_KEY or MANUS_API_KEYS (Manus web app → Settings → API → Create API key); runs use your Manus credits.",
    };
  }

  private async call(key: string, path: string, init?: RequestInit): Promise<any> {
    const res = await this.http(`${this.cfg.baseUrl.replace(/\/$/, "")}/v2/${path}`, {
      ...init,
      headers: { "x-manus-api-key": key, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || body.ok === false) throw new ManusError(`Manus ${res.status}: ${body.error?.message ?? body.error?.code ?? res.statusText}`, res.status, Number(res.headers.get("retry-after")));
    return body;
  }

  /** Creates the task on the first usable key, in turn. Anything but a key's own problem stops at once. */
  private async create(init: RequestInit): Promise<{ key: string; created: any }> {
    const now = Date.now();
    const start = this.next++ % this.keys.length;
    const order = this.keys.map((_, i) => (start + i) % this.keys.length).filter((k) => (this.resting.get(k) ?? 0) <= now);
    let last: ManusError | undefined;
    for (const k of order) {
      try {
        return { key: this.keys[k], created: await this.call(this.keys[k], "task.create", init) };
      } catch (e) {
        if (!(e instanceof ManusError) || ![401, 402, 403, 429].includes(e.status)) throw e;
        last = e;
        this.resting.set(k, Date.now() + (e.status === 429 ? (e.retryAfter || 60) * 1000 : BAD_KEY_MS));
      }
    }
    throw last ?? new Error(`all ${this.keys.length} Manus keys are resting after limits or rejections`);
  }

  async run(req: ProviderRequest): Promise<ProviderResult> {
    const started = Date.now();
    const model = req.model ?? (req.deep ? this.cfg.deepModel : undefined) ?? this.cfg.model;
    if (!this.keys.length) return failure(this.id, started, "Manus is not set up: MANUS_API_KEY is missing", model);
    let key: string;
    let created: any;
    try {
      ({ key, created } = await this.create({
        method: "POST",
        body: JSON.stringify({ message: { content: withSystem(req) }, agent_profile: model, interactive_mode: false, hide_in_task_list: false }),
        signal: req.signal,
      }));
    } catch (e) {
      const r = failure(this.id, started, (e as Error).message, model);
      // No key left: when one is only resting, tell the pool when the first comes back.
      const back = [...this.resting.values()].filter((t) => t > Date.now());
      return back.length ? { ...r, rateLimited: true, retryAt: Math.min(...back) } : r;
    }
    try {
      const taskId: string = created.task_id;
      const link: string = created.task_url ?? `https://manus.im/app/${taskId}`;
      req.onProgress?.(`Manus task started: ${link}`);
      const deadline = started + (req.timeoutMs ?? 30 * 60_000);
      const seen = new Set<string>();
      let result: string | undefined;
      let lastAssistant: string | undefined;
      const files: string[] = [];
      while (Date.now() < deadline) {
        if (req.signal?.aborted) return failure(this.id, started, "stopped", model);
        // the newest events (so the latest status is never past the page), read oldest first
        const page = await this.call(key, `task.listMessages?task_id=${encodeURIComponent(taskId)}&order=desc&limit=100`, { signal: req.signal });
        let status: string | undefined;
        let detail = "";
        for (const ev of [...(page.messages ?? [])].reverse()) {
          if (ev.type === "status_update") {
            status = ev.status_update?.agent_status;
            detail = ev.status_update?.status_detail?.waiting_description ?? ev.status_update?.description ?? "";
          }
          if (seen.has(ev.id)) continue;
          seen.add(ev.id);
          if (ev.type === "assistant_message") {
            const m = ev.assistant_message ?? {};
            if (m.content) {
              lastAssistant = m.content;
              if (m.delivery_kind === "result") result = m.content;
              else req.onDelta?.(`${m.content}\n`);
            }
            for (const a of m.attachments ?? []) if (a.url) files.push(`${a.filename ?? a.type}: ${a.url}`);
          }
          if (ev.type === "error_message") return failure(this.id, started, `Manus: ${ev.error_message?.content ?? "the task failed"} (${link})`, model);
        }
        if (status === "error") return failure(this.id, started, `Manus: the task failed (${link})`, model);
        if (status === "waiting") return failure(this.id, started, `Manus is waiting for you${detail ? `: ${detail}` : ""}. Answer or confirm it in the Manus app: ${link}`, model);
        if (status === "stopped") {
          const text = result ?? lastAssistant ?? "";
          const out = [text, files.length ? `Files:\n${files.join("\n")}` : "", `Manus task: ${link}`].filter(Boolean).join("\n\n");
          return { ok: true, text: out, provider: this.id, model, durationMs: Date.now() - started };
        }
        await this.sleep(this.cfg.pollSeconds * 1000);
      }
      return failure(this.id, started, `Manus is still working after the time limit; follow it at ${link}`, model);
    } catch (e) {
      return failure(this.id, started, (e as Error).message, model);
    }
  }
}
