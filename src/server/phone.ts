import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import type { Hono } from "hono";
import { PhoneActionInput, type PhoneDesk } from "../phone/desk.js";

/**
 * The phone's to-do from the assistant (Jarvis D3).
 * - `POST /api/phone/actions {kind, ..., reason?}`: the brain's `phone` tool (or the app) asks for one.
 * - `GET /api/phone/actions?status=pending`, `POST /api/phone/actions/:id/{done,dismiss}`: the app.
 * - `GET /f/<key>`: a file for the phone to save, by an unguessable key (no token, so the browser can download it).
 */
export function mountPhone(app: Hono, d: { phone?: PhoneDesk }) {
  const off = (c: any) => c.json({ error: "phone actions are not set up on this hub" }, 404);
  app.post("/api/phone/actions", async (c) => {
    if (!d.phone) return off(c);
    const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = PhoneActionInput.safeParse(raw);
    if (!parsed.success) return c.json({ error: `not a phone action: ${parsed.error.issues.map((i) => `${i.path.join(".") || "kind"}: ${i.message}`).join("; ")}` }, 400);
    try {
      return c.json(d.phone.add(parsed.data, typeof raw.reason === "string" ? raw.reason.slice(0, 500) : undefined));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });
  app.get("/api/phone/actions", (c) => (d.phone ? c.json(d.phone.list((c.req.query("status") as any) || undefined)) : off(c)));
  for (const [verb, status] of [["done", "done"], ["dismiss", "dismissed"]] as const) {
    app.post(`/api/phone/actions/:id/${verb}`, (c) => {
      if (!d.phone) return off(c);
      try {
        return c.json(d.phone.close(c.req.param("id"), status));
      } catch (e) {
        return c.json({ error: (e as Error).message }, 404);
      }
    });
  }
  app.get("/f/:key", (c) => {
    const file = d.phone?.fileFor(c.req.param("key"));
    if (!file) return c.text("not found", 404);
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(statSync(file).size), "Content-Disposition": `attachment; filename="${basename(file).replace(/"/g, "")}"`, "Cache-Control": "no-store" },
    });
  });
}
