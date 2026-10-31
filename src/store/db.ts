import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CooldownStore } from "../providers/registry.js";
import type { FeedbackSource } from "../brain/router.js";
import type { DayTask, ProviderId, RunEvent, RunRecord, TaskKind, Thread } from "../types.js";

/** SQLite persistence: run history, event log, ratings, cooldowns and usage. */
export class Store implements CooldownStore, FeedbackSource {
  readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, "orchestrator.db"));
    this.db.exec(`
      PRAGMA busy_timeout = 5000; -- the WhatsApp link is a second process on this file
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, task TEXT NOT NULL, status TEXT NOT NULL,
        record TEXT NOT NULL, created_at INTEGER NOT NULL, finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at DESC);
      CREATE TABLE IF NOT EXISTS events (
        run_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL,
        type TEXT NOT NULL, step_id TEXT, data TEXT, PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS feedback (
        run_id TEXT NOT NULL, step_id TEXT NOT NULL, kind TEXT NOT NULL,
        provider TEXT NOT NULL, rating INTEGER NOT NULL, ts INTEGER NOT NULL,
        PRIMARY KEY (run_id, step_id)
      );
      CREATE TABLE IF NOT EXISTS cooldowns (provider TEXT PRIMARY KEY, until INTEGER NOT NULL, reason TEXT);
      CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (
        day TEXT NOT NULL, provider TEXT NOT NULL, node TEXT NOT NULL,
        calls INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, provider, node)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories USING fts5(
        run_id UNINDEXED, task, kind UNINDEXED, summary, ts UNINDEXED
      );
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, sub TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, day TEXT NOT NULL, time TEXT, title TEXT NOT NULL,
        source TEXT NOT NULL, detail TEXT, done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS tasks_day ON tasks(day);
    `);
    // R3: what paid calls cost (USD), when the service says; older databases get the column here.
    const usageCols = (this.db.prepare("PRAGMA table_info(usage)").all() as { name: string }[]).map((c) => c.name);
    if (!usageCols.includes("cost_usd")) this.db.exec("ALTER TABLE usage ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0");
  }

  addTask(t: Omit<DayTask, "done">) {
    this.db
      .prepare("INSERT OR REPLACE INTO tasks (id, day, time, title, source, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(t.id, t.day, t.time ?? null, t.title, t.source, t.detail ?? null, Date.now());
  }

  /** A day's tasks: timed ones in time order, then the rest in the order they came in. */
  tasksFor(day: string): DayTask[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE day = ? ORDER BY time IS NULL, time, created_at").all(day) as any[]).map((r) => ({
      id: r.id,
      day: r.day,
      time: r.time ?? undefined,
      title: r.title,
      source: r.source,
      detail: r.detail ?? undefined,
      done: !!r.done,
    }));
  }

  /** Adds or refreshes a task copied from elsewhere, keeping its done state from there. */
  upsertTask(t: DayTask) {
    this.db
      .prepare(
        `INSERT INTO tasks (id, day, time, title, source, detail, done, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET day = excluded.day, time = excluded.time, title = excluded.title,
           source = excluded.source, detail = excluded.detail, done = excluded.done`,
      )
      .run(t.id, t.day, t.time ?? null, t.title, t.source, t.detail ?? null, t.done ? 1 : 0, Date.now());
  }

  /** Removes a day's tasks whose id starts with `prefix` and is not in `keep` (they left the source's list). */
  pruneTasks(prefix: string, day: string, keep: string[]) {
    const gone = (this.db.prepare("SELECT id FROM tasks WHERE day = ? AND substr(id, 1, ?) = ?").all(day, prefix.length, prefix) as { id: string }[])
      .map((r) => r.id)
      .filter((id) => !keep.includes(id));
    for (const id of gone) this.deleteTask(id);
  }

  setTaskDone(id: string, done: boolean): boolean {
    return this.db.prepare("UPDATE tasks SET done = ? WHERE id = ?").run(done ? 1 : 0, id).changes > 0;
  }

  deleteTask(id: string) {
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }

  /** Runs started since `since`, newest first, with what the home screen and insights need. */
  runsSince(since: number, limit = 500): { id: string; threadId?: string; task: string; status: string; error?: string; createdAt: number; finishedAt?: number }[] {
    return (
      this.db
        .prepare(
          "SELECT id, task, status, created_at, finished_at, json_extract(record, '$.threadId') AS thread_id, json_extract(record, '$.error') AS error FROM runs WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(since, limit) as any[]
    ).map((r) => ({
      id: r.id,
      threadId: r.thread_id ?? undefined,
      task: r.task,
      status: r.status,
      error: r.error ?? undefined,
      createdAt: r.created_at,
      finishedAt: r.finished_at ?? undefined,
    }));
  }

  createThread(t: Thread) {
    this.db.prepare("INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(t.id, t.title, t.createdAt, t.updatedAt);
  }

  touchThread(id: string, title?: string) {
    if (title) this.db.prepare("UPDATE threads SET updated_at = ?, title = ? WHERE id = ?").run(Date.now(), title, id);
    else this.db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  }

  getThread(id: string): Thread | undefined {
    const r = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as any;
    return r ? { id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at } : undefined;
  }

  listThreads(limit = 100): Thread[] {
    return (this.db.prepare("SELECT * FROM threads ORDER BY updated_at DESC LIMIT ?").all(limit) as any[]).map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  deleteThread(id: string) {
    this.db.prepare("DELETE FROM threads WHERE id = ?").run(id);
  }

  /** A conversation's runs, oldest first. */
  threadRuns(threadId: string): RunRecord[] {
    return (this.db.prepare("SELECT record FROM runs WHERE json_extract(record, '$.threadId') = ? ORDER BY created_at").all(threadId) as { record: string }[]).map((r) =>
      JSON.parse(r.record),
    );
  }

  addPushSub(endpoint: string, sub: unknown) {
    this.db.prepare("INSERT OR REPLACE INTO push_subs (endpoint, sub, created_at) VALUES (?, ?, ?)").run(endpoint, JSON.stringify(sub), Date.now());
  }

  removePushSub(endpoint: string) {
    this.db.prepare("DELETE FROM push_subs WHERE endpoint = ?").run(endpoint);
  }

  pushSubs(): { endpoint: string; sub: any }[] {
    return (this.db.prepare("SELECT endpoint, sub FROM push_subs").all() as any[]).map((r) => ({ endpoint: r.endpoint, sub: JSON.parse(r.sub) }));
  }

  addMemory(m: { runId: string; task: string; kind: string; summary: string; ts: number }) {
    this.db.prepare("DELETE FROM memories WHERE run_id = ?").run(m.runId);
    this.db.prepare("INSERT INTO memories (run_id, task, kind, summary, ts) VALUES (?, ?, ?, ?, ?)").run(m.runId, m.task, m.kind, m.summary, m.ts);
  }

  /** Full-text search over past runs, best match first. Any word may match. */
  searchMemory(text: string, limit: number, excludeRunId?: string): { runId: string; task: string; kind: string; summary: string; ts: number }[] {
    const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 24);
    if (!words.length || limit <= 0) return [];
    const query = words.map((w) => `"${w}"`).join(" OR ");
    return (
      this.db
        .prepare("SELECT run_id, task, kind, summary, ts FROM memories WHERE memories MATCH ? AND run_id != ? ORDER BY bm25(memories) LIMIT ?")
        .all(query, excludeRunId ?? "", limit) as any[]
    ).map((r) => ({ runId: r.run_id, task: r.task, kind: r.kind, summary: r.summary, ts: Number(r.ts) }));
  }

  saveRun(run: RunRecord) {
    this.db
      .prepare(
        `INSERT INTO runs (id, task, status, record, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, record = excluded.record, finished_at = excluded.finished_at`,
      )
      .run(run.id, run.task, run.status, JSON.stringify(run), run.createdAt, run.finishedAt ?? null);
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT record FROM runs WHERE id = ?").get(id) as { record: string } | undefined;
    return row ? JSON.parse(row.record) : undefined;
  }

  listRuns(limit = 50): Pick<RunRecord, "id" | "task" | "status" | "createdAt" | "finishedAt">[] {
    return (this.db.prepare("SELECT id, task, status, created_at, finished_at FROM runs ORDER BY created_at DESC LIMIT ?").all(limit) as any[]).map((r) => ({
      id: r.id,
      task: r.task,
      status: r.status,
      createdAt: r.created_at,
      finishedAt: r.finished_at ?? undefined,
    }));
  }

  /** Streaming deltas are not persisted (too chatty); everything else is. */
  appendEvent(ev: RunEvent) {
    if (ev.type === "step.delta") return;
    this.db
      .prepare("INSERT OR REPLACE INTO events (run_id, seq, ts, type, step_id, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ev.runId, ev.seq, ev.ts, ev.type, ev.stepId ?? null, ev.data === undefined ? null : JSON.stringify(ev.data));
  }

  events(runId: string): RunEvent[] {
    return (this.db.prepare("SELECT * FROM events WHERE run_id = ? ORDER BY seq").all(runId) as any[]).map((r) => ({
      runId: r.run_id,
      seq: r.seq,
      ts: r.ts,
      type: r.type,
      stepId: r.step_id ?? undefined,
      data: r.data ? JSON.parse(r.data) : undefined,
    }));
  }

  /** Marks interrupted runs as failed after a restart. */
  failStaleRuns() {
    for (const r of this.db.prepare("SELECT record FROM runs WHERE status IN ('queued','planning','running','awaiting_approval','waiting')").all() as { record: string }[]) {
      const run = JSON.parse(r.record) as RunRecord;
      run.status = "failed";
      run.error = "interrupted (server restarted)";
      run.finishedAt = Date.now();
      this.saveRun(run);
    }
  }

  rate(runId: string, stepId: string, kind: TaskKind, provider: ProviderId, rating: 1 | -1) {
    this.db
      .prepare("INSERT OR REPLACE INTO feedback (run_id, step_id, kind, provider, rating, ts) VALUES (?, ?, ?, ?, ?, ?)")
      .run(runId, stepId, kind, provider, rating, Date.now());
  }

  feedbackStats(kind: TaskKind): Partial<Record<ProviderId, { up: number; down: number }>> {
    const rows = this.db
      .prepare("SELECT provider, SUM(rating > 0) AS up, SUM(rating < 0) AS down FROM feedback WHERE kind = ? GROUP BY provider")
      .all(kind) as { provider: ProviderId; up: number; down: number }[];
    return Object.fromEntries(rows.map((r) => [r.provider, { up: Number(r.up), down: Number(r.down) }]));
  }

  loadCooldowns() {
    return this.db.prepare("SELECT provider, until, reason FROM cooldowns WHERE until > ?").all(Date.now()) as {
      provider: ProviderId;
      until: number;
      reason: string;
    }[];
  }

  saveCooldown(provider: ProviderId, until: number, reason: string) {
    this.db.prepare("INSERT OR REPLACE INTO cooldowns (provider, until, reason) VALUES (?, ?, ?)").run(provider, until, reason);
  }

  /** `provider` is a ProviderId or another tool id from src/ai/tools.ts (tts:openai, whisper:groq, ollama:<model>). */
  recordUsage(provider: ProviderId | (string & {}), node: string, ok: boolean, durationMs: number, costUsd = 0) {
    const day = new Date().toISOString().slice(0, 10);
    this.db
      .prepare(
        `INSERT INTO usage (day, provider, node, calls, ok, failed, duration_ms, cost_usd) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(day, provider, node) DO UPDATE SET calls = calls + 1, ok = ok + excluded.ok,
           failed = failed + excluded.failed, duration_ms = duration_ms + excluded.duration_ms, cost_usd = cost_usd + excluded.cost_usd`,
      )
      .run(day, provider, node, ok ? 1 : 0, ok ? 0 : 1, Math.round(durationMs), Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0);
  }

  /** Small settings the owner changes from the app (e.g. `route.mail` -> "groq"); JSON values. */
  getPref<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM prefs WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  /** `undefined` removes the setting. */
  setPref(key: string, value: unknown) {
    if (value === undefined) this.db.prepare("DELETE FROM prefs WHERE key = ?").run(key);
    else this.db.prepare("INSERT OR REPLACE INTO prefs (key, value, updated_at) VALUES (?, ?, ?)").run(key, JSON.stringify(value), Date.now());
  }

  usage(days = 7) {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    return this.db.prepare("SELECT * FROM usage WHERE day >= ? ORDER BY day DESC, provider").all(since);
  }

  close() {
    this.db.close();
  }
}
