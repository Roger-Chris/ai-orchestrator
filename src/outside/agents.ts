import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { MemoryReplica } from "../shared/replica.js";
import type { Store } from "../store/db.js";
import type { OutsideAgent, OutsideAgentScopes, OutsideAuditEntry } from "../types.js";

/**
 * Outside agents (Jarvis phase 4): paid or third-party AI agents the owner lets in through MCP over
 * HTTP (`/mcp`). Each gets its own token (shown once, stored only as a SHA-256 hash) and scopes:
 * which devices, which folders, how risky a call may be (safe only, or ask = waits for the owner's
 * Approve), and whether it may write to the shared memory. Every call is audited here and, one
 * record per agent per day, in the shared memory. The kill switch (`paused`) stops all of them at
 * once; revoking stops one for good.
 */

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export class OutsideAgents {
  constructor(
    private store: Store,
    private replica?: MemoryReplica,
    private now: () => number = Date.now,
  ) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS outside_agents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, scopes TEXT NOT NULL,
        created_at INTEGER NOT NULL, revoked_at INTEGER, last_used INTEGER, calls INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS outside_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, at INTEGER NOT NULL, tool TEXT NOT NULL,
        summary TEXT NOT NULL, outcome TEXT NOT NULL, detail TEXT
      );
      CREATE INDEX IF NOT EXISTS outside_audit_at ON outside_audit(at DESC);
    `);
  }

  /** A new agent and its token; the token is never shown again. */
  create(name: string, scopes: OutsideAgentScopes): { agent: OutsideAgent; token: string } {
    const id = `a${randomBytes(4).toString("hex")}`;
    const token = `oa_${randomBytes(24).toString("hex")}`;
    this.store.db
      .prepare("INSERT INTO outside_agents (id, name, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, name.trim().slice(0, 80), hash(token), JSON.stringify(scopes), this.now());
    return { agent: this.get(id)!, token };
  }

  get(id: string): OutsideAgent | undefined {
    const r = this.store.db.prepare("SELECT * FROM outside_agents WHERE id = ?").get(id) as any;
    return r ? row(r) : undefined;
  }

  list(): OutsideAgent[] {
    return (this.store.db.prepare("SELECT * FROM outside_agents ORDER BY created_at DESC").all() as any[]).map(row);
  }

  /** The agent behind a bearer token, if it exists and is not revoked. */
  verify(token: string | undefined): OutsideAgent | undefined {
    if (!token?.startsWith("oa_")) return undefined;
    const h = hash(token);
    const r = this.store.db.prepare("SELECT * FROM outside_agents WHERE token_hash = ?").get(h) as any;
    if (!r || r.revoked_at) return undefined;
    // the lookup was by hash; compare again in constant time to be safe against odd collations
    if (!timingSafeEqual(Buffer.from(r.token_hash), Buffer.from(h))) return undefined;
    return row(r);
  }

  revoke(id: string): OutsideAgent | undefined {
    this.store.db.prepare("UPDATE outside_agents SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(this.now(), id);
    return this.get(id);
  }

  get paused(): boolean {
    return this.store.getPref<boolean>("outside.paused") === true;
  }

  /** The kill switch: true stops every outside agent at once (calls fail with "paused by the owner"). */
  setPaused(paused: boolean) {
    this.store.setPref("outside.paused", paused ? true : undefined);
  }

  /** One audited call: kept here, counted on the agent, and appended to today's shared-memory record. */
  audit(agent: OutsideAgent, tool: string, summary: string, outcome: OutsideAuditEntry["outcome"], detail?: string) {
    const at = this.now();
    this.store.db.prepare("INSERT INTO outside_audit (agent_id, at, tool, summary, outcome, detail) VALUES (?, ?, ?, ?, ?, ?)").run(agent.id, at, tool, summary.slice(0, 500), outcome, detail?.slice(0, 2000) ?? null);
    this.store.db.prepare("UPDATE outside_agents SET last_used = ?, calls = calls + 1 WHERE id = ?").run(at, agent.id);
    if (!this.replica) return;
    try {
      const day = new Date(at).toISOString().slice(0, 10);
      const uid = `work:outside-${agent.id}-${day}`;
      const cur = this.replica.get(uid);
      const line = `${new Date(at).toISOString().slice(11, 19)} ${tool} ${outcome}: ${summary.slice(0, 200)}`;
      const lines = [...(cur?.body ? cur.body.split("\n") : []), line].slice(-300);
      this.replica.put({
        uid,
        kind: "work",
        title: `Outside agent ${agent.name} on ${day}`,
        body: lines.join("\n"),
        data: { outsideAgent: agent.id, name: agent.name, day, calls: lines.length },
        tags: ["audit", "outside-agent"],
        source: "orchestrator",
      });
    } catch {
      /* the hub's own audit table is the record; memory is best-effort */
    }
  }

  auditLog(opts: { agent?: string; limit?: number } = {}): OutsideAuditEntry[] {
    const rows = opts.agent
      ? this.store.db.prepare("SELECT * FROM outside_audit WHERE agent_id = ? ORDER BY at DESC LIMIT ?").all(opts.agent, opts.limit ?? 100)
      : this.store.db.prepare("SELECT * FROM outside_audit ORDER BY at DESC LIMIT ?").all(opts.limit ?? 100);
    return (rows as any[]).map((r) => ({ agentId: r.agent_id, at: r.at, tool: r.tool, summary: r.summary, outcome: r.outcome, detail: r.detail ?? undefined }));
  }
}

function row(r: any): OutsideAgent {
  return { id: r.id, name: r.name, scopes: JSON.parse(r.scopes), createdAt: r.created_at, revokedAt: r.revoked_at ?? undefined, lastUsed: r.last_used ?? undefined, calls: r.calls };
}
