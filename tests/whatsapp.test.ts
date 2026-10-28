import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph, chatStats, learnStyle, normalizeCard, replyPairs, type StyleBook, type StyleCard } from "../src/whatsapp/learn.js";
import { content } from "../src/whatsapp/link.js";
import { buildPool, groundCard, poolPrompt } from "../src/whatsapp/pool.js";
import { cleanDraft, ReplyDrafter } from "../src/whatsapp/drafter.js";
import { addressTerms, addTerms, fixAddress } from "../src/whatsapp/address.js";
import type { ProviderId, ProviderRequest } from "../src/types.js";
import { WaStore, type WaMessage } from "../src/whatsapp/store.js";
import { Store } from "../src/store/db.js";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));

let n = 0;
const msg = (chatId: string, fromMe: boolean, text: string, ts: number, extra: Partial<WaMessage> = {}): WaMessage => ({
  id: `m${n++}`,
  chatId,
  senderId: fromMe ? "me" : chatId,
  fromMe,
  isGroup: chatId.endsWith("@g.us"),
  text,
  ts,
  ...extra,
});

const card = (over: Partial<StyleCard> = {}): StyleCard => ({
  relationship: "close friend",
  addressAs: ["da", "okk", "machi"],
  theyCallMe: ["bro"],
  language: "Tanglish",
  tone: "casual",
  formality: 1,
  length: "one-liners",
  emoji: "rarely",
  phrases: ["seri da", "never said this"],
  topics: ["cricket"],
  avoid: ["full stops"],
  notes: "",
  ...over,
});

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), "orc-wa-"));
  const store = new Store(dir);
  cleanup.push(() => (store.close(), rmSync(dir, { recursive: true, force: true })));
  return new WaStore(store);
}

const A = "111@s.whatsapp.net";
const chatA = [
  msg(A, false, "enga irukka", 1000),
  msg(A, true, "veetla dhan da", 1060),
  msg(A, true, "seri da", 1070),
  msg(A, false, "match pakalama", 5000),
  msg(A, true, "okk da seri da 😂", 5100),
  msg(A, false, "nalaiku varuviya", 9000),
  msg(A, true, ".", 9050),
];

describe("whatsapp messages", () => {
  it("reads text, voice notes and quoted replies, and skips reactions", () => {
    expect(content({ conversation: "hi da" })).toEqual({ text: "hi da", quoted: undefined });
    expect(content({ ephemeralMessage: { message: { audioMessage: { ptt: true } } } })).toMatchObject({ text: "", mediaType: "audio" });
    expect(content({ extendedTextMessage: { text: "yes", contextInfo: { quotedMessage: { conversation: "coming?" } } } })).toMatchObject({ text: "yes", quoted: "coming?" });
    expect(content({ reactionMessage: { text: "👍" } })).toBeUndefined();
  });

  it("stores messages once and keeps a transcript when the same message comes again", () => {
    const wa = tempStore();
    const voice = msg(A, true, "", 10, { mediaType: "audio", mediaPath: "/v.ogg" });
    expect(wa.save([voice, msg(A, false, "hi", 5, { chatName: "Arun" })])).toBe(2);
    wa.setTranscript(voice.id, "naan varen da");
    expect(wa.save([{ ...voice, mediaPath: undefined }])).toBe(0);
    expect(wa.messages(A).map((m) => m.transcript ?? m.text)).toEqual(["hi", "naan varen da"]);
    expect(wa.chats()).toMatchObject([{ id: A, name: "Arun", mine: 1 }]);
    expect(wa.untranscribed()).toEqual([]);
  });
});

describe("style learning", () => {
  it("measures how you write from your own messages only", () => {
    const s = chatStats(chatA);
    expect(s.mine).toBe(4);
    expect(s.theirs).toBe(3);
    expect(s.lowercaseStart).toBe(0.75); // "." starts with no letter
    expect(s.topEmoji).toEqual([]); // one 😂 is not a habit
    expect(s.burst).toBe(1.3);
    expect(s.replyMinutes).toBe(1);
  });

  it("pairs their messages with your reply, skipping replies with no words", () => {
    expect(replyPairs(chatA).map((p) => [p.them, p.me])).toEqual([
      ["enga irukka", "veetla dhan da\nseri da"],
      ["match pakalama", "okk da seri da 😂"],
    ]);
  });

  it("keeps a model's card to the expected shape", () => {
    expect(normalizeCard({ relationship: "friend", formality: "9", addressAs: "da", phrases: [1, "seri"] })).toMatchObject({ formality: 5, addressAs: ["da"], phrases: ["seri"] });
    expect(normalizeCard("not json")).toBeUndefined();
  });

  it("builds the book with the local model and reuses cards for chats with nothing new", async () => {
    const wa = tempStore();
    wa.save(chatA);
    let calls = 0;
    const http = (async () => {
      calls++;
      return new Response(JSON.stringify({ message: { content: JSON.stringify({ ...card(), summary: "short Tanglish" }) } }));
    }) as unknown as typeof fetch;
    const o = { ollamaUrl: "http://x", model: "m", minMine: 2, maxContacts: 10, log: () => {}, http };
    const book = await learnStyle(wa, o);
    expect(calls).toBe(2); // one card, one overall voice
    expect(book.contacts[0].card?.addressAs).toEqual(["da"]); // "okk" is not a term of address; "machi" was never used
    expect(book.owner.voice?.summary).toBe("short Tanglish");
    calls = 0;
    await learnStyle(wa, o, book);
    expect(calls).toBe(1); // only the voice again
  });
});

