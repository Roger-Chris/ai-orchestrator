import type { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.js";
import { KINDS, type MemoryReplica } from "../shared/replica.js";

/**
 * Shared memory over HTTP.
 *
 * - `/api/shared-memory/*`: this device's replica (search, about, remember…). Works offline;
 *   used by the phone, the web app, `orc mcp` and the thinking loop.
 * - `/node/memory/*`: only on the machine that runs the brain. Other devices' replicas sync
 *   through it (the brain itself listens on 127.0.0.1 only). Passed through to the brain's
 *   `/memory/*` with BRAIN_TOKEN.
 */
export function mountSharedMemory(app: Hono, d: { config: Config; replica?: MemoryReplica; brainFetch?: typeof fetch }) {
  const r = d.replica;
  const off = { error: "shared memory is off on this device (sharedMemory.enabled)" };

  app.get("/api/shared-memory/status", (c) => c.json(r ? r.syncStatus() : { ...off, ok: false }));
  app.post("/api/shared-memory/sync", async (c) => {
    if (!r) return c.json(off, 404);
    try {
      return c.json({ pulled: await r.sync(), ...r.syncStatus() });
    } catch (e) {
      return c.json({ error: (e as Error).message, ...r.syncStatus() }, 502);
    }
  });
  app.get("/api/shared-memory/search", (c) => {
    if (!r) return c.json(off, 404);
    const q = c.req.query("q") ?? "";
    return c.json(r.search(q, { kind: c.req.query("kind") || undefined, limit: Number(c.req.query("limit") ?? 10) }));
  });
  app.get("/api/shared-memory/recent", (c) => {
    if (!r) return c.json(off, 404);
    return c.json(r.recent({ kind: c.req.query("kind") || undefined, limit: Number(c.req.query("limit") ?? 20) }));
  });
  app.get("/api/shared-memory/about", (c) => {
    if (!r) return c.json(off, 404);
    const found = r.about(c.req.query("name") ?? "");
    return found ? c.json(found) : c.json({ error: "nothing in memory about that" }, 404);
  });
  app.get("/api/shared-memory/record/*", (c) => {
    if (!r) return c.json(off, 404);
    const uid = decodeURIComponent(c.req.path.replace(/^\/api\/shared-memory\/record\//, ""));
    const rec = r.get(uid);
    return rec ? c.json(rec) : c.json({ error: "no such record" }, 404);
  });
  const Remember = z.object({
    text: z.string().min(1),
    title: z.string().optional(),
    kind: z.enum(["note", "fact", "decision"]).default("note"),
    subject: z.string().optional(),
    tags: z.union([z.string(), z.array(z.string())]).optional(),
  });
  app.post("/api/shared-memory/remember", async (c) => {
    if (!r) return c.json(off, 404);
    const body = Remember.parse(await c.req.json());
    const subject = body.subject ? r.resolve(body.subject)?.uid : undefined;
    const rec = r.put({
      kind: body.kind,
      title: body.title ?? body.text.split(/\s+/).join(" ").slice(0, 80),
      body: body.text,
      subject: subject ?? null,
      tags: body.tags,
      source: "manual",
    });
    void r.sync().catch(() => undefined); // straight up when online; queued otherwise
    return c.json(rec);
  });
  const Put = z.object({
    uid: z.string().optional(),
    kind: z.enum(KINDS),
    title: z.string().optional(),
    body: z.string().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
    tags: z.union([z.string(), z.array(z.string())]).optional(),
    aliases: z.union([z.string(), z.array(z.string())]).optional(),
    subject: z.string().nullable().optional(),
    source: z.string().optional(),
  });
  app.put("/api/shared-memory/record", async (c) => {
    if (!r) return c.json(off, 404);
    const rec = r.put(Put.parse(await c.req.json()));
    void r.sync().catch(() => undefined);
    return c.json(rec);
  });
  app.delete("/api/shared-memory/record/*", (c) => {
    if (!r) return c.json(off, 404);
    const uid = decodeURIComponent(c.req.path.replace(/^\/api\/shared-memory\/record\//, ""));
    const ok = r.forget(uid);
    if (ok) void r.sync().catch(() => undefined);
    return c.json({ deleted: ok });
  });

  // ---- the brain's thinking loop (AI_Assistant agent.py), for the phone app and the web app
  app.post("/api/assistant/ask", async (c) => {
    const { url, token } = d.config.assistant;
    if (!token) return c.json({ error: `device ${d.config.node.name} does not run the brain` }, 404);
    const body = z.object({ text: z.string().min(1), source: z.string().default("app") }).parse(await c.req.json());
    try {
      const res = await (d.brainFetch ?? fetch)(`${url.replace(/\/$/, "")}/agent/ask`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15 * 60_000),
      });
      return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json" } });
    } catch (e) {
      return c.json({ error: `brain not reachable: ${(e as Error).message}` }, 502);
    }
  });

  // ---- the memory hub: other devices' replicas sync through here
  app.all("/node/memory/*", async (c) => {
    const { url, token } = d.config.assistant;
    if (!token) return c.json({ error: `device ${d.config.node.name} does not run the brain; set sharedMemory.hub to the Linux hub` }, 404);
    const rest = c.req.path.replace(/^\/node\/memory/, "");
    const query = new URL(c.req.url).search;
    const method = c.req.method;
    try {
      const res = await (d.brainFetch ?? fetch)(`${url.replace(/\/$/, "")}/memory${rest}${query}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: method === "GET" || method === "HEAD" ? undefined : await c.req.text(),
        signal: AbortSignal.timeout(30_000),
      });
      return new Response(await res.text(), { status: res.status, headers: { "Content-Type": res.headers.get("content-type") ?? "application/json" } });
    } catch (e) {
      return c.json({ error: `brain not reachable: ${(e as Error).message}` }, 502);
    }
  });
}
