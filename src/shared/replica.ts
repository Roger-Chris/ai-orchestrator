import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/**
 * This device's copy of the shared memory pool (AI_Assistant docs/JARVIS.md).
 *
 * The master copy lives in the AI_Assistant brain on the Linux machine. Every device keeps a full
 * replica in its own SQLite file, so memory works offline and searches are local. Writes land here
 * first (marked dirty) and are pushed upstream; then everything the brain accepted since `last_seq`
 * is pulled back. Same uid written in two places: the newer `updated_at` wins, on both sides.
 */

export const KINDS = [
  "person", "org", "project", "place", "thing", "event_series", "device",
  "relation", "fact", "note", "decision", "work", "task", "event", "file",
] as const;
export type MemoryKind = (typeof KINDS)[number];

export interface MemoryRecord {
  uid: string;
  kind: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  tags: string;
  aliases: string;
  subject?: string | null;
  source: string;
  device: string;
  created_at: string;
  updated_at: string;
  deleted: boolean;
  seq?: number;
  score?: number;
}

export interface RecordInput {
  uid?: string;
  kind: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  tags?: string | string[];
  aliases?: string | string[];
  subject?: string | null;
  source?: string;
  deleted?: boolean;
}

/** Where the master copy is: the brain itself (on the Linux machine) or the Linux hub's proxy. */
export interface Upstream {
  /** Base URL that serves `/changes`, `/batch`… e.g. http://127.0.0.1:8000/memory or http://hub:4317/node/memory */
  base: string;
  token?: string;
}

export interface SyncStatus {
  ok: boolean;
  upstream?: string;
  lastSync?: number;
  lastError?: string;
  lastSeq: number;
  pending: number;
  records: number;
}

type Fetch = typeof fetch;

const slugRe = /[^a-z0-9]+/g;
export const slug = (s: string) => (s ?? "").toLowerCase().replace(slugRe, "-").replace(/^-+|-+$/g, "").slice(0, 80);
export const namedUid = (kind: string, name: string) => `${kind}:${slug(name)}`;
export const newUid = (kind: string) => `${kind}:${randomBytes(8).toString("hex")}`;
const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v.map((x) => x.trim()).filter(Boolean).join(",") : (v ?? ""));

export class MemoryReplica {
  readonly db: DatabaseSync;
  private status: Omit<SyncStatus, "lastSeq" | "pending" | "records"> = { ok: false };
  private timer?: NodeJS.Timeout;
  private syncing?: Promise<number>;

  constructor(
    file: string,
    readonly device: string,
    private upstream?: Upstream,
    private fetchFn: Fetch = fetch,
  ) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS records (
        uid TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
        data TEXT NOT NULL DEFAULT '{}', tags TEXT NOT NULL DEFAULT '', aliases TEXT NOT NULL DEFAULT '',
        subject TEXT, source TEXT NOT NULL DEFAULT 'manual', device TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
        seq INTEGER, dirty INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS records_kind ON records(kind);
      CREATE INDEX IF NOT EXISTS records_subject ON records(subject);
      CREATE INDEX IF NOT EXISTS records_dirty ON records(dirty);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
        uid UNINDEXED, title, body, tags, aliases, tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
  }

  // ---------------------------------------------------------------- local reads

  get lastSeq(): number {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = 'last_seq'").get() as { value: string } | undefined;
    return r ? Number(r.value) : 0;
  }