describe("context pool", () => {
  const B = "222@s.whatsapp.net";
  const G = "333@g.us";
  const book: StyleBook = {
    version: 1,
    builtAt: 0,
    model: "m",
    owner: { stats: chatStats(chatA), voice: { summary: "Short Tanglish.", languages: "Tanglish", habits: ["lowercase"], phrases: ["seri"], avoid: ["full stops"] } },
    contacts: [
      { chatId: A, name: "Arun", isGroup: false, stats: chatStats(chatA), card: card(), examples: replyPairs(chatA), lastTs: 9050 },
      { chatId: G, name: "College gang", isGroup: true, stats: chatStats([]), card: card({ relationship: "friends group" }), examples: [], lastTs: 0 },
    ],
    graph: buildGraph([], new Map()),
  };
  book.graph.nodes.push({ id: G, label: "College gang", kind: "group", weight: 1 });
  book.graph.edges.push({ from: A, to: G, kind: "member", weight: 1 });

  it("grounds terms of address and phrases in what you actually wrote", () => {
    expect(groundCard(card(), ["seri da", "okk da", "seri da poitu varen"], "Arun")).toMatchObject({ addressAs: ["da"], phrases: ["seri da"] });
    expect(groundCard(card({ addressAs: ["arun"] }), ["arun vaa", "sollu arun"], "Arun Kumar").addressAs).toEqual(["arun"]);
  });

  it("builds from the chat's own character, with shared groups and what to answer", () => {
    const p = buildPool(book, { chatId: A, isGroup: false }, [...chatA, msg(A, false, "match ku varuviya da", 9100)], { minOwn: 1 });
    expect(p).toMatchObject({ name: "Arun", basis: "own", similar: [], sharedGroups: ["College gang"] });
    expect(p.incoming.map((m) => m.text)).toEqual(["match ku varuviya da"]);
    expect(p.examples.at(-1)?.them).toBe("match pakalama"); // closest to "match ku varuviya"
    const { system, prompt } = poolPrompt(p);
    expect(system).toContain("Short Tanglish.");
    expect(prompt).toContain('What I call them: "da" (in 3 of my messages)');
    expect(prompt).toContain("0.25 emoji per message");
    expect(prompt).toContain("I never write Tamil script here");
    expect(prompt).toContain("Write my reply to their last message(s)");
  });

  it("borrows from the most similar character for a chat never studied", () => {
    const p = buildPool(book, { chatId: B, name: "Karthik", isGroup: false }, [msg(B, false, "hi da free ah", 50)]);
    expect(p).toMatchObject({ basis: "similar", similar: ["Arun"], name: "Karthik" });
    expect(p.card?.addressAs).toEqual([]); // never borrow what you call someone else
    expect(p.address).toEqual([]);
    expect(poolPrompt(p).prompt).toContain("use no term of address");
    expect(p.examples.every((e) => e.from === "Arun")).toBe(true);
    expect(poolPrompt(p, "say I'll call at 6").prompt).toContain("What I want to say: say I'll call at 6");
  });
});

