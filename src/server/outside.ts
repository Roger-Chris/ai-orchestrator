import type { Hono } from "hono";
import { z } from "zod";
import type { OutsideAgents } from "../outside/agents.js";
import { handleMcp, type McpDeps } from "../outside/mcp.js";

/**
 * Outside agents over HTTP (Jarvis phase 4).
 * - `POST /mcp`: MCP (JSON-RPC 2.0, single or batch) for an outside agent, with ITS token
 *   (`Authorization: Bearer oa_…`). The owner's server token does not work here, and theirs works nowhere else.
 * - `/api/outside-agents*` (owner's token, the app): list, create (the token is shown once), revoke,
 *   the kill switch (`paused`), and the audit log.
 */

const Scopes = z.object({
  devices: z.array(z.string().min(1).max(120)).max(50).default([]),
  folders: z.array(z.string().min(1).max(500)).max(50).default([]),
  risk: z.enum(["safe", "ask"]).default("safe"),
  memoryWrite: z.boolean().default(false),
});
const Create = z.object({ name: z.string().min(1).max(80), scopes: Scopes.prefault({}) });

export function mountOutside(app: Hono, d: { outside?: OutsideAgents } & Omit<McpDeps, "agents">) {
  app.get("/mcp", (c) => c.json({ error: "POST JSON-RPC messages here (no event stream)" }, 405));
  app.delete("/mcp", (c) => c.json({ error: "no sessions to end" }, 405));
  app.post("/mcp", async (c) => {
    if (!d.outside) return c.json({ error: "outside agents are not set up on this hub" }, 404);
    const agent = d.outside.verify(c.req.header("authorization")?.replace(/^Bearer\s+/i, ""));
    if (!agent) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "unauthorized: an outside agent token is needed" } }, 401);
    const body = await c.req.json().catch(() => undefined);
    const deps: McpDeps = { agents: d.outside, replica: d.replica, actions: d.actions, devices: d.devices };
    const one = (m: any) => (m && typeof m.method === "string" ? handleMcp(agent, m, deps) : Promise.resolve({ jsonrpc: "2.0", id: m?.id ?? null, error: { code: -32600, message: "invalid request" } }));
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map(one))).filter(Boolean);
      return out.length ? c.json(out) : c.body(null, 202);
    }
    const out = await one(body);
    return out ? c.json(out) : c.body(null, 202);
  });

  const off = (c: any) => c.json({ error: "outside agents are not set up on this hub" }, 404);
  app.get("/api/outside-agents", (c) => (d.outside ? c.json({ agents: d.outside.list(), paused: d.outside.paused }) : off(c)));
  app.post("/api/outside-agents", async (c) => {
    if (!d.outside) return off(c);
    const body = Create.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "invalid agent", issues: body.error.issues }, 400);
    return c.json(d.outside.create(body.data.name, body.data.scopes));
  });
  app.post("/api/outside-agents/:id/revoke", (c) => {
    if (!d.outside) return off(c);
    const a = d.outside.revoke(c.req.param("id"));
    return a ? c.json(a) : c.json({ error: "no such agent" }, 404);
  });
  app.put("/api/outside-agents/paused", async (c) => {
    if (!d.outside) return off(c);
    const { paused } = z.object({ paused: z.boolean() }).parse(await c.req.json());
    d.outside.setPaused(paused);
    return c.json({ paused: d.outside.paused });
  });
  app.get("/api/outside-agents/audit", (c) => (d.outside ? c.json(d.outside.auditLog({ agent: c.req.query("agent") || undefined, limit: Math.min(500, Number(c.req.query("limit") ?? 100)) })) : off(c)));
}
