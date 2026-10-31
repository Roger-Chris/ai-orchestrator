import type { Hono } from "hono";
import { z } from "zod";
import type { ActionHub, ActRequest } from "../actions/desk.js";

const ActBody = z.object({
  node: z.string().optional(),
  action: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().max(2000).optional(),
  /** Who is asking, for the log ("brain"); the owner's own apps leave it out. */
  who: z.string().max(80).optional(),
});
const NodeActBody = ActBody.omit({ node: true, who: true }).extend({ approval: z.string().optional() });
const ClaimBody = z.object({ action: z.string(), hash: z.string(), node: z.string() });

/**
 * Device actions over HTTP (src/actions).
 * - `/api/act`, `/api/actions`, `/api/approvals*`: the hub's front door, for the brain's thinking
 *   loop, the phone and the web app. Approve and Deny are for the owner's own apps only.
 * - `/node/act`: a peer runs an action on this device (risky ones need an approval id).
 * - `/node/approvals/:id/claim`: a device checks an approval with the hub that holds it.
 */
export function mountActions(app: Hono, d: { actions?: ActionHub }) {
  const off = (c: any) => c.json({ error: "actions are not set up on this device" }, 404);

  app.get("/api/actions", (c) => (d.actions ? c.json(d.actions.runner.list()) : off(c)));
  app.post("/api/act", async (c) => {
    if (!d.actions) return off(c);
    const body = ActBody.parse(await c.req.json());
    try {
      return c.json(await d.actions.act(body.node, body, { who: body.who }));
    } catch (e) {
      return c.json({ status: "refused", node: body.node, action: body.action, error: (e as Error).message }, 502);
    }
  });
  app.get("/api/action-log", (c) => (d.actions?.log ? c.json(d.actions.log.list({ who: c.req.query("who"), limit: Number(c.req.query("limit") ?? 100) })) : off(c)));
  app.get("/api/approvals", (c) => {
    if (!d.actions) return off(c);
    const status = c.req.query("status") as any;
    return c.json(d.actions.desk.list(status || undefined));
  });
  app.get("/api/approvals/:id", (c) => {
    if (!d.actions) return off(c);
    const a = d.actions.desk.get(c.req.param("id"));
    return a ? c.json(a) : c.json({ error: "no such approval" }, 404);
  });
  for (const [verb, yes] of [["approve", true], ["deny", false]] as const) {
    app.post(`/api/approvals/:id/${verb}`, async (c) => {
      if (!d.actions) return off(c);
      try {
        return c.json(await d.actions.decide(c.req.param("id"), yes));
      } catch (e) {
        return c.json({ error: (e as Error).message }, 409);
      }
    });
  }

  app.post("/node/act", async (c) => {
    if (!d.actions) return off(c);
    const body = NodeActBody.parse(await c.req.json());
    return c.json(await d.actions.runner.act(body as ActRequest));
  });
  app.post("/node/approvals/:id/claim", async (c) => {
    if (!d.actions) return off(c);
    const b = ClaimBody.parse(await c.req.json());
    return c.json({ valid: d.actions.desk.claim(c.req.param("id"), b.action, b.hash, b.node) });
  });
}