describe("reply drafter", () => {
  function setup(answers: Partial<Record<ProviderId, string | null>>) {
    const dir = mkdtempSync(join(tmpdir(), "orc-wa-"));
    const store = new Store(dir);
    cleanup.push(() => (store.close(), rmSync(dir, { recursive: true, force: true })));
    const wa = new WaStore(store);
    const asked: { id: ProviderId; req: ProviderRequest }[] = [];
    const pool = {
      available: async () => Object.keys(answers) as ProviderId[],
      run: async (id: ProviderId, req: ProviderRequest) => {
        asked.push({ id, req });
        const text = answers[id];
        return text === null ? { ok: false, text: "", provider: id, durationMs: 1, error: "limit" } : { ok: true, text: text ?? "", provider: id, durationMs: 1 };
      },
    };
    const notes: string[] = [];
    const drafter = new ReplyDrafter(store, wa, pool, { dataDir: dir, delaySeconds: 0, auto: true, groups: false, provider: "auto", node: "hub" }, (p) => notes.push(p.title));
    const book: StyleBook = {
      version: 1,
      builtAt: 1,
      model: "m",
      owner: { id: "999@s.whatsapp.net", stats: chatStats(chatA) },
      contacts: [{ chatId: A, name: "Arun", isGroup: false, stats: chatStats(chatA), card: card(), examples: replyPairs(chatA), lastTs: 9050 }],
      graph: buildGraph([], new Map()),
    };
    drafter.saveBook(book);
    return { drafter, asked, notes };
  }
  const now = () => Math.floor(Date.now() / 1000);
  const tick = () => new Promise((r) => setTimeout(r, 20));

  it("cleans the model's answer and treats SKIP as no reply", () => {
    expect(cleanDraft('"okk da"')).toBe("okk da");
    expect(cleanDraft("Me: varen da")).toBe("varen da");
    expect(cleanDraft("SKIP")).toBeUndefined();
  });

  it("drafts after their messages, in a direct chat only, and notifies the phone", async () => {
    const { drafter, asked, notes } = setup({ claude: "seri da varen" });
    const r = drafter.ingest([msg(A, false, "match ku varuviya", now()), msg("444@g.us", false, "group news", now())]);
    expect(r.scheduled).toBe(1);
    await tick();
    expect(asked).toHaveLength(1);
    expect(asked[0].req.prompt).toContain("match ku varuviya");
    expect(drafter.drafts()).toMatchObject([{ chatId: A, name: "Arun", phone: "111", text: "seri da varen", incoming: "match ku varuviya", provider: "claude" }]);
    expect(notes).toEqual(["Reply to Arun"]);
  });

  it("retires the draft when you reply yourself, and ignores history", async () => {
    const { drafter, asked } = setup({ claude: "seri da" });
    drafter.ingest([msg(A, false, "free ah", now())]);
    await tick();
    expect(drafter.drafts()).toHaveLength(1);
    drafter.ingest([msg(A, true, "illa da busy", now())]);
    expect(drafter.drafts()).toEqual([]);
    drafter.ingest([msg(A, false, "old one", now() - 7200)]);
    drafter.ingest([msg(A, false, "synced", now())], false);
    await tick();
    expect(asked).toHaveLength(1);
  });

  it("falls back to the next model, and writes what you ask for", async () => {
    const { drafter, asked } = setup({ claude: null, gemini: "6 ku call panren da" });
    drafter.ingest([msg(A, false, "eppo call panra", now())], false);
    const d = await drafter.draft(A, "call at 6");
    expect(asked.map((a) => a.id)).toEqual(["claude", "gemini"]);
    expect(asked[1].req.prompt).toContain("What I want to say: call at 6");
    expect(d).toMatchObject({ text: "6 ku call panren da", provider: "gemini" });
    expect(drafter.close(d!.id, "sent")).toBe(true);
    expect(drafter.drafts()).toEqual([]);
  });
});

describe("terms of address", () => {
  it("counts what you call them, spellings together, ignoring strays", () => {
    const mine = ["seri sir", "ok sirr", "thanks sir", "sure sir", "bro wait", ...Array(20).fill("noted sir")];
    expect(addressTerms(mine)).toEqual([{ term: "sir", n: 24 }]);
    expect(addressTerms(["vaa da", "seri daa", "machi enga", "macha sollu"])).toEqual([
      { term: "da", n: 2 },
      { term: "machi", n: 2 },
    ]);
  });

  it("swaps a wrong term for yours, keeps family words and spellings, drops one when you use none", () => {
    expect(fixAddress("Seri bro, naan varen da", ["da"])).toEqual({ text: "Seri da, naan varen da", fixed: ["bro"] });
    expect(fixAddress("Sir, I will send it ji", ["sir"]).text).toBe("Sir, I will send it sir");
    expect(fixAddress("seri daa", ["da"]).fixed).toEqual([]);
    expect(fixAddress("anna kitta kelu machi", ["da"]).text).toBe("anna kitta kelu da");
    expect(fixAddress("ok da, varen", []).text).toBe("ok, varen");
  });

  it("learns your own nicknames from the config", () => {
    addTerms(["chinna chinnu"]);
    expect(addressTerms(["vaa chinnu", "chinna sollu"])).toEqual([{ term: "chinna", n: 2 }]);
  });

  it("corrects the term in a hub draft", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orc-wa-"));
    const store = new Store(dir);
    cleanup.push(() => (store.close(), rmSync(dir, { recursive: true, force: true })));
    const wa = new WaStore(store);
    const pool = { available: async () => ["claude" as ProviderId], run: async () => ({ ok: true, text: "seri bro varen", provider: "claude" as ProviderId, durationMs: 1 }) };
    const drafter = new ReplyDrafter(store, wa, pool, { dataDir: dir, delaySeconds: 0, auto: false, groups: false, provider: "auto", node: "hub" });
    drafter.saveBook({ version: 1, builtAt: 1, model: "m", owner: { stats: chatStats(chatA) }, contacts: [{ chatId: A, name: "Arun", isGroup: false, stats: chatStats(chatA), card: card(), examples: [], lastTs: 1 }], graph: buildGraph([], new Map()) });
    wa.save([...chatA, msg(A, false, "varuviya", 9999)]);
    expect((await drafter.draft(A))?.text).toBe("seri da varen");
  });
});
