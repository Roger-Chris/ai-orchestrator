import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { mountSharedMemory } from "../src/server/shared-memory.js";
import { mountBrain } from "../src/server/brain.js";
import { MemoryReplica, namedUid } from "../src/shared/replica.js";
import { memoryUpstream } from "../src/shared/setup.js";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));

function tmp() {
  const d = mkdtempSync(join(tmpdir(), "orc-mem-"));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** The brain's /memory API, in memory: change log with seq, newer updated_at wins. */
class FakeBrain {
  records = new Map<string, any>();
  seq = 0;
  down = false;
  pushes = 0;

  fetch: typeof fetch = async (input, init) => {
    if (this.down) throw new TypeError("fetch failed");
    const url = new URL(String(input));
    const path = url.pathname.replace(/^.*\/memory/, "");
    if (path === "/changes") {
      const since = Number(url.searchParams.get("since") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 500);
      const all = [...this.records.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq);
      const page = all.slice(0, limit);
      return Response.json({ records: page, last_seq: page.at(-1)?.seq ?? since, more: all.length > limit });
    }
    if (path === "/batch") {
      this.pushes++;
      const body = JSON.parse(String(init?.body));
      const results = body.records.map((r: any) => {
        const prev = this.records.get(r.uid);
        if (prev && Date.parse(prev.updated_at) >= Date.parse(r.updated_at)) return { uid: r.uid, accepted: false, seq: prev.seq, record: prev };
        const rec = { ...r, device: r.device ?? body.device, seq: ++this.seq, created_at: prev?.created_at ?? r.updated_at };
        this.records.set(r.uid, rec);
        return { uid: r.uid, accepted: true, seq: rec.seq };
      });
      return Response.json({ results });
    }
    return new Response("not found", { status: 404 });
  };

  /** A record the brain itself wrote (e.g. mirrored from its graph). */
  write(r: any) {
    const rec = { tags: "", aliases: "", body: "", data: {}, source: "graph", device: "brain", deleted: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...r, seq: ++this.seq };
    this.records.set(r.uid, rec);
  }
}

function device(name: string, brain: FakeBrain) {
  return new MemoryReplica(join(tmp(), "shared.db"), name, { base: "http://hub:4317/node/memory", token: "t" }, brain.fetch);
}

describe("shared memory replica", () => {
  it("a fact saved on the laptop reaches the Mac through the brain", async () => {
    const brain = new FakeBrain();
    const laptop = device("omen", brain);
    const mac = device("mac-mini", brain);
    laptop.put({ kind: "fact", title: "Jayesh prefers calls after 6 pm", body: "said on WhatsApp" });
    await laptop.sync();
    expect(laptop.syncStatus().pending).toBe(0);
    await mac.sync();
    const hits = mac.search("when does jayesh want calls");
    expect(hits).toHaveLength(1);
    expect(hits[0].device).toBe("omen");
  });

  it("works offline and catches up when the hub is back", async () => {
    const brain = new FakeBrain();
    const laptop = device("omen", brain);
    brain.down = true;
    laptop.put({ kind: "note", title: "eVTOL ESC thermal fix idea", body: "add copper heat spreader" });
    expect(laptop.search("heat spreader")).toHaveLength(1); // usable at once, offline
    await expect(laptop.sync()).rejects.toThrow();
    expect(laptop.syncStatus()).toMatchObject({ ok: false, pending: 1 });
    brain.down = false;
    await laptop.sync();
    expect(laptop.syncStatus()).toMatchObject({ ok: true, pending: 0 });
    expect([...brain.records.values()][0].title).toBe("eVTOL ESC thermal fix idea");
  });

  it("pulls what the brain knows, in pages, and remembers where it stopped", async () => {
    const brain = new FakeBrain();
    for (let i = 0; i < 1203; i++) brain.write({ uid: `person:p${i}`, kind: "person", title: `Person ${i}` });
    const mac = device("mac-mini", brain);
    expect(await mac.sync()).toBe(1203);
    expect(mac.syncStatus()).toMatchObject({ lastSeq: 1203, records: 1203 });
    brain.write({ uid: "person:p5", kind: "person", title: "Person five, renamed" });
    expect(await mac.sync()).toBe(1);
    expect(mac.get("person:p5")!.title).toBe("Person five, renamed");
  });

  it("the newer edit wins on every device", async () => {
    const brain = new FakeBrain();
    const laptop = device("omen", brain);
    const mac = device("mac-mini", brain);
    const uid = namedUid("project", "Smart Aquaponics");
    mac.put({ uid, kind: "project", title: "Smart Aquaponics", body: "old status" }, new Date(Date.now() - 60_000));
    laptop.put({ uid, kind: "project", title: "Smart Aquaponics", body: "dashboard live" }, new Date());
    await laptop.sync();
    await mac.sync(); // mac's older edit is refused, then the newer one comes back down
    await laptop.sync();
    expect(mac.get(uid)!.body).toBe("dashboard live");
    expect(laptop.get(uid)!.body).toBe("dashboard live");
    expect(mac.syncStatus().pending).toBe(0);
  });

  it("a refused older edit is replaced by the brain's copy, even one pulled long ago", async () => {
    const brain = new FakeBrain();
    brain.write({ uid: "project:aq", kind: "project", title: "Aquaponics", body: "dashboard live" });
    const mac = device("mac-mini", brain);
    await mac.sync(); // mac has seq 1 already; a pull will never send it again
    mac.put({ uid: "project:aq", kind: "project", title: "Aquaponics", body: "STALE" }, new Date(Date.now() - 3_600_000));
    await mac.sync();
    expect(mac.get("project:aq")!.body).toBe("dashboard live");
    expect(mac.syncStatus().pending).toBe(0);
  });

  it("an unpushed local edit newer than the pulled copy is kept and pushed", async () => {
    const brain = new FakeBrain();
    brain.write({ uid: "fact:x", kind: "fact", title: "from brain", updated_at: new Date(Date.now() - 60_000).toISOString() });
    const laptop = device("omen", brain);
    laptop.put({ uid: "fact:x", kind: "fact", title: "edited offline" });
    brain.down = false;
    await laptop.sync();
    expect(laptop.get("fact:x")!.title).toBe("edited offline");
    expect(brain.records.get("fact:x").title).toBe("edited offline");
  });

  it("forgetting on one device removes it everywhere", async () => {
    const brain = new FakeBrain();
    const laptop = device("omen", brain);
    const mac = device("mac-mini", brain);
    const rec = laptop.put({ kind: "note", title: "temporary wifi password hint" });
    await laptop.sync();
    await mac.sync();
    expect(mac.search("wifi")).toHaveLength(1);
    expect(laptop.forget(rec.uid)).toBe(true);
    await laptop.sync();
    await mac.sync();
    expect(mac.search("wifi")).toHaveLength(0);
    expect(mac.get(rec.uid)!.deleted).toBe(true);
  });

  it("about() gathers relations and records about a thing; names resolve by alias", async () => {
    const brain = new FakeBrain();
    brain.write({ uid: "person:jayesh-daga", kind: "person", title: "Jayesh Daga", aliases: "jd" });
    brain.write({ uid: "project:water-patent", kind: "project", title: "Water and energy patent" });
    brain.write({ uid: "relation:jayesh-daga~co_inventor_of~water-patent", kind: "relation", title: "Jayesh Daga co inventor of Water and energy patent", data: { src: "person:jayesh-daga", rel: "co_inventor_of", dst: "project:water-patent" } });
    const mac = device("mac-mini", brain);
    await mac.sync();
    mac.put({ kind: "fact", title: "Jayesh is moving to Bangalore", subject: "person:jayesh-daga" });
    const a = mac.about("JD")!;
    expect(a.record.uid).toBe("person:jayesh-daga");
    expect(a.relations[0].dst).toBe("project:water-patent");
    expect(a.linked[0].title).toBe("Jayesh is moving to Bangalore");
    expect(mac.about("nobody at all")).toBeUndefined();
  });

  it("rejects unknown kinds", () => {
    const r = device("omen", new FakeBrain());
    expect(() => r.put({ kind: "spaceship" })).toThrow(/unknown kind/);
  });
});

describe("shared memory over HTTP", () => {
  it("the brain's machine syncs with the brain directly; other devices through the Linux hub", () => {
    expect(memoryUpstream(parseConfig({ assistant: { token: "b" } }))).toEqual({ base: "http://127.0.0.1:8000/memory", token: "b" });
    expect(memoryUpstream(parseConfig({ server: { token: "orc" }, sharedMemory: { hub: "http://100.104.185.17:4317/" } }))).toEqual({
      base: "http://100.104.185.17:4317/node/memory",
      token: "orc",
    });
    expect(memoryUpstream(parseConfig({}))).toBeUndefined();
  });

  it("remember, search and about on this device's replica", async () => {
    const replica = new MemoryReplica(join(tmp(), "m.db"), "omen");
    const app = new Hono();
    mountSharedMemory(app, { config: parseConfig({}), replica });
    replica.put({ uid: "project:evtol", kind: "project", title: "Heavy-lift X8 coaxial eVTOL" });
    const saved = await app.request("/api/shared-memory/remember", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Use 12S batteries for the next tether test", kind: "decision", subject: "Heavy-lift X8 coaxial eVTOL" }),
    });
    expect((await saved.json()).subject).toBe("project:evtol");
    const hits = await (await app.request("/api/shared-memory/search?q=tether%20batteries")).json();
    expect(hits[0].kind).toBe("decision");
    const about = await (await app.request("/api/shared-memory/about?name=evtol")).json();
    expect(about.linked).toHaveLength(1);
    const rec = await app.request(`/api/shared-memory/record/${encodeURIComponent("project:evtol")}`);
    expect((await rec.json()).title).toContain("eVTOL");
  });

  it("/node/memory/* passes through to the brain only on the brain's machine", async () => {
    const seen: string[] = [];
    const brainFetch: typeof fetch = async (input, init) => {
      seen.push(`${init?.method} ${String(input)} ${(init?.headers as any).Authorization}`);
      return Response.json({ records: [], last_seq: 7, more: false });
    };
    const hub = new Hono();
    mountSharedMemory(hub, { config: parseConfig({ assistant: { token: "brain-secret" } }), brainFetch });
    const res = await hub.request("/node/memory/changes?since=3&limit=10");
    expect(await res.json()).toMatchObject({ last_seq: 7 });
    expect(seen).toEqual(["GET http://127.0.0.1:8000/memory/changes?since=3&limit=10 Bearer brain-secret"]);

    const laptop = new Hono();
    mountSharedMemory(laptop, { config: parseConfig({}) });
    expect((await laptop.request("/node/memory/changes")).status).toBe(404);
    expect((await laptop.request("/api/assistant/ask", { method: "POST", body: JSON.stringify({ text: "hi" }) })).status).toBe(404);
  });

  it("/api/assistant/ask reaches the brain's thinking loop", async () => {
    let sent: any;
    const brainFetch: typeof fetch = async (input, init) => {
      sent = { url: String(input), body: JSON.parse(String(init?.body)) };
      return Response.json({ answer: "Your thrust sheet is on the laptop.", steps: [], pending: [] });
    };
    const hub = new Hono();
    mountSharedMemory(hub, { config: parseConfig({ assistant: { token: "b" } }), brainFetch });
    const res = await hub.request("/api/assistant/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "where is my thrust sheet" }) });
    expect((await res.json()).answer).toContain("thrust sheet");
    expect(sent).toEqual({ url: "http://127.0.0.1:8000/agent/ask", body: { text: "where is my thrust sheet", source: "app", history: [] } });
    const history = [{ role: "user", content: "where is my thrust sheet" }, { role: "assistant", content: "D:/evtol/thrust.xlsx on omen" }];
    await hub.request("/api/assistant/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "open it", history }) });
    expect(sent.body).toEqual({ text: "open it", source: "app", history });
  });
});

describe("the app's way to the brain", () => {
  it("passes the listed paths with BRAIN_TOKEN and refuses the rest", async () => {
    const seen: string[] = [];
    const brainFetch: typeof fetch = async (input, init) => {
      seen.push(`${init?.method} ${String(input)} ${(init?.headers as any).Authorization} ${init?.body ?? ""}`);
      return Response.json({ ok: true });
    };
    const hub = new Hono();
    mountBrain(hub, { config: parseConfig({ assistant: { token: "b" } }), brainFetch });
    expect((await hub.request("/api/brain/tasks?status=pending_confirmation")).status).toBe(200);
    expect((await hub.request("/api/brain/tasks/12/confirm", { method: "POST" })).status).toBe(200);
    expect((await hub.request("/api/brain/chats/3/mute", { method: "POST", body: JSON.stringify({ muted: true }) })).status).toBe(200);
    expect(seen).toEqual([
      "GET http://127.0.0.1:8000/tasks?status=pending_confirmation Bearer b ",
      "POST http://127.0.0.1:8000/tasks/12/confirm Bearer b {}",
      'POST http://127.0.0.1:8000/chats/3/mute Bearer b {"muted":true}',
    ]);
    // not on the list: the brain's memory sync, ingest, workers, deleting
    for (const [m, p] of [["POST", "/api/brain/ingest/whatsapp"], ["POST", "/api/brain/memory/batch"], ["GET", "/api/brain/workers"], ["DELETE", "/api/brain/tasks/1"]]) {
      expect((await hub.request(p, { method: m })).status).toBe(403);
    }
    expect(seen).toHaveLength(3);
    // the learning harness: feedback and lessons pass; its export (for the evaluation) does not
    expect((await hub.request("/api/brain/learn/episodes/7/feedback", { method: "POST", body: JSON.stringify({ good: false }) })).status).toBe(200);
    expect((await hub.request("/api/brain/learn/lessons/2", { method: "PATCH", body: JSON.stringify({ status: "off" }) })).status).toBe(200);
    expect((await hub.request("/api/brain/learn/run", { method: "POST" })).status).toBe(200);
    expect((await hub.request("/api/brain/learn/export")).status).toBe(403);
    expect(seen).toHaveLength(6);
    const off = new Hono();
    mountBrain(off, { config: parseConfig({}) });
    expect((await off.request("/api/brain/tasks")).status).toBe(404);
  });
});
