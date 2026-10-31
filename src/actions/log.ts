import type { Store } from "../store/db.js";
import type { ActionLogEntry } from "../types.js";
import { redact } from "./registry.js";

/**
 * Who did what on which device: every action sent through the hub, whether it ran, waited for your
 * approval or was refused. Kept on the hub; `GET /api/action-log` reads it. Entries are only added.
 */
export class ActionLog {
  constructor(
    private store: Store,
    private now: () => number = Date.now,
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS action_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, who TEXT NOT NULL, node TEXT NOT NULL,
        action TEXT NOT NULL, args TEXT NOT NULL, reason TEXT, status TEXT NOT NULL, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS action_log_at ON action_log(at DESC);
    `);
  }

  add(e: Omit<ActionLogEntry, "id" | "at">) {
    this.store.db
      .prepare("INSERT INTO action_log (at, who, node, action, args, reason, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(this.now(), e.who, e.node, e.action, redact(e.args).slice(0, 1000), e.reason ? redact(e.reason).slice(0, 400) : null, e.status, e.detail ? redact(e.detail).slice(0, 500) : null);
  }

  list(o: { who?: string; limit?: number } = {}): ActionLogEntry[] {
    const limit = Math.min(500, o.limit ?? 100);
    const rows = o.who ? this.store.db.prepare("SELECT * FROM action_log WHERE who = ? ORDER BY id DESC LIMIT ?").all(o.who, limit) : this.store.db.prepare("SELECT * FROM action_log ORDER BY id DESC LIMIT ?").all(limit);
    return (rows as unknown as (Omit<ActionLogEntry, "reason" | "detail"> & { reason: string | null; detail: string | null })[]).map((r) => ({ ...r, reason: r.reason ?? undefined, detail: r.detail ?? undefined }));
  }
}