  private set lastSeq(n: number) {
    this.db.prepare("INSERT INTO meta (key, value) VALUES ('last_seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(n));
  }

  get(uid: string): MemoryRecord | undefined {
    const r = this.db.prepare("SELECT * FROM records WHERE uid = ?").get(uid);
    return r ? toRecord(r) : undefined;
  }

  /** Ranked full-text search; all words first, then any word. Deleted records never match. */
  search(q: string, opts: { kind?: string; limit?: number; anyWord?: boolean } = {}): MemoryRecord[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
    const words = (q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((w) => w.length > 1).slice(0, 12);
    if (!words.length) return [];
    for (const joiner of opts.anyWord === false ? ["AND"] : ["AND", "OR"]) {
      const expr = words.map((w) => `"${w}"*`).join(` ${joiner} `);
      const rows = this.db
        .prepare(
          `SELECT r.*, bm25(records_fts, 0, 5.0, 1.0, 2.0, 4.0) AS rank FROM records_fts f JOIN records r ON r.uid = f.uid
           WHERE records_fts MATCH ? AND r.deleted = 0 ${opts.kind ? "AND r.kind = ?" : ""} ORDER BY rank LIMIT ?`,
        )
        .all(...([expr, ...(opts.kind ? [opts.kind] : []), limit] as [string, ...any[]]));
      if (rows.length) return rows.map((r: any) => ({ ...toRecord(r), score: Math.round(-r.rank * 1000) / 1000 }));
    }
    return [];
  }

  /** A uid, a name (any named kind), an alias, or the best all-words match. */
  resolve(nameOrUid: string): MemoryRecord | undefined {
    if (nameOrUid.includes(":")) {
      const r = this.get(nameOrUid);
      if (r && !r.deleted) return r;
    }
    const s = slug(nameOrUid);
    for (const kind of ["person", "project", "org", "place", "device", "thing", "event_series"]) {
      const r = this.get(`${kind}:${s}`);
      if (r && !r.deleted) return r;
    }
    const aliased = this.db
      .prepare("SELECT * FROM records WHERE deleted = 0 AND (',' || aliases || ',') LIKE ? LIMIT 1")
      .get(`%,${s},%`);
    if (aliased) return toRecord(aliased);
    return this.search(nameOrUid, { limit: 1, anyWord: false })[0];
  }

  about(nameOrUid: string, limit = 20) {
    const rec = this.resolve(nameOrUid);
    if (!rec) return undefined;
    const relations = (this.db
      .prepare("SELECT * FROM records WHERE kind = 'relation' AND deleted = 0 AND data LIKE ?")
      .all(`%${rec.uid}%`) as any[])
      .map(toRecord)
      .filter((r) => r.data.src === rec.uid || r.data.dst === rec.uid)
      .slice(0, limit)
      .map((r) => ({ src: r.data.src as string, rel: r.data.rel as string, dst: r.data.dst as string, title: r.title }));
    const linked = (this.db
      .prepare("SELECT * FROM records WHERE subject = ? AND deleted = 0 ORDER BY updated_at DESC LIMIT ?")
      .all(rec.uid, limit) as any[]).map(toRecord);
    return { record: rec, relations, linked };
  }

  recent(opts: { kind?: string; limit?: number } = {}): MemoryRecord[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
    const rows = opts.kind
      ? this.db.prepare("SELECT * FROM records WHERE deleted = 0 AND kind = ? ORDER BY updated_at DESC LIMIT ?").all(opts.kind, limit)
      : this.db.prepare("SELECT * FROM records WHERE deleted = 0 ORDER BY updated_at DESC LIMIT ?").all(limit);
    return rows.map(toRecord);
  }

  syncStatus(): SyncStatus {
    const pending = (this.db.prepare("SELECT COUNT(*) AS n FROM records WHERE dirty = 1").get() as any).n as number;
    const records = (this.db.prepare("SELECT COUNT(*) AS n FROM records WHERE deleted = 0").get() as any).n as number;
    return { ...this.status, upstream: this.upstream?.base, lastSeq: this.lastSeq, pending, records };
  }

  // ---------------------------------------------------------------- local writes

  /** Write on this device. Pushed upstream on the next sync; works offline. */
  put(input: RecordInput, now = new Date()): MemoryRecord {
    if (!(KINDS as readonly string[]).includes(input.kind)) throw new Error(`unknown kind ${input.kind}`);
    const uid = input.uid ?? newUid(input.kind);
    const prev = this.get(uid);
    const rec: MemoryRecord = {
      uid,
      kind: input.kind,
      title: (input.title ?? "").trim().slice(0, 300),
      body: (input.body ?? "").slice(0, 20_000),
      data: input.data ?? {},
      tags: list(input.tags),
      aliases: list(input.aliases),
      subject: input.subject ?? null,
      source: input.source ?? "manual",
      device: this.device,
      created_at: prev?.created_at ?? now.toISOString(),
      updated_at: now.toISOString(),
      deleted: !!input.deleted,
    };
    this.store(rec, true);
    return rec;
  }

  forget(uid: string, now = new Date()): boolean {
    const prev = this.get(uid);
    if (!prev || prev.deleted) return false;
    this.put({ ...prev, deleted: true }, now);
    return true;
  }

  private store(rec: MemoryRecord, dirty: boolean) {
    this.db
      .prepare(
        `INSERT INTO records (uid, kind, title, body, data, tags, aliases, subject, source, device, created_at, updated_at, deleted, seq, dirty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uid) DO UPDATE SET kind = excluded.kind, title = excluded.title, body = excluded.body, data = excluded.data,
           tags = excluded.tags, aliases = excluded.aliases, subject = excluded.subject, source = excluded.source,
           device = excluded.device, updated_at = excluded.updated_at, deleted = excluded.deleted,
           seq = COALESCE(excluded.seq, records.seq), dirty = excluded.dirty`,
      )
      .run(
        rec.uid, rec.kind, rec.title, rec.body, JSON.stringify(rec.data ?? {}), rec.tags, rec.aliases, rec.subject ?? null,
        rec.source, rec.device, rec.created_at, rec.updated_at, rec.deleted ? 1 : 0, rec.seq ?? null, dirty ? 1 : 0,
      );
    this.db.prepare("DELETE FROM records_fts WHERE uid = ?").run(rec.uid);
    if (!rec.deleted) {
      this.db
        .prepare("INSERT INTO records_fts (uid, title, body, tags, aliases) VALUES (?, ?, ?, ?, ?)")
        .run(rec.uid, rec.title, rec.body, rec.tags.replaceAll(",", " "), rec.aliases.replaceAll(",", " ").replaceAll("-", " "));
    }
  }

  // ---------------------------------------------------------------- sync

  start(intervalSeconds: number) {
    if (!this.upstream) return;
    const tick = () => void this.sync().catch(() => undefined);
    tick();
    this.timer = setInterval(tick, intervalSeconds * 1000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Push what this device wrote, then pull everything new. Returns records pulled. One at a time. */
  sync(): Promise<number> {
    if (!this.upstream) return Promise.resolve(0);
    this.syncing ??= this.doSync().finally(() => (this.syncing = undefined));
    return this.syncing;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.upstream?.token) h.Authorization = `Bearer ${this.upstream.token}`;
    return h;
  }

  private async doSync(): Promise<number> {
    const up = this.upstream!;
    try {
      await this.push(up);
      let pulled = 0;
      for (let page = 0; page < 200; page++) {
        const res = await this.fetchFn(`${up.base}/changes?since=${this.lastSeq}&limit=500`, {
          headers: this.headers(),
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`pull: HTTP ${res.status}`);
        const body = (await res.json()) as { records: MemoryRecord[]; last_seq: number; more: boolean };
        this.db.exec("BEGIN");
        try {
          for (const r of body.records) {
            const mine = this.get(r.uid);
            // A local edit not pushed yet that is newer than what came back stays (it goes up next sync).
            if (mine && this.isDirty(r.uid) && Date.parse(mine.updated_at) > Date.parse(r.updated_at)) continue;
            this.store({ ...r, data: r.data ?? {} }, false);
          }
          this.lastSeq = body.last_seq;
          this.db.exec("COMMIT");
        } catch (e) {
          this.db.exec("ROLLBACK");
          throw e;
        }
        pulled += body.records.length;
        if (!body.more) break;
      }
      this.status = { ok: true, lastSync: Date.now() };
      return pulled;
    } catch (e) {
      this.status = { ...this.status, ok: false, lastError: (e as Error).message };
      throw e;
    }
  }

  private isDirty(uid: string): boolean {
    return !!(this.db.prepare("SELECT dirty FROM records WHERE uid = ?").get(uid) as any)?.dirty;
  }

  private async push(up: Upstream) {
    for (let round = 0; round < 100; round++) {
      const rows = (this.db.prepare("SELECT * FROM records WHERE dirty = 1 ORDER BY updated_at LIMIT 200").all() as any[]).map(toRecord);
      if (!rows.length) return;
      const res = await this.fetchFn(`${up.base}/batch`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ device: this.device, records: rows.map(({ seq: _s, score: _sc, created_at: _c, ...r }) => r) }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`push: HTTP ${res.status}`);
      const { results } = (await res.json()) as { results: { uid: string; accepted: boolean; error?: string; record?: MemoryRecord }[] };
      const clear = this.db.prepare("UPDATE records SET dirty = 0 WHERE uid = ? AND updated_at = ?");
      for (const r of rows) {
        const res = results.find((x) => x.uid === r.uid);
        if (!res) continue; // not answered: pushed again next time
        if (!res.accepted && res.record && this.get(r.uid)?.updated_at === r.updated_at) {
          // The brain kept a newer (or the same) copy: take it, so this device agrees with everyone.
          this.store({ ...res.record, data: res.record.data ?? {} }, false);
        } else {
          // Accepted, or rejected for good (bad record): either way not pushed again.
          clear.run(r.uid, r.updated_at);
        }
      }
    }
  }
}

function toRecord(r: any): MemoryRecord {
  let data: Record<string, unknown> = {};
  try {
    data = typeof r.data === "string" ? (r.data ? JSON.parse(r.data) : {}) : (r.data ?? {});
  } catch {
    data = {};
  }
  return {
    uid: r.uid,
    kind: r.kind,
    title: r.title ?? "",
    body: r.body ?? "",
    data,
    tags: r.tags ?? "",
    aliases: r.aliases ?? "",
    subject: r.subject ?? null,
    source: r.source ?? "",
    device: r.device ?? "",
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted: !!r.deleted,
    seq: r.seq ?? undefined,
  };
}

/** Records as compact lines for a model prompt. */
export function asPrompt(records: MemoryRecord[], maxChars = 3000): string {
  const out: string[] = [];
  let used = 0;
  for (const r of records) {
    const body = r.body.split(/\s+/).join(" ").slice(0, 300);
    const line = `- [${r.kind}] ${r.title}${body ? `: ${body}` : ""}  (${r.uid})`;
    if (used + line.length > maxChars) break;
    out.push(line);
    used += line.length;
  }
  return out.join("\n");
}
