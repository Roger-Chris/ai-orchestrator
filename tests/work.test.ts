import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import { mountWork } from "../src/server/work.js";
import { Store } from "../src/store/db.js";
import { WaStore, type WaMessage } from "../src/whatsapp/store.js";
import { statusFromWords, WorkDesk } from "../src/work/desk.js";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));

const ARUN = "919876543210@s.whatsapp.net";
let n = 0;
const msg = (fromMe: boolean, text: string, ts = 1_800_000_000 + n): WaMessage => ({ id: `m${++n}`, chatId: ARUN, senderId: fromMe ? "me" : ARUN, fromMe, isGroup: false, text, ts });

function setup(think?: ConstructorParameters<typeof WorkDesk>[0]["think"]) {
  const dir = mkdtempSync(join(tmpdir(), "orc-work-"));
  const store = new Store(dir);
  cleanup.push(() => (store.close(), rmSync(dir, { recursive: true, force: true })));
  const wa = new WaStore(store);
  const notes: string[] = [];
  let now = new Date("2026-10-30T10:00:00").getTime();
  const work = new WorkDesk({ store, wa, think, notify: (t, b) => void notes.push(`${t} | ${b}`), now: () => now });
  return { store, wa, work, notes, advance: (ms: number) => (now += ms) };
}

