import type { Hono } from "hono";
import { z } from "zod";
import { type FileClient, receiveFile } from "../files/client.js";
import type { FileIndex } from "../files/index.js";
import type { Config } from "../config.js";

/**
 * Files across devices over HTTP (Jarvis D2).
 * - `POST /node/files/index`: a device sends its file list to the hub (names, sizes, dates).
 * - `POST /node/files/receive?path=`: another device copies a file here (`files.send`, approved on
 *   the sending side); written inside this device's first assistant folder, never replacing.
 * - `GET /api/files/search?q=&node=&ext=`, `GET /api/files/nodes`: the index, for the app and the brain.
 */

const IndexBody = z.object({
  node: z.string().min(1).max(120),
  roots: z.array(z.string()).max(50),
  files: z.array(z.object({ path: z.string().max(4000), size: z.number(), mtime: z.number() })).max(2_000_000),
  truncated: z.boolean().default(false),
});

export function mountFiles(app: Hono, d: { config: Config; fileIndex?: FileIndex; files?: FileClient }) {
  app.post("/node/files/index", async (c) => {
    if (!d.fileIndex || !d.files) return c.json({ error: "this device is not the hub that keeps the file index" }, 404);
    const body = IndexBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: "bad file list" }, 400);
    await d.files.receiveIndex(body.data.node, body.data.roots, body.data.files, body.data.truncated);
    return c.json({ ok: true, files: body.data.files.length });
  });
  app.post("/node/files/receive", async (c) => {
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path is required" }, 400);
    const bytes = Buffer.from(await c.req.arrayBuffer());
    if (bytes.length > d.config.actions.sendMaxMB * 1024 * 1024) return c.json({ error: "too big (actions.sendMaxMB)" }, 413);
    try {
      return c.json({ path: receiveFile(d.config, path, bytes) });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });
  app.get("/api/files/search", async (c) => {
    if (!d.files) return c.json({ error: "the file index is not set up" }, 404);
    const q = c.req.query("q") ?? "";
    try {
      return c.json(await d.files.search(q, { node: c.req.query("node") || undefined, ext: c.req.query("ext") || undefined, limit: Number(c.req.query("limit") ?? 30) }));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 502);
    }
  });
  app.get("/api/files/nodes", (c) => c.json(d.fileIndex?.nodes() ?? []));
}
