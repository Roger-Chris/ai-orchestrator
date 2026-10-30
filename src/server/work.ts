import type { Hono } from "hono";
import { z } from "zod";
import { WORK_STATUSES, type WorkDesk } from "../work/desk.js";

/**
 * Work (the app's Work tab): people you give tasks to, followed through your WhatsApp chats.
 * - `GET /api/work` everyone with counts; `POST /api/work/people {name, chatId?, role?}`; `PATCH /api/work/people/:id`
 * - `GET /api/work/people/:id` the person, their tasks and the WhatsApp chat (sent and received)
 * - `GET /api/work/contacts?q=` direct WhatsApp chats to pick someone from
 * - `POST /api/work/tasks {personId, title, details?, due?}`; `PATCH /api/work/tasks/:id {status?, title?, details?, due?, note?}`
 * - `GET /api/work/tasks/:id/message` the WhatsApp text that gives it to them (the phone sends it, never the hub)
 */
export function mountWork(app: Hono, d: { work?: WorkDesk }) {
  const off = (c: any) => c.json({ error: "Work is not set up on this hub" }, 404);
  const bad = (c: any, e: z.ZodError) => c.json({ error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
  const Person = z.object({ name: z.string().trim().min(1).max(100), chatId: z.string().max(200).optional(), role: z.string().max(100).optional() });
  const Due = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/, "use YYYY-MM-DD or YYYY-MM-DDTHH:MM");

  app.get("/api/work", (c) => (d.work ? c.json({ people: d.work.people() }) : off(c)));
  app.get("/api/work/contacts", (c) => (d.work ? c.json(d.work.contacts(c.req.query("q") ?? "")) : off(c)));
  app.post("/api/work/people", async (c) => {
    if (!d.work) return off(c);
    const p = Person.safeParse(await c.req.json().catch(() => ({})));
    return p.success ? c.json(d.work.addPerson(p.data), 201) : bad(c, p.error);
  });
  app.patch("/api/work/people/:id", async (c) => {
    if (!d.work) return off(c);
    const p = Person.partial().extend({ chatId: z.string().max(200).nullable().optional(), role: z.string().max(100).nullable().optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return bad(c, p.error);
    const out = d.work.updatePerson(c.req.param("id"), p.data);
    return out ? c.json(out) : c.json({ error: "no such person" }, 404);
  });
  app.get("/api/work/people/:id", (c) => {
    if (!d.work) return off(c);
    const person = d.work.person(c.req.param("id"));
    if (!person) return c.json({ error: "no such person" }, 404);
    const tasks = d.work.tasks(person.id).map((t) => ({ ...t, overdue: d.work!.overdue(t) }));
    return c.json({ person, tasks, chat: d.work.timeline(person.id, Number(c.req.query("limit") ?? 60)) });
  });
  app.post("/api/work/tasks", async (c) => {
    if (!d.work) return off(c);
    const p = z.object({ personId: z.string(), title: z.string().trim().min(1).max(300), details: z.string().max(2000).optional(), due: Due.optional() }).safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return bad(c, p.error);
    const t = d.work.addTask(p.data);
    return t ? c.json(t, 201) : c.json({ error: "no such person" }, 404);
  });
  app.patch("/api/work/tasks/:id", async (c) => {
    if (!d.work) return off(c);
    const p = z
      .object({ status: z.enum(WORK_STATUSES).optional(), title: z.string().trim().min(1).max(300).optional(), details: z.string().max(2000).nullable().optional(), due: Due.nullable().optional(), note: z.string().max(1000).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!p.success) return bad(c, p.error);
    const t = d.work.updateTask(c.req.param("id"), p.data);
    return t ? c.json(t) : c.json({ error: "no such task" }, 404);
  });
  app.get("/api/work/tasks/:id/message", (c) => {
    if (!d.work) return off(c);
    const m = d.work.message(c.req.param("id"));
    return m ? c.json(m) : c.json({ error: "no such task" }, 404);
  });
}
