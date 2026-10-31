import type { Hono } from "hono";
import type { GmailStatus } from "../integrations/gmail.js";
import type { MailDesk } from "../mail/desk.js";

/**
 * - `POST /api/mail {to, about, subject?, name?, by?}`: the brain's `mail` tool, or the app. Only writes a draft.
 * - `GET /api/mail`, `GET /api/mail/:id`, `GET /api/mail/sender`: the app.
 * - `POST /api/mail/:id/send {to, subject, body}`, `/discard`: the owner's taps. Never give the brain a tool for these.
 */
export function mountMail(app: Hono, d: { mail?: MailDesk; mailSender?: { status(): GmailStatus } }) {
  const off = (c: any) => c.json({ error: "mail is not set up on this hub" }, 404);
  app.get("/api/mail/sender", (c) => {
    const s = d.mailSender?.status();
    return c.json({ connected: !!s?.connected, email: s?.email });
  });
  app.post("/api/mail", async (c) => {
    if (!d.mail) return off(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const opt = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
    try {
      return c.json(await d.mail.draft({ to: String(b.to ?? ""), about: String(b.about ?? ""), subject: opt(b.subject), name: opt(b.name), by: opt(b.by) }));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });
  app.get("/api/mail", (c) => (d.mail ? c.json(d.mail.list()) : off(c)));
  app.get("/api/mail/:id", (c) => {
    const m = d.mail?.get(c.req.param("id"));
    return m ? c.json(m) : c.json({ error: "no such draft" }, 404);
  });
  app.post("/api/mail/:id/send", async (c) => {
    if (!d.mail) return off(c);
    const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      return c.json(await d.mail.send(c.req.param("id"), { to: String(b.to ?? ""), subject: String(b.subject ?? ""), body: String(b.body ?? "") }));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });
  app.post("/api/mail/:id/discard", (c) => {
    if (!d.mail) return off(c);
    try {
      return c.json(d.mail.discard(c.req.param("id")));
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });
}
