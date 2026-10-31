import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.js";
import type { ProviderPool } from "../providers/registry.js";
import type { MemoryReplica } from "../shared/replica.js";
import type { ActionLog } from "./log.js";
import { type ActionContext, type ActionResult, ACTIONS, findAction, type Risk, redact, riskOf } from "./registry.js";

/**
 * Running actions, and the approvals that gate the risky ones.
 *
 * Every device runs an `ActionRunner` (`POST /node/act`). A safe action runs at once; an `ask`
 * action runs only with the id of an approval the owner granted. The hub that the request came
 * through keeps the approvals (`ApprovalDesk`), notifies the phone, and once Approve is tapped
 * calls the device again with the approval id. The device checks that id with the hub (same
 * action, same arguments, not used before) before it runs anything.
 */

export interface ActRequest {
  action: string;
  args?: Record<string, unknown>;
  /** Why the assistant wants this; shown on the phone. */
  reason?: string;
  /** Approval id, when the owner already approved this exact call. */
  approval?: string;
}

export type ActResponse =
  | { status: "done"; node: string; action: string; result: ActionResult }
  | { status: "needs_approval"; node: string; action: string; summary: string; risk: Risk }
  | { status: "refused"; node: string; action: string; error: string };

export function argsHash(action: string, args: unknown): string {
  return createHash("sha256").update(`${action}\n${stable(args ?? {})}`).digest("hex").slice(0, 32);
}

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/**
 * "May this approval run this call here?" A yes also uses the approval up, in the same step, so
 * one tap on Approve runs one call. The hub that holds the approval answers.
 */
export type ApprovalCheck = (id: string, action: string, hash: string, node: string) => Promise<boolean>;

export class ActionRunner {
  constructor(
    private config: Config,
    private deps: { pool?: ProviderPool; replica?: MemoryReplica; check?: ApprovalCheck; extra?: Pick<ActionContext, "files" | "sendFile"> },
  ) {}

  get node() {
    return this.config.node.name;
  }

  list() {
    return ACTIONS.map((a) => ({ name: a.name, describe: a.describe, risk: riskOf(a, {}, this.ctx()) }));
  }

  private ctx(signal?: AbortSignal): ActionContext {
    return { config: this.config, pool: this.deps.pool, replica: this.deps.replica, signal, ...this.deps.extra };
  }

