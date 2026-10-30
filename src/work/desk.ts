import { randomBytes } from "node:crypto";
import type { Store } from "../store/db.js";
import { WORK_STATUSES, type JobKind, type ProviderRequest, type WorkPerson, type WorkPersonView, type WorkStatus, type WorkTask, type WorkUpdate } from "../types.js";
import type { WaMessage, WaStore } from "../whatsapp/store.js";

/**
 * Work: people you give tasks to, and what happens to each task, followed through your WhatsApp
 * chat with that person. What you send and what they send is the chat itself (wa_messages);
 * a new message there can move a task on (they said it is done, started, stuck), read by a
 * quick model, or by plain rules when none is free. Nothing here sends a WhatsApp message:
 * giving someone a task opens WhatsApp on the phone with the text filled in.
 */

export { WORK_STATUSES };
export type { WorkPerson, WorkPersonView, WorkStatus, WorkTask, WorkUpdate };
const OPEN: WorkStatus[] = ["todo", "sent", "in_progress", "blocked"];

export interface WorkDeskDeps {
  store: Store;
  wa: WaStore;
  /** The model router (`work` job); without one, rules read the messages. */
  think?: (kind: JobKind, req: ProviderRequest) => Promise<{ text: string }>;
  /** A push to the phone when a message moves a task on. */
  notify?: (title: string, body: string) => void;
  now?: () => number;
}

const id = () => randomBytes(6).toString("hex");
const said = (m: WaMessage) => (m.transcript || m.text || "").trim();