describe("Work: people, tasks and WhatsApp", () => {
  it("keeps people and their tasks, and writes the WhatsApp text that gives a task", () => {
    const { work, wa } = setup();
    wa.save([msg(false, "hi anna"), msg(true, "hi da")]);
    const arun = work.addPerson({ name: "Arun Kumar", chatId: ARUN, role: "intern" });
    const t = work.addTask({ personId: arun.id, title: "Send the SIH report", due: "2026-10-31T17:00" })!;
    expect(work.message(t.id)).toEqual({ text: "Hi Arun, can you send the SIH report by 2026-10-31 17:00?", phone: "919876543210" });
    expect(work.people()[0]).toMatchObject({ name: "Arun Kumar", open: 1, overdue: 0, done: 0, last: "hi da", lastFromMe: true, phone: "919876543210" });
    expect(work.timeline(arun.id).map((m) => [m.fromMe, m.text])).toEqual([[false, "hi anna"], [true, "hi da"]]);
    expect(work.addTask({ personId: "nobody", title: "x" })).toBeUndefined();
  });

  it("marks a task overdue after its date, and done tasks never", () => {
    const { work, advance } = setup();
    const p = work.addPerson({ name: "Bala" });
    const t = work.addTask({ personId: p.id, title: "Book the hall", due: "2026-10-30" })!;
    expect(work.overdue(work.task(t.id)!)).toBe(false); // due by the end of the day
    advance(24 * 3600_000);
    expect(work.overdue(work.task(t.id)!)).toBe(true);
    expect(work.people()[0].overdue).toBe(1);
    work.updateTask(t.id, { status: "done", note: "he called" });
    expect(work.overdue(work.task(t.id)!)).toBe(false);
    expect(work.task(t.id)!.updates).toMatchObject([{ by: "you", status: "done", text: "he called" }]);
  });

  it("without a model: your message gives the task, their clear words move it on, and you are told", async () => {
    const { work, notes } = setup();
    const p = work.addPerson({ name: "Arun", chatId: ARUN });
    const t = work.addTask({ personId: p.id, title: "Send the SIH report" })!;
    await work.onMessages([msg(true, "da send the SIH report today")]);
    expect(work.task(t.id)!.status).toBe("sent");
    await work.onMessages([msg(false, "ok anna")]); // nothing clear: no change
    expect(work.task(t.id)!.status).toBe("sent");
    await work.onMessages([msg(false, "started anna, will send by 5")]);
    expect(work.task(t.id)!.status).toBe("in_progress");
    await work.onMessages([msg(false, "done anna, sent it")]);
    expect(work.task(t.id)!).toMatchObject({ status: "done" });
    expect(work.task(t.id)!.updates.map((u) => [u.by, u.status])).toEqual([["me", "sent"], ["them", "in_progress"], ["them", "done"]]);
    expect(notes.at(-1)).toBe('Arun: Send the SIH report | Done: "done anna, sent it"');
  });

  it("with a model: it says which task a message is about; a status from the wrong side is ignored", async () => {
    const seen: string[] = [];
    const { work } = setup(async (kind, req) => {
      seen.push(`${kind} ${req.prompt}`);
      const id = req.prompt.match(/^(\w+): Print the posters/m)![1];
      const mid = req.prompt.match(/^(m\d+) ARUN: posters mudinjiduchu/m)?.[1];
      // also claims a "done" from the owner's own message, which must not count
      const mine = req.prompt.match(/^(m\d+) OWNER:/m)?.[1];
      return { text: JSON.stringify({ updates: [...(mid ? [{ task: id, status: "done", message: mid }] : []), ...(mine ? [{ task: id, status: "done", message: mine }] : [])] }) };
    });
    const p = work.addPerson({ name: "Arun", chatId: ARUN });
    const a = work.addTask({ personId: p.id, title: "Print the posters" })!;
    const b = work.addTask({ personId: p.id, title: "Book the hall" })!;
    work.updateTask(a.id, { status: "sent" });
    work.updateTask(b.id, { status: "sent" });
    await work.onMessages([msg(true, "posters epdi?")]);
    expect(work.task(a.id)!.status).toBe("sent");
    await work.onMessages([msg(false, "posters mudinjiduchu anna")]);
    expect(work.task(a.id)!.status).toBe("done");
    expect(work.task(b.id)!.status).toBe("sent");
    expect(seen[0]).toMatch(/^work OPEN TASKS:/);
  });

  it("ignores groups and people who are not in Work", async () => {
    const { work } = setup();
    const p = work.addPerson({ name: "Arun", chatId: ARUN });
    const t = work.addTask({ personId: p.id, title: "x" })!;
    work.updateTask(t.id, { status: "sent" });
    expect(await work.onMessages([{ ...msg(false, "done"), isGroup: true, chatId: "g@g.us" }, { ...msg(false, "done"), chatId: "other@s.whatsapp.net" }])).toEqual([]);
  });

  it("a hidden-id chat gets its phone number from the link, so WhatsApp opens that chat", () => {
    const { work, wa } = setup();
    const LID = "123456789012345@lid";
    wa.save([{ ...msg(false, "hi"), chatId: LID }]);
    const p = work.addPerson({ name: "Varun", chatId: LID });
    const t = work.addTask({ personId: p.id, title: "Send the deck" })!;
    expect(work.message(t.id)!.phone).toBeUndefined(); // before: only the share menu
    expect(wa.setPhones({ [LID]: "919812345678", "999@lid": "919800000000", [`${LID}x`]: "not-a-number" })).toBe(1); // unknown chats and bad numbers skipped
    expect(work.message(t.id)!.phone).toBe("919812345678");
    wa.save([{ ...msg(false, "again"), chatId: "555@lid", chatPhone: "919811111111" }]); // a live message carries it too
    expect(wa.phone("555@lid")).toBe("919811111111");
    expect(wa.phone(ARUN)).toBe("919876543210");
  });

  it("reads plain replies in English and Tanglish", () => {
    expect(statusFromWords("Done da")).toBe("done");
    expect(statusFromWords("can't come today, stuck at college")).toBe("blocked");
    expect(statusFromWords("on it anna")).toBe("in_progress");
    expect(statusFromWords("seri")).toBeUndefined();
  });

  it("serves the app over /api/work", async () => {
    const { work, wa } = setup();
    wa.save([msg(false, "hello"), { ...msg(false, "group"), chatId: "g@g.us", isGroup: true }]);
    wa.nameChat(ARUN, "Arun");
    const app = new Hono();
    mountWork(app, { work });
    const json = { "Content-Type": "application/json" };
    expect(await (await app.request("/api/work/contacts?q=aru")).json()).toEqual([{ chatId: ARUN, name: "Arun", phone: "919876543210" }]);
    const p = await (await app.request("/api/work/people", { method: "POST", headers: json, body: JSON.stringify({ name: "Arun", chatId: ARUN }) })).json();
    expect((await app.request("/api/work/tasks", { method: "POST", headers: json, body: JSON.stringify({ personId: p.id, title: "x", due: "tomorrow" }) })).status).toBe(400);
    const t = await (await app.request("/api/work/tasks", { method: "POST", headers: json, body: JSON.stringify({ personId: p.id, title: "Print posters", due: "2026-11-01" }) })).json();
    expect((await (await app.request(`/api/work/tasks/${t.id}`, { method: "PATCH", headers: json, body: JSON.stringify({ status: "blocked", note: "no paper" }) })).json()).status).toBe("blocked");
    const page = await (await app.request(`/api/work/people/${p.id}`)).json();
    expect(page.tasks[0]).toMatchObject({ title: "Print posters", status: "blocked", overdue: false });
    expect(page.chat.map((m: any) => m.text)).toEqual(["hello"]);
    expect((await (await app.request(`/api/work/tasks/${t.id}/message`)).json()).text).toBe("Hi Arun, can you print posters by 2026-11-01?");
  });
});
