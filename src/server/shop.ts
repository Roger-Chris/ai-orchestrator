import type { Hono } from "hono";
import type { ShopDesk } from "../shop/desk.js";

/**
 * - `POST /api/shop {store, request, by?}`: the brain's `shop` tool, or the app. Returns at once.
 * - `GET /api/shop`, `GET /api/shop/:id`: the app.
 * - `POST /api/shop/:id/checkout {total}`, `/ordered`, `/dismiss`: the owner's taps. Never give the brain a tool for these.
 */
export function mountShop(app: Hono, d: { shop?: ShopDesk }) {
  const off = (c: any) => c.json({ error: "shopping is not set up on this hub" }, 404);
  app.post("/api/shop", async (c) => {
    if (!d.shop) return off(c);
    const b = (await c.req.json().catch(() => ({}))) as { store?: string; request?: string; by?: string };
    try {
      return c.json(d.shop.start({ store: String(b.store ?? ""), request: String(b.request ?? ""), by: b.by }).run);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });
  app.get("/api/shop", (c) => (d.shop ? c.json(d.shop.list()) : off(c)));
  app.get("/api/shop/:id", (c) => {
    const r = d.shop?.get(c.req.param("id"));
    return r ? c.json(r) : c.json({ error: "no such cart" }, 404);
  });
  app.post("/api/shop/:id/checkout", async (c) => {
    if (!d.shop) return off(c);
    const b = (await c.req.json().catch(() => ({}))) as { total?: string };
    try {
      return c.json(d.shop.checkout(c.req.param("id"), String(b.total ?? "")));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 409);
    }
  });
  for (const [verb, status] of [["ordered", "ordered"], ["dismiss", "dismissed"]] as const) {
    app.post(`/api/shop/:id/${verb}`, (c) => {
      if (!d.shop) return off(c);
      try {
        return c.json(d.shop.close(c.req.param("id"), status));
      } catch (e) {
        return c.json({ error: (e as Error).message }, 404);
      }
    });
  }
}
