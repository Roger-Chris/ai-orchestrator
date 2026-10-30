import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { insideRoots } from "../actions/registry.js";
import type { Config } from "../config.js";
import type { PushPayload } from "../server/push.js";
import type { Store } from "../store/db.js";
import type { PhoneAction } from "../types.js";

/**
 * Things the assistant wants done on the phone (Jarvis D3): an alarm, a reminder, opening an app,
 * a file to save, a call or a text. Android only lets a visible app do these, so each one waits on
 * the phone's "Phone" screen and runs when the owner taps Do it; calls and texts only open the
 * dialer or the message composer with the words filled in. Nothing is ever dialled or sent.
 */

export const PhoneActionInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("alarm"), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59), label: z.string().max(120).optional() }),
  z.object({ kind: z.literal("reminder"), at: z.string().min(10).max(40), text: z.string().min(1).max(500) }),
  z.object({ kind: z.literal("open_app"), app: z.string().min(1).max(80), package: z.string().regex(/^[\w.]+$/).max(200).optional() }),
  z.object({ kind: z.literal("call"), number: z.string().regex(/^\+?[\d\s()-]{3,20}$/), name: z.string().max(80).optional() }),
  z.object({ kind: z.literal("sms"), number: z.string().regex(/^\+?[\d\s()-]{3,20}$/), text: z.string().min(1).max(1000), name: z.string().max(80).optional() }),
  z.object({ kind: z.literal("file"), path: z.string().min(1).max(1000) }),
]);
export type PhoneActionInput = z.infer<typeof PhoneActionInput>;

const TTL_MS = 24 * 3_600_000;

export function describePhoneAction(a: PhoneActionInput): string {
  switch (a.kind) {
    case "alarm":
      return `Set an alarm for ${String(a.hour).padStart(2, "0")}:${String(a.minute).padStart(2, "0")}${a.label ? ` (${a.label})` : ""}`;
    case "reminder":
      return `Remind you at ${a.at.replace("T", " ").slice(0, 16)}: ${a.text}`;
    case "open_app":
      return `Open ${a.app}`;
    case "call":
      return `Call ${a.name ?? a.number} (opens the dialer; you press call)`;
    case "sms":
      return `Text ${a.name ?? a.number}: "${a.text.slice(0, 80)}" (opens the message; you press send)`;
    case "file":
      return `Save ${basename(a.path)} on the phone`;
  }
}

export class PhoneDesk {
  constructor(
    private store: Store,
    private config: Config,
    private notify?: (p: PushPayload) => void,
    private now: () => number = Date.now,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS phone_actions (id TEXT PRIMARY KEY, record TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  }

  add(input: PhoneActionInput, reason?: string): PhoneAction {
    const a = PhoneActionInput.parse(input);
    if (a.kind === "reminder" && Number.isNaN(Date.parse(a.at))) throw new Error(`could not read the time ${a.at}; use ISO 8601 like 2026-11-02T17:00`);
    let fileKey: string | undefined;
    if (a.kind === "file") {
      // Only files in this hub's assistant folders, never secrets; the phone downloads it by key.
      const real = insideRoots(a.path, this.config);
      if (!statSync(real).isFile()) throw new Error(`${a.path} is not a file`);
      a.path = real;
      fileKey = randomBytes(16).toString("hex");
    }
    const rec: PhoneAction = { id: `p${randomBytes(4).toString("hex")}`, action: a, summary: describePhoneAction(a), reason, status: "pending", fileKey, createdAt: this.now() };
    this.store.db.prepare("INSERT INTO phone_actions (id, record, status, created_at) VALUES (?, ?, ?, ?)").run(rec.id, JSON.stringify(rec), rec.status, rec.createdAt);
    this.notify?.({ title: "On your phone?", body: rec.summary, url: "/phone", tag: `phone-${rec.id}` });
    return rec;
  }

  get(id: string): PhoneAction | undefined {
    const row = this.store.db.prepare("SELECT record FROM phone_actions WHERE id = ?").get(id) as { record: string } | undefined;
    return row ? this.fresh(JSON.parse(row.record)) : undefined;
  }

  list(status?: PhoneAction["status"]): PhoneAction[] {
    const rows = this.store.db.prepare("SELECT record FROM phone_actions WHERE created_at > ? ORDER BY created_at DESC LIMIT 50").all(this.now() - 7 * TTL_MS) as { record: string }[];
    return rows.map((r) => this.fresh(JSON.parse(r.record))).filter((a) => !status || a.status === status);
  }

  /** Pending ones older than a day are expired: an alarm from yesterday is no use. */
  private fresh(a: PhoneAction): PhoneAction {
    return a.status === "pending" && this.now() - a.createdAt > TTL_MS ? { ...a, status: "expired" } : a;
  }

  /** The phone did it (or the owner said no). */
  close(id: string, status: "done" | "dismissed"): PhoneAction {
    const a = this.get(id);
    if (!a) throw new Error("no such phone action");
    if (a.status !== "pending") return a;
    const next = { ...a, status, closedAt: this.now() };
    this.store.db.prepare("UPDATE phone_actions SET record = ?, status = ? WHERE id = ?").run(JSON.stringify(next), status, id);
    return next;
  }

  /** The file behind a download key, while its action is pending (or done in the last day). */
  fileFor(key: string): string | undefined {
    const a = this.list().find((x) => x.fileKey === key && x.status !== "dismissed" && x.status !== "expired");
    return a && a.action.kind === "file" && existsSync(a.action.path) ? a.action.path : undefined;
  }
}
