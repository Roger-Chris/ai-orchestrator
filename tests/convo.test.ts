import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { convoState, letGo, messageKind, quietChats } from "../src/whatsapp/convo.js";
import { buildGraph, chatStats, type StyleBook } from "../src/whatsapp/learn.js";
import { describeImage, describeImages } from "../src/whatsapp/local.js";
import { buildPool, poolPrompt } from "../src/whatsapp/pool.js";
import { spoken, WaStore, type WaMessage } from "../src/whatsapp/store.js";
import { Store } from "../src/store/db.js";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));

let n = 0;
const A = "111@s.whatsapp.net";
const msg = (fromMe: boolean, text: string, ts: number, extra: Partial<WaMessage> = {}): WaMessage => ({
  id: `c${n++}`,
  chatId: A,
  senderId: fromMe ? "me" : A,
  fromMe,
  isGroup: false,
  text,
  ts,
  ...extra,
});

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "orc-convo-"));
  const store = new Store(dir);
  cleanup.push(() => (store.close(), rmSync(dir, { recursive: true, force: true })));
  return { store, wa: new WaStore(store), dir };
}

describe("where a conversation stands", () => {
  it("tells acknowledgements, sign-offs and real messages apart", () => {
    expect(messageKind(msg(false, "ok da", 1))).toBe("ack");
    expect(messageKind(msg(false, "Seri bro 👍", 1))).toBe("ack");
    expect(messageKind(msg(false, "👍", 1))).toBe("ack");
    expect(messageKind(msg(false, "", 1, { mediaType: "sticker" }))).toBe("ack");
    expect(messageKind(msg(false, "ok da gn", 1))).toBe("sign_off");
    expect(messageKind(msg(false, "ok bye", 1))).toBe("sign_off");
    expect(messageKind(msg(false, "ok?", 1))).toBe("content");
    expect(messageKind(msg(false, "ok but enga irukka", 1))).toBe("content");
    expect(messageKind(msg(false, "", 1, { mediaType: "image" }))).toBe("content");
  });

  it("an acknowledgement of what you said ends it; a sign-off winds it down; your last word waits, then dies out", () => {
    const now = 100_000;
    expect(convoState([msg(true, "naalaiku varen", 10), msg(false, "ok da", 20)], { now }).state).toBe("ended");
    expect(convoState([msg(true, "naalaiku varen", 10), msg(false, "seri da gn", 20)], { now }).state).toBe("winding_down");
    expect(convoState([msg(true, "naalaiku varen", 10), msg(false, "ok", 20), msg(false, "evlo mani ku?", 30)], { now }).state).toBe("open");
    expect(convoState([msg(false, "ok", 20)], { now }).state).toBe("open"); // nothing of yours to acknowledge
    expect(convoState([msg(true, "free ah?", now - 3600)], { now }).state).toBe("waiting");
    expect(convoState([msg(true, "free ah?", now - 13 * 3600)], { now }).state).toBe("died_out");
  });

  it("drafts a clean ending when they sign off, and none when they only said ok", () => {
    const book: StyleBook = { version: 1, builtAt: 0, model: "m", owner: { stats: chatStats([]) }, contacts: [], graph: buildGraph([], new Map()) };
    const winding = buildPool(book, { chatId: A, isGroup: false }, [msg(true, "varen", 10), msg(false, "seri da gn", 20)]);
    expect(winding.state).toBe("winding_down");
    expect(poolPrompt(winding).prompt).toContain('labelled "Close"');
    expect(buildPool(book, { chatId: A, isGroup: false }, [msg(true, "varen", 10), msg(false, "ok", 20)]).state).toBe("ended");
  });

  it("lists direct chats that went quiet after your message, until you let one go", () => {
    const { store, wa } = tempStore();
    const now = Date.now();
    const s = Math.floor(now / 1000);
    wa.save([
      msg(false, "enga?", s - 20 * 3600, { id: "q1" }),
      msg(true, "veetla da, nee?", s - 18 * 3600, { id: "q2", chatName: "Arun" }),
      { ...msg(true, "recent", s - 3600, { id: "q3" }), chatId: "222@s.whatsapp.net" },
      { ...msg(true, "old", s - 9 * 86400, { id: "q4" }), chatId: "333@s.whatsapp.net" },
      { ...msg(true, "group", s - 18 * 3600, { id: "q5" }), chatId: "444@g.us", isGroup: true },
    ]);
    const named = (id: string) => wa.chatName(id) ?? id;
    expect(quietChats(store.db, named, { now })).toEqual([{ chatId: A, name: "Arun", last: "veetla da, nee?", since: (s - 18 * 3600) * 1000 }]);
    letGo(store.db, A);
    expect(quietChats(store.db, named, { now })).toEqual([]);
    wa.save([msg(true, "dei?", s - 13 * 3600 + 1000, { id: "q6" })]); // your later message: quiet again later
    expect(quietChats(store.db, named, { now: now + 2000 * 1000 })).toHaveLength(1);
  });
});

describe("photos", () => {
  it("says what a photo shows, with the local vision model, and the reply sees it", async () => {
    const { wa, dir } = tempStore();
    const path = join(dir, "p.jpg");
    writeFileSync(path, "fake jpeg");
    let sent: any;
    const http = (async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ message: { content: "A laptop on a table,\n price tag ₹45,000." } }));
    }) as unknown as typeof fetch;
    const o = { ollamaUrl: "http://x", visionModel: "gemma3:4b" };
    expect(await describeImage(o, path, http)).toBe("A laptop on a table, price tag ₹45,000.");
    expect(sent.model).toBe("gemma3:4b");
    expect(sent.messages[0].images).toEqual([Buffer.from("fake jpeg").toString("base64")]);

    wa.save([msg(false, "idhu epdi?", 5, { id: "p1", mediaType: "image", mediaPath: path }), msg(false, "", 6, { id: "v1", mediaType: "audio", mediaPath: path })]);
    expect(wa.untranscribed().map((m) => m.id)).toEqual(["v1"]); // Whisper never gets the photo
    expect(await describeImages(wa, o, http)).toBe(1);
    expect(spoken(wa.messages(A).find((m) => m.id === "p1")!)).toBe("[photo: A laptop on a table, price tag ₹45,000.] idhu epdi?");
  });
});