  async act(req: ActRequest, signal?: AbortSignal): Promise<ActResponse> {
    const node = this.node;
    if (!this.config.actions.enabled) return { status: "refused", node, action: req.action, error: `actions are off on ${node} (actions.enabled)` };
    const d = findAction(req.action);
    if (!d) return { status: "refused", node, action: req.action, error: `unknown action ${req.action}` };
    const parsed = d.args.safeParse(req.args ?? {});
    if (!parsed.success) return { status: "refused", node, action: d.name, error: `bad arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
    const args = parsed.data;
    const ctx = this.ctx(signal);
    const risk = riskOf(d, args, ctx);
    if (risk === "never") return { status: "refused", node, action: d.name, error: "the assistant never does this" };
    if (risk === "ask") {
      if (!req.approval) return { status: "needs_approval", node, action: d.name, summary: d.summary(args), risk };
      const ok = this.deps.check ? await this.deps.check(req.approval, d.name, argsHash(d.name, req.args ?? {}), node).catch(() => false) : false;
      if (!ok) return { status: "refused", node, action: d.name, error: "approval not valid for this call (wrong action or arguments, expired, or already used)" };
    }
    let result: ActionResult;
    try {
      result = await d.run(args, ctx);
    } catch (e) {
      result = { ok: false, output: redact((e as Error).message) };
    }
    if (risk === "ask") this.remember(d.name, d.summary(args), result, req.reason);
    return { status: "done", node, action: d.name, result };
  }

  /** Approved actions are kept in shared memory: what was done, where, and how it went. */
  private remember(action: string, summary: string, result: ActionResult, reason?: string) {
    try {
      this.deps.replica?.put({
        kind: "work",
        title: `${result.ok ? "Did" : "Failed"} on ${this.node}: ${summary}`.slice(0, 200),
        body: [reason && `Why: ${reason}`, `Result:\n${result.output.slice(0, 2000)}`].filter(Boolean).join("\n\n"),
        data: { action, node: this.node, ok: result.ok },
        source: "action",
        tags: `action,${this.node}`,
      });
    } catch {
      /* memory is best-effort */
    }
  }
}

// ---------------------------------------------------------------- approvals (on the hub)

export interface Approval {
  id: string;
  node: string;
  action: string;
  args: Record<string, unknown>;
  hash: string;
  summary: string;
  reason?: string;
  /** Who asked: absent = the owner's own assistant; "agent:<name>" = an outside agent (Jarvis A1). */
  by?: string;
  status: "pending" | "approved" | "denied" | "expired" | "done" | "failed";
  createdAt: number;
  expiresAt: number;
  decidedAt?: number;
  usedAt?: number;
  result?: ActionResult;
}

export class ApprovalDesk {
  constructor(
    private db: DatabaseSync,
    private config: Config,
    private notify: (title: string, body: string, id: string) => void = () => undefined,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY, node TEXT NOT NULL, action TEXT NOT NULL, args TEXT NOT NULL, hash TEXT NOT NULL,
      summary TEXT NOT NULL, reason TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      decided_at INTEGER, used_at INTEGER, result TEXT
    )`);
    // Older hubs: who asked was added later (U1: outside agents' requests marked on Home).
    const cols = (db.prepare("PRAGMA table_info(approvals)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("requested_by")) db.exec("ALTER TABLE approvals ADD COLUMN requested_by TEXT");
  }

  request(r: { node: string; action: string; args: Record<string, unknown>; summary: string; reason?: string; by?: string }, now = Date.now()): Approval {
    const a: Approval = {
      id: randomUUID(),
      node: r.node,
      action: r.action,
      args: r.args,
      hash: argsHash(r.action, r.args),
      summary: redact(r.summary),
      reason: r.reason ? redact(r.reason) : undefined,
      by: r.by,
      status: "pending",
      createdAt: now,
      expiresAt: now + this.config.actions.approvalMinutes * 60_000,
    };
    this.db
      .prepare("INSERT INTO approvals (id, node, action, args, hash, summary, reason, requested_by, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(a.id, a.node, a.action, JSON.stringify(a.args), a.hash, a.summary, a.reason ?? null, a.by ?? null, a.status, a.createdAt, a.expiresAt);
    const who = a.by?.startsWith("agent:") ? ` (asked by ${a.by.slice(6)})` : "";
    this.notify(`Approve on ${a.node}?${who}`, `${a.summary}${a.reason ? `\nWhy: ${a.reason}` : ""}`, a.id);
    return a;
  }

  get(id: string, now = Date.now()): Approval | undefined {
    const r = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as any;
    if (!r) return undefined;
    const a = toApproval(r);
    if ((a.status === "pending" || a.status === "approved") && a.expiresAt < now && !a.usedAt) {
      this.db.prepare("UPDATE approvals SET status = 'expired' WHERE id = ?").run(id);
      a.status = "expired";
    }
    return a;
  }

  list(status?: Approval["status"], now = Date.now()): Approval[] {
    const rows = (status
      ? this.db.prepare("SELECT id FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT 100").all(status)
      : this.db.prepare("SELECT id FROM approvals ORDER BY created_at DESC LIMIT 100").all()) as { id: string }[];
    return rows.map((r) => this.get(r.id, now)!).filter((a) => !status || a.status === status);
  }

  decide(id: string, approve: boolean, now = Date.now()): Approval {
    const a = this.get(id, now);
    if (!a) throw new Error("no such approval");
    if (a.status !== "pending") throw new Error(`already ${a.status}`);
    this.db.prepare("UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?").run(approve ? "approved" : "denied", now, id);
    return this.get(id, now)!;
  }

  /** The device's question: is this an approved, unused, unexpired approval for exactly this call? */
  valid(id: string, action: string, hash: string, node: string, now = Date.now()): boolean {
    const a = this.get(id, now);
    return !!a && a.status === "approved" && !a.usedAt && a.action === action && a.hash === hash && a.node === node;
  }

  markUsed(id: string, now = Date.now()) {
    this.db.prepare("UPDATE approvals SET used_at = ? WHERE id = ? AND used_at IS NULL").run(now, id);
  }

  /** valid() and markUsed() as one step: true once, for the call it was granted for. */
  claim(id: string, action: string, hash: string, node: string, now = Date.now()): boolean {
    if (!this.valid(id, action, hash, node, now)) return false;
    const r = this.db.prepare("UPDATE approvals SET used_at = ? WHERE id = ? AND used_at IS NULL").run(now, id);
    return Number(r.changes) === 1;
  }

  finish(id: string, result: ActionResult) {
    this.db.prepare("UPDATE approvals SET status = ?, result = ? WHERE id = ?").run(result.ok ? "done" : "failed", JSON.stringify(result), id);
  }
}

function toApproval(r: any): Approval {
  return {
    id: r.id,
    node: r.node,
    action: r.action,
    args: JSON.parse(r.args),
    hash: r.hash,
    summary: r.summary,
    reason: r.reason ?? undefined,
    by: r.requested_by ?? undefined,
    status: r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    decidedAt: r.decided_at ?? undefined,
    usedAt: r.used_at ?? undefined,
    result: r.result ? JSON.parse(r.result) : undefined,
  };
}

// ---------------------------------------------------------------- the hub's front door

export type PeerAct = (node: string, req: ActRequest) => Promise<ActResponse>;

/**
 * `POST /api/act`: run an action on this device or a peer. A call that needs approval becomes an
 * approval here and returns `pending`; `approve()` later runs it and stores the result.
 */
export class ActionHub {
  constructor(
    readonly runner: ActionRunner,
    readonly desk: ApprovalDesk,
    private peer: PeerAct,
    /** Who did what: every call, whether it ran, waits for you or was refused. */
    readonly log?: ActionLog,
  ) {}

  private record(who: string, node: string, req: ActRequest, status: string, detail?: string) {
    try {
      this.log?.add({ who, node, action: req.action, args: JSON.stringify(req.args ?? {}), reason: req.reason, status, detail });
    } catch {
      /* the log must never stop the action it describes */
    }
  }

  private send(node: string | undefined, req: ActRequest) {
    return !node || node === this.runner.node ? this.runner.act(req) : this.peer(node, req);
  }

  /** `noApprovals`: a call that would need the owner's Approve is refused instead of asked (outside agents limited to safe calls). */
  async act(node: string | undefined, req: ActRequest, opts: { noApprovals?: boolean; by?: string; who?: string } = {}): Promise<ActResponse | { status: "pending";node: string; action: string; approval: Approval }> {
    const target = node || this.runner.node;
    const who = opts.who ?? opts.by ?? "owner";
    const res = await this.send(target, { action: req.action, args: req.args, reason: req.reason });
    this.record(who, target, req, res.status === "done" ? (res.result.ok ? "done" : "failed") : res.status === "needs_approval" ? (opts.noApprovals ? "refused" : "waiting for approval") : "refused", res.status === "done" ? res.result.output : res.status === "refused" ? res.error : undefined);
    if (res.status !== "needs_approval") return res;
    if (opts.noApprovals) return { status: "refused", node: target, action: req.action, error: "this needs the owner's approval, which this caller may not ask for" };
    const approval = this.desk.request({ node: target, action: req.action, args: req.args ?? {}, summary: res.summary, reason: req.reason, by: opts.by });
    return { status: "pending", node: target, action: req.action, approval };
  }

  /** The owner tapped Approve (or Deny). Approve runs the call now and keeps the result. */
  async decide(id: string, approve: boolean): Promise<Approval> {
    const a = this.desk.decide(id, approve);
    if (!approve) {
      this.record("owner", a.node, { action: a.action, args: a.args, reason: a.reason }, "denied");
      return a;
    }
    const res = await this.send(a.node, { action: a.action, args: a.args, reason: a.reason, approval: a.id }).catch(
      (e): ActResponse => ({ status: "refused", node: a.node, action: a.action, error: (e as Error).message }),
    );
    this.desk.markUsed(id);
    const result: ActionResult = res.status === "done" ? res.result : { ok: false, output: res.status === "refused" ? res.error : "the device asked for approval again" };
    this.desk.finish(id, result);
    this.record(`owner approved for ${a.by ?? "assistant"}`, a.node, { action: a.action, args: a.args, reason: a.reason }, result.ok ? "done" : "failed", result.output);
    return this.desk.get(id)!;
  }
}
