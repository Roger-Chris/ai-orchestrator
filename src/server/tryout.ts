import type { Hono } from "hono";
import { z } from "zod";
import { TryoutError, type Tryout, type TryoutDesk } from "../tryout/desk.js";

const StartBody = z.object({
  source: z.string().min(1).max(2000),
  goal: z.string().max(2000).optional(),
  by: z.string().max(80).optional(),
});

/** The owner sees names, states and summaries; folders on the hub stay on the hub. */
function pub(t: Tryout) {
  const { dir: _dir, video, ...rest } = t;
  return { ...rest, hasVideo: !!video };
}

/**
 * Tryouts (src/tryout).
 * - `POST /api/tryouts {source, goal?, by?}`: download it, set it up, run it, record it; the video comes to the phone.
 * - `GET /api/tryouts`, `GET /api/tryouts/:id`, `POST /api/tryouts/:id/cancel`.
 */
export function mountTryouts(app: Hono, d: { tryouts?: TryoutDesk }) {
  const off = (c: any) => c.json({ error: "tryouts are not set up on this hub" }, 404);
  const fail = (c: any, e: unknown) => (e instanceof TryoutError ? c.json({ error: e.message }, e.status) : Promise.reject(e));
  app.post("/api/tryouts", async (c) => {
    if (!d.tryouts) return off(c);
    const parsed = StartBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "give a source: a git URL, a link to a file or archive, or a path on the hub" }, 400);
    try {
      return c.json(pub(d.tryouts.start(parsed.data)), 202);
    } catch (e) {
      return fail(c, e);
    }
  });
  app.get("/api/tryouts", (c) => (d.tryouts ? c.json(d.tryouts.list(Number(c.req.query("limit") ?? 30)).map(pub)) : off(c)));
  app.get("/api/tryouts/:id", (c) => {
    if (!d.tryouts) return off(c);
    const t = d.tryouts.get(c.req.param("id"));
    return t ? c.json(pub(t)) : c.json({ error: "no such tryout" }, 404);
  });
  app.post("/api/tryouts/:id/cancel", (c) => {
    if (!d.tryouts) return off(c);
    try {
      return c.json(pub(d.tryouts.cancel(c.req.param("id"))));
    } catch (e) {
      return fail(c, e);
    }
  });
}
