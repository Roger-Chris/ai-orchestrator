import { createWriteStream, rmSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Hono } from "hono";
import { z } from "zod";
import type { PhoneDesk } from "../phone/desk.js";
import { nameOf, TryoutError, type Tryout, type TryoutDesk } from "../tryout/desk.js";

const StartBody = z.object({
  source: z.string().max(2000).optional(),
  /** Who sent it on WhatsApp: "Kishanujith", "Jitho san". */
  from: z.string().max(120).optional(),
  goal: z.string().max(2000).optional(),
  by: z.string().max(80).optional(),
});

const MAX_UPLOAD = 300 * 1024 * 1024;

/** What the app shows: names, states, summaries, where the project went, and the video's download link. */
function pub(t: Tryout, phone?: PhoneDesk) {
  const { dir: _dir, video, ...rest } = t;
  const key = t.phoneActionId ? phone?.list().find((a) => a.id === t.phoneActionId)?.fileKey : undefined;
  return { ...rest, hasVideo: !!video, videoUrl: key && phone?.fileFor(key) ? `/f/${key}` : undefined };
}

/**
 * Tryouts (src/tryout).
 * - `POST /api/tryouts {source | from, goal?, by?}`: download it (or find what `from` sent on WhatsApp), set it up, run it, record it.
 * - `POST /api/tryouts/upload?name=<file>&goal=…`: the file is the raw body (the app streams it from disk); then the same.
 * - `GET /api/tryouts`, `GET /api/tryouts/:id`, `POST /api/tryouts/:id/cancel`.
 */
export function mountTryouts(app: Hono, d: { tryouts?: TryoutDesk; phone?: PhoneDesk }) {
  const off = (c: any) => c.json({ error: "tryouts are not set up on this hub" }, 404);
  const fail = (c: any, e: unknown) => (e instanceof TryoutError ? c.json({ error: e.message }, e.status) : Promise.reject(e));
  app.post("/api/tryouts", async (c) => {
    if (!d.tryouts) return off(c);
    const parsed = StartBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success || (!parsed.data.source?.trim() && !parsed.data.from?.trim())) return c.json({ error: "give a source (a git URL, a link to a file or archive, a path on the hub) or who sent it on WhatsApp (from)" }, 400);
    try {
      return c.json(pub(d.tryouts.start(parsed.data), d.phone), 202);
    } catch (e) {
      return fail(c, e);
    }
  });
  app.post("/api/tryouts/upload", async (c) => {
    if (!d.tryouts) return off(c);
    const name = (c.req.query("name") ?? "").trim();
    if (!name) return c.json({ error: "say the file's name: ?name=project.zip" }, 400);
    if (!c.req.raw.body) return c.json({ error: "no file in the request" }, 400);
    const path = d.tryouts.uploadPath(name);
    let size = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        done(size > MAX_UPLOAD ? new Error("too big") : null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(c.req.raw.body as any), cap, createWriteStream(path));
    } catch (e) {
      rmSync(path, { force: true });
      return c.json({ error: (e as Error).message === "too big" ? `the file is over ${MAX_UPLOAD / 1024 / 1024} MB` : `the upload broke off: ${(e as Error).message}` }, (e as Error).message === "too big" ? 413 : 400);
    }
    if (!size) {
      rmSync(path, { force: true });
      return c.json({ error: "the file was empty" }, 400);
    }
    try {
      return c.json(pub(d.tryouts.start({ source: path, name: nameOf(name), goal: c.req.query("goal") || undefined, by: "app" }), d.phone), 202);
    } catch (e) {
      return fail(c, e);
    }
  });
  app.get("/api/tryouts", (c) => (d.tryouts ? c.json(d.tryouts.list(Number(c.req.query("limit") ?? 30)).map((t) => pub(t, d.phone))) : off(c)));
  app.get("/api/tryouts/:id", (c) => {
    if (!d.tryouts) return off(c);
    const t = d.tryouts.get(c.req.param("id"));
    return t ? c.json(pub(t, d.phone)) : c.json({ error: "no such tryout" }, 404);
  });
  app.post("/api/tryouts/:id/cancel", (c) => {
    if (!d.tryouts) return off(c);
    try {
      return c.json(pub(d.tryouts.cancel(c.req.param("id")), d.phone));
    } catch (e) {
      return fail(c, e);
    }
  });
}
