import { localDay } from "../server/home.js";
import type { Store } from "../store/db.js";
import type { DayTask } from "../types.js";

/**
 * Today's tasks from the AI_Assistant brain (../AI_Assistant), which already reads your Gmail
 * (and WhatsApp, when its bridge is on) and turns messages into tasks. The hub copies the ones
 * due today, the overdue ones and today's finished ones into its own task list every few
 * minutes; ticking one off on the phone marks it done in the brain too.
 *
 * The brain listens on localhost only, so this works on the machine that runs it (the Linux hub).
 */

export interface AssistantOptions {
  url: string;
  token: string;
  pollMinutes: number;
}

/** A task as the brain's GET /tasks returns it (only the fields used here). */
export interface BrainTask {
  id: number;
  kind: "task" | "event" | "question";
  status: "watching" | "pending_confirmation" | "open" | "done" | "rejected";
  title: string;
  due_at: string | null;
  source_chat?: string | null;
  /** "email" | "whatsapp" | "telegram" | "manual"; older brains don't send it. */
  source?: string;
}

export interface AssistantStatus {
  ok: boolean;
  lastSync?: number;
  lastError?: string;
  /** Tasks on today's list from the brain. */
  today?: number;
}

/** The brain stores UTC without an offset; read such times as UTC. */
export function brainTime(s: string): Date {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
}

const SOURCES: Record<string, DayTask["source"]> = { email: "gmail", whatsapp: "whatsapp" };

/** Overdue tasks older than this are left to the brain (Telegram); Today stays about today. */
const OVERDUE_DAYS = 7;

/** Which brain tasks belong on today's list, and how they read there. */
export function todayTasks(tasks: BrainTask[], now = new Date()): Omit<DayTask, "day">[] {
  const today = localDay(now);
  const out: Omit<DayTask, "day">[] = [];
  for (const t of tasks) {
    if (!t.due_at || t.status === "rejected" || t.status === "watching") continue;
    const due = brainTime(t.due_at);
    const day = localDay(due);
    const done = t.status === "done";
    // A past event is simply over; a past task is still owed, for a week.
    const overdue = day < today && !done && t.kind !== "event" && now.getTime() - due.getTime() < OVERDUE_DAYS * 86_400_000;
    if (day !== today && !overdue) continue;
    const time = overdue ? "overdue" : due.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const detail = [t.status === "pending_confirmation" ? "not confirmed yet" : undefined, t.source_chat ?? undefined].filter(Boolean).join(" · ");
    out.push({ id: `brain:${t.id}`, time, title: t.title, source: SOURCES[t.source ?? ""] ?? "manual", detail: detail || undefined, done });
  }
  return out;
}

export class AssistantTasks {
  private state: AssistantStatus = { ok: false };
  private timer?: NodeJS.Timeout;
  private syncing?: Promise<number>;

  constructor(
    private store: Store,
    private opts: AssistantOptions,
    private http: typeof fetch = fetch,
  ) {}

  status(): AssistantStatus {
    return this.state;
  }

  start() {
    const tick = () => void this.sync().catch(() => {});
    setTimeout(tick, 3000).unref();
    this.timer = setInterval(tick, this.opts.pollMinutes * 60_000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Copies today's brain tasks into the hub's list and drops the ones that left it. */
  sync(): Promise<number> {
    this.syncing ??= this.pass().finally(() => (this.syncing = undefined));
    return this.syncing;
  }

  private async pass(): Promise<number> {
    try {
      // Open and unconfirmed tasks (the default), plus finished ones so today's stay ticked off.
      const [active, done] = await Promise.all([this.call<BrainTask[]>("/tasks?limit=500"), this.call<BrainTask[]>("/tasks?status=done&limit=200")]);
      const day = localDay();
      const tasks = todayTasks([...active, ...done]);
      for (const t of tasks) this.store.upsertTask({ ...t, day });
      this.store.pruneTasks("brain:", day, tasks.map((t) => t.id));
      this.state = { ok: true, lastSync: Date.now(), today: tasks.length };
      return tasks.length;
    } catch (e) {
      this.state = { ...this.state, ok: false, lastSync: Date.now(), lastError: (e as Error).message };
      throw e;
    }
  }

  /** Marks a brain task done, or back to open, in the brain itself. */
  async setDone(id: string, done: boolean) {
    const n = Number(id.replace(/^brain:/, ""));
    if (!Number.isInteger(n)) throw new Error(`not a brain task: ${id}`);
    await this.call(`/tasks/${n}/${done ? "done" : "confirm"}`, { method: "POST" });
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.http(`${this.opts.url.replace(/\/+$/, "")}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.opts.token}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new Error(`the brain at ${this.opts.url} did not answer (${(e as Error).message})`);
    }
    if (res.status === 401 || res.status === 403) throw new Error("the brain rejected BRAIN_TOKEN: copy it from AI_Assistant/.env into this hub's .env");
    if (!res.ok) throw new Error(`the brain answered HTTP ${res.status} for ${path.split("?")[0]}`);
    return (await res.json()) as T;
  }
}