/** Plain-words reading of their reply, for when no model is free: only clear phrases count. */
export function statusFromWords(text: string): WorkStatus | undefined {
  const t = ` ${text.toLowerCase()} `;
  if (/\b(done|completed?|finished|submitted|sent it|delivered|mudinjiduchu|mudichiten|aachu)\b/.test(t)) return "done";
  if (/\b(can'?t|cannot|stuck|problem|issue|not possible|delay(ed)?|mudiyadhu|mudiyala)\b/.test(t)) return "blocked";
  if (/\b(started|starting|working on|on it|doing it|will do|pannren|pandren|panren)\b/.test(t)) return "in_progress";
  return undefined;
}

export class WorkDesk {
  private now: () => number;

  constructor(private d: WorkDeskDeps) {
    this.now = d.now ?? Date.now;
    d.store.db.exec(`
      CREATE TABLE IF NOT EXISTS work_people (id TEXT PRIMARY KEY, name TEXT NOT NULL, chat_id TEXT, role TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS work_tasks (
        id TEXT PRIMARY KEY, person_id TEXT NOT NULL, title TEXT NOT NULL, details TEXT, due TEXT,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS work_tasks_person ON work_tasks(person_id, status);
      CREATE TABLE IF NOT EXISTS work_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at INTEGER NOT NULL, status TEXT,
        by TEXT NOT NULL, text TEXT NOT NULL, message_id TEXT
      );
      CREATE INDEX IF NOT EXISTS work_updates_task ON work_updates(task_id, at);
    `);
  }

  // ---------------------------------------------------------------- people

  addPerson(p: { name: string; chatId?: string; role?: string }): WorkPerson {
    const person: WorkPerson = { id: id(), name: p.name.trim(), chatId: p.chatId || undefined, role: p.role?.trim() || undefined, createdAt: this.now() };
    this.d.store.db.prepare("INSERT INTO work_people (id, name, chat_id, role, created_at) VALUES (?, ?, ?, ?, ?)").run(person.id, person.name, person.chatId ?? null, person.role ?? null, person.createdAt);
    return person;
  }

  updatePerson(personId: string, p: { name?: string; chatId?: string | null; role?: string | null }): WorkPerson | undefined {
    const cur = this.person(personId);
    if (!cur) return undefined;
    const next = { ...cur, ...(p.name ? { name: p.name.trim() } : {}), ...(p.chatId !== undefined ? { chatId: p.chatId || undefined } : {}), ...(p.role !== undefined ? { role: p.role || undefined } : {}) };
    this.d.store.db.prepare("UPDATE work_people SET name = ?, chat_id = ?, role = ? WHERE id = ?").run(next.name, next.chatId ?? null, next.role ?? null, personId);
    return next;
  }

  person(personId: string): WorkPerson | undefined {
    const r = this.d.store.db.prepare("SELECT * FROM work_people WHERE id = ?").get(personId) as any;
    return r ? { id: r.id, name: r.name, chatId: r.chat_id ?? undefined, role: r.role ?? undefined, createdAt: r.created_at } : undefined;
  }

  /** Everyone, with their open / overdue / done counts and the newest message with them; busiest first. */
  people(): WorkPersonView[] {
    const rows = this.d.store.db.prepare("SELECT id FROM work_people ORDER BY name COLLATE NOCASE").all() as { id: string }[];
    return rows
      .map(({ id: pid }) => {
        const p = this.person(pid)!;
        const tasks = this.tasks(pid);
        const last = p.chatId ? this.d.wa.messages(p.chatId, 1).at(-1) : undefined;
        return {
          ...p,
          open: tasks.filter((t) => OPEN.includes(t.status)).length,
          overdue: tasks.filter((t) => this.overdue(t)).length,
          done: tasks.filter((t) => t.status === "done").length,
          lastTs: last?.ts,
          last: last ? said(last).slice(0, 120) : undefined,
          lastFromMe: last?.fromMe,
          phone: p.chatId ? this.d.wa.phone(p.chatId) : undefined,
        };
      })
      .sort((a, b) => b.overdue - a.overdue || b.open - a.open || (b.lastTs ?? 0) - (a.lastTs ?? 0));
  }

  /** Your WhatsApp chat with them, oldest first: what you sent and what they sent. */
  timeline(personId: string, limit = 60): { ts: number; fromMe: boolean; text: string; media?: string }[] {
    const p = this.person(personId);
    if (!p?.chatId) return [];
    return this.d.wa.messages(p.chatId, limit).map((m) => ({ ts: m.ts, fromMe: m.fromMe, text: said(m), media: m.mediaType }));
  }

  /** Direct WhatsApp chats to pick a person from, matching a name or number. */
  contacts(q = ""): { chatId: string; name: string; phone?: string }[] {
    const needle = q.trim().toLowerCase();
    return this.d.wa
      .chats()
      .filter((c) => !c.isGroup && (!needle || `${c.name ?? ""} ${c.id}`.toLowerCase().includes(needle)))
      .slice(0, 40)
      .map((c) => ({ chatId: c.id, name: c.name || this.d.wa.phone(c.id) || c.id, phone: this.d.wa.phone(c.id) }));
  }

  // ---------------------------------------------------------------- tasks

  addTask(t: { personId: string; title: string; details?: string; due?: string }): WorkTask | undefined {
    if (!this.person(t.personId)) return undefined;
    const now = this.now();
    const task: WorkTask = { id: id(), personId: t.personId, title: t.title.trim(), details: t.details?.trim() || undefined, due: t.due?.trim() || undefined, status: "todo", createdAt: now, updatedAt: now, updates: [] };
    this.d.store.db
      .prepare("INSERT INTO work_tasks (id, person_id, title, details, due, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(task.id, task.personId, task.title, task.details ?? null, task.due ?? null, task.status, now, now);
    return task;
  }

  task(taskId: string): WorkTask | undefined {
    const r = this.d.store.db.prepare("SELECT * FROM work_tasks WHERE id = ?").get(taskId) as any;
    if (!r) return undefined;
    const updates = (this.d.store.db.prepare("SELECT at, status, by, text FROM work_updates WHERE task_id = ? ORDER BY at").all(taskId) as any[]).map(
      (u) => ({ at: u.at, status: u.status ?? undefined, by: u.by, text: u.text }) as WorkUpdate,
    );
    return { id: r.id, personId: r.person_id, title: r.title, details: r.details ?? undefined, due: r.due ?? undefined, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, updates };
  }

  /** A person's tasks (or everyone's): open ones first, then by due date. */
  tasks(personId?: string): WorkTask[] {
    const rows = (personId
      ? this.d.store.db.prepare("SELECT id FROM work_tasks WHERE person_id = ?").all(personId)
      : this.d.store.db.prepare("SELECT id FROM work_tasks").all()) as { id: string }[];
    return rows
      .map((r) => this.task(r.id)!)
      .sort((a, b) => Number(!OPEN.includes(a.status)) - Number(!OPEN.includes(b.status)) || (a.due ?? "~").localeCompare(b.due ?? "~") || b.createdAt - a.createdAt);
  }

  /** You change a task in the app (or edit its title, details or due date). */
  updateTask(taskId: string, p: { status?: WorkStatus; title?: string; details?: string | null; due?: string | null; note?: string }): WorkTask | undefined {
    const t = this.task(taskId);
    if (!t) return undefined;
    const next = { ...t, ...(p.title ? { title: p.title.trim() } : {}), ...(p.details !== undefined ? { details: p.details || undefined } : {}), ...(p.due !== undefined ? { due: p.due || undefined } : {}) };
    this.d.store.db.prepare("UPDATE work_tasks SET title = ?, details = ?, due = ?, updated_at = ? WHERE id = ?").run(next.title, next.details ?? null, next.due ?? null, this.now(), taskId);
    if (p.status && p.status !== t.status) this.setStatus(taskId, p.status, "you", p.note || "");
    else if (p.note) this.log(taskId, { by: "you", text: p.note });
    return this.task(taskId);
  }

  /** The text that gives this task to them on WhatsApp (you send it from the phone). */
  message(taskId: string): { text: string; phone?: string } | undefined {
    const t = this.task(taskId);
    const p = t && this.person(t.personId);
    if (!t || !p) return undefined;
    const due = t.due ? ` by ${t.due.replace("T", " ")}` : "";
    const first = p.name.split(/\s+/)[0];
    return { text: `Hi ${first}, can you ${t.title.charAt(0).toLowerCase()}${t.title.slice(1)}${due}?${t.details ? `\n${t.details}` : ""}`, phone: p.chatId ? this.d.wa.phone(p.chatId) : undefined };
  }

  overdue(t: WorkTask, now = this.now()): boolean {
    if (!t.due || !OPEN.includes(t.status)) return false;
    // a date alone is due by the end of that day
    const end = /T\d/.test(t.due) ? new Date(t.due).getTime() : new Date(`${t.due}T23:59:59`).getTime();
    return Number.isFinite(end) && end < now;
  }

  private setStatus(taskId: string, status: WorkStatus, by: WorkUpdate["by"], text: string, messageId?: string) {
    this.d.store.db.prepare("UPDATE work_tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, this.now(), taskId);
    this.log(taskId, { by, status, text }, messageId);
  }

  private log(taskId: string, u: Omit<WorkUpdate, "at">, messageId?: string) {
    this.d.store.db.prepare("INSERT INTO work_updates (task_id, at, status, by, text, message_id) VALUES (?, ?, ?, ?, ?, ?)").run(taskId, this.now(), u.status ?? null, u.by, u.text, messageId ?? null);
  }

  // ---------------------------------------------------------------- WhatsApp

  /**
   * New live messages from the WhatsApp link. In a chat with one of your people, a message can move
   * an open task on: yours that gives it to them (todo → sent), theirs that says it is started,
   * stuck or done. Returns the changes made.
   */
  async onMessages(messages: WaMessage[]): Promise<{ taskId: string; status: WorkStatus; by: "me" | "them" }[]> {
    const changes: { taskId: string; status: WorkStatus; by: "me" | "them" }[] = [];
    const byChat = new Map<string, WaMessage[]>();
    for (const m of messages) if (!m.isGroup && said(m)) byChat.set(m.chatId, [...(byChat.get(m.chatId) ?? []), m]);
    for (const [chatId, msgs] of byChat) {
      const person = (this.d.store.db.prepare("SELECT id FROM work_people WHERE chat_id = ?").get(chatId) as { id: string } | undefined)?.id;
      if (!person) continue;
      const open = this.tasks(person).filter((t) => OPEN.includes(t.status));
      if (!open.length) continue;
      const found = (await this.read(this.person(person)!, open, msgs).catch(() => undefined)) ?? this.byRules(open, msgs);
      for (const f of found) {
        const t = open.find((x) => x.id === f.taskId);
        if (!t || t.status === f.status || !WORK_STATUSES.includes(f.status)) continue;
        this.setStatus(t.id, f.status, f.by, f.text, f.messageId);
        changes.push({ taskId: t.id, status: f.status, by: f.by });
        if (f.by === "them") this.d.notify?.(`${this.person(person)!.name}: ${t.title}`, `${label(f.status)}: "${f.text.slice(0, 120)}"`);
      }
    }
    return changes;
  }

  /** Without a model: your message after a task was made gives the newest todo; their clear words move a single open task. */
  private byRules(open: WorkTask[], msgs: WaMessage[]) {
    const out: { taskId: string; status: WorkStatus; by: "me" | "them"; text: string; messageId?: string }[] = [];
    const todo = open.filter((t) => t.status === "todo");
    const mine = msgs.filter((m) => m.fromMe);
    for (const t of todo) {
      const words = t.title.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
      const m = mine.find((x) => words.length && words.filter((w) => said(x).toLowerCase().includes(w)).length >= Math.ceil(words.length / 2));
      if (m) out.push({ taskId: t.id, status: "sent", by: "me", text: said(m), messageId: m.id });
    }
    const active = open.filter((t) => t.status !== "todo");
    if (active.length === 1) {
      for (const m of msgs.filter((x) => !x.fromMe)) {
        const s = statusFromWords(said(m));
        if (s) out.push({ taskId: active[0].id, status: s, by: "them", text: said(m), messageId: m.id });
      }
    }
    return out;
  }

  /** A quick model reads the new messages against the open tasks; only clear changes come back. */
  private async read(person: WorkPerson, open: WorkTask[], msgs: WaMessage[]) {
    if (!this.d.think) return undefined;
    const system =
      `You track tasks the owner gave to ${person.name}, from their WhatsApp chat. Messages may be in English, Tamil or Tanglish. ` +
      `Return JSON only: {"updates":[{"task":"<id>","status":"sent|in_progress|blocked|done","message":"<message id>"}]}. ` +
      `"sent": the OWNER's message gives that task to them. "in_progress": THEY say they started or will do it now. "blocked": THEY say they can't, are stuck or delayed. ` +
      `"done": THEY say it is finished or sent. Only include a task a message is clearly about; greetings, jokes and unrelated chat change nothing. {"updates":[]} when nothing changes.`;
    const prompt =
      `OPEN TASKS:\n${open.map((t) => `${t.id}: ${t.title} (now ${t.status}${t.due ? `, due ${t.due}` : ""})`).join("\n")}\n\n` +
      `NEW MESSAGES:\n${msgs.map((m) => `${m.id} ${m.fromMe ? "OWNER" : person.name.toUpperCase()}: ${said(m).slice(0, 400)}`).join("\n")}`;
    const r = await this.d.think("work", { system, prompt, timeoutMs: 45_000 });
    const json = JSON.parse(r.text.slice(r.text.indexOf("{"), r.text.lastIndexOf("}") + 1)) as { updates?: { task: string; status: WorkStatus; message?: string }[] };
    return (json.updates ?? []).flatMap((u) => {
      const m = msgs.find((x) => x.id === u.message) ?? msgs.at(-1)!;
      const by: "me" | "them" = u.status === "sent" ? "me" : "them";
      // "sent" only from your message, the rest only from theirs
      if (m.fromMe !== (by === "me")) return [];
      return [{ taskId: u.task, status: u.status, by, text: said(m), messageId: m.id }];
    });
  }
}

export const label = (s: WorkStatus) => ({ todo: "To give", sent: "Given", in_progress: "Started", blocked: "Stuck", done: "Done", cancelled: "Cancelled" })[s];
