import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildGraph, chatStats, learnStyle, normalizeCard, replyPairs, type StyleBook, type StyleCard } from "../src/whatsapp/learn.js";
import { content } from "../src/whatsapp/link.js";
import { buildPool, groundCard, poolPrompt } from "../src/whatsapp/pool.js";
import { cleanDraft, ReplyDrafter, replyOptions } from "../src/whatsapp/drafter.js";
import { mimic, spellingMap, stockMessages } from "../src/whatsapp/spelling.js";
import { addressTerms, addTerms, fitAddress, fixAddress, momentOf, studyAddress } from "../src/whatsapp/address.js";
import type { ProviderId, ProviderRequest } from "../src/types.js";
import { WaStore, type WaMessage } from "../src/whatsapp/store.js";
import { Store } from "../src/store/db.js";
import { MemoryReplica } from "../src/shared/replica.js";
import { findPerson, personKnowledge } from "../src/whatsapp/knowledge.js";
import { addressRule, newContactRule } from "../src/whatsapp/pool.js";

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
    expect(prompt).toContain("Give my reply options to their last message(s).");
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
  function setup(answers: Partial<Record<ProviderId, string | null>>, knowledge?: (who: { name: string; chatId: string; isGroup: boolean }) => string[]) {
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
    const drafter = new ReplyDrafter(store, wa, pool, { dataDir: dir, delaySeconds: 0, auto: true, groups: false, provider: "auto", node: "hub", knowledge }, (p) => notes.push(`${p.title}\n${p.body}`));
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

  it("asks memory about the person and puts it in the prompt; a broken memory never stops a reply", async () => {
    const seen: string[] = [];
    const answer = JSON.stringify({ options: [{ label: "Yes", text: "seri da" }] });
    const { drafter, asked } = setup({ claude: answer }, (who) => (seen.push(`${who.name}|${who.chatId}`), ["Arun: college friend; plays cricket on Sundays."]));
    drafter.ingest([msg(A, false, "match ku varuviya da", now())], false);
    expect(await drafter.draft(A)).toBeTruthy();
    expect(seen).toEqual([`Arun|${A}`]);
    expect(asked[0].req.prompt).toContain("- Arun: college friend; plays cricket on Sundays.");

    const broken = setup({ claude: answer }, () => {
      throw new Error("memory db locked");
    });
    broken.drafter.ingest([msg(A, false, "match ku varuviya da", now())], false);
    expect(await broken.drafter.draft(A)).toBeTruthy();
  });

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
    // Who wrote, what they said, and what you might answer.
    expect(notes).toEqual(["WhatsApp · Arun\nThey: match ku varuviya\nYou: seri da varen"]);
  });

  it("suggests a reply for a message the phone saw, by contact name, without storing or sending", async () => {
    const { drafter, asked, notes } = setup({ claude: "varen da, 6 ku" });
    drafter.ingest([msg(A, false, "earlier", now() - 7200)], false);
    const s = await drafter.suggest("arun", "match ku varuviya?");
    expect(s).toMatchObject({ provider: "claude", known: true });
    expect(s.options).toHaveLength(1);
    expect(s.options[0].text).toMatch(/^varen.*6 ku$/); // in your style for Arun
    expect(asked[0].req.prompt).toContain("match ku varuviya?");
    expect(drafter.drafts()).toEqual([]);
    // The phone now shows WhatsApp replies itself: the hub's own draft notifications stop.
    drafter.ingest([msg(A, false, "seri ah", now())]);
    await tick();
    expect(drafter.drafts()).toHaveLength(1);
    expect(notes).toEqual([]);
  });

  it("suggests from the conversation alone for someone the hub has never seen", async () => {
    const { drafter, asked } = setup({ claude: "Sure, see you at 5" });
    const s = await drafter.suggest("Priya Office", "Can we meet at 5?");
    expect(s).toMatchObject({ known: false, options: [{ text: "Sure, see you at 5" }] });
    expect(asked[0].req.prompt).toContain("Can we meet at 5?");
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

describe("terms of address by moment", () => {
  // How I write to Varun: ji when asking a favour or thanking, machi when joking or excited, da otherwise.
  const mine = [
    "ji can you send the file pls", "pls check once ji", "konjam help pannunga ji", "thanks ji", "thank you ji", "tq ji",
    "machi semma!!", "lol machi", "haha machi loosu", "machi vera level", "super machi",
    "seri da", "naan varen da", "office la irukken da", "ok da", "da enga irukka?",
  ];
  const pairs = [
    { them: "enna aachu", me: "ji can you send the file pls" },
    { them: "I got the job!", me: "machi semma!!" },
    { them: "varuviya", me: "naan varen da" },
  ];

  it("reads what a message is doing", () => {
    expect(momentOf("ji can you send it pls")).toBe("ask");
    expect(momentOf("lol machi")).toBe("tease");
    expect(momentOf("thanks da")).toBe("thanks");
    expect(momentOf("enga irukka?")).toBe("question");
    expect(momentOf("naan varen da")).toBe("inform");
  });

  it("learns which term goes with which moment, with real examples", () => {
    const s = studyAddress(mine, pairs);
    const by = Object.fromEntries(s.terms.map((t) => [t.term, t]));
    expect(by.ji.when).toMatchObject({ ask: 3, thanks: 3 });
    expect(by.machi.when).toMatchObject({ tease: 2, excited: 3 });
    expect(by.da.when).toMatchObject({ agree: 2, inform: 2 });
    expect(by.machi.after).toMatchObject({ excited: 1 });
    expect(by.machi.examples?.[0]).toBe("Them: I got the job! → Me: machi semma!!");
  });

  it("puts the moment rule in the prompt and fixes a draft that uses the wrong term for the moment", () => {
    const s = studyAddress(mine, pairs);
    const rule = addressRule({ address: s.terms, addressBasis: mine.length, addressNone: s.none });
    expect(rule).toContain("changes with the moment");
    expect(rule).toContain("\"ji\" (6 messages): when thanking (3), asking a favour or for something (3)");
    expect(rule).toContain("asking a favour or for something: ji 3");
    expect(fitAddress("machi can you send it pls", s.terms).text).toBe("ji can you send it pls");
    expect(fitAddress("Thanks da", s.terms).text).toBe("Thanks ji");
    expect(fitAddress("seri da", s.terms).fixed).toEqual([]); // no clear habit for "agree": left alone
    expect(fitAddress("semma da", s.terms).text).toBe("semma machi");
    expect(fitAddress("haha da", s.terms).fixed).toEqual([]); // two jokes are not a habit yet
  });
});

describe("your spelling and reply options", () => {
  it("learns the spellings you mostly use and your stock messages", () => {
    const mine = ["okk da", "okk bro", "ok fine", "ok seri", "okk", "okk", "okk", "okay", "bcoz busy", "bcoz", "bcoz", "bcoz", "bcoz", "bcoz", "because", "u coming?", "u there", "okk da", "Seri da."];
    const map = spellingMap(mine);
    expect(map.okay).toBe("okk"); // 1 of 9: not your spelling
    expect(map.ok).toBeUndefined(); // 2 of 9: both are yours, both stay
    expect(map.because).toBe("bcoz");
    expect(map.you).toBeUndefined(); // two uses of "u" are not enough to call it a habit
    expect(stockMessages(mine)).toEqual(["bcoz", "okk", "okk da"]);
  });

  it("rewrites a tidy draft into your habits and keeps the words", () => {
    const h = { spelling: { ok: "okk", because: "bcoz", you: "u" }, lowercaseStart: 0.9, fullStops: 0 };
    expect(mimic("Ok da, I can't come because of exam.\nWill call you.", h)).toBe("okk da, I can't come bcoz of exam\nwill call u");
    expect(mimic("Ok sir.", { ...h, lowercaseStart: 0.1, fullStops: 0.8 })).toBe("Okk sir.");
  });

  const pool = (over: Partial<ReturnType<typeof buildPool>> = {}) => ({
    ...buildPool({ version: 1, builtAt: 0, model: "m", owner: { stats: chatStats([]) }, contacts: [], graph: buildGraph([], new Map()) }, { chatId: A, isGroup: false }, []),
    address: [{ term: "da", n: 9 }],
    spelling: { ok: "okk" },
    stats: { ...chatStats(chatA), lowercaseStart: 1, fullStops: 0 },
    ...over,
  });

  it("turns the model's JSON into accept / decline options in your style", () => {
    const answer = 'Sure:\n{"options":[{"label":"Yes","text":"Ok bro, varen."},{"label":"No","text":"Illa da, mudiyadhu"},{"label":"Later","text":"Ok bro, varen."}]}';
    expect(replyOptions(answer, pool())).toEqual([
      { label: "Yes", text: "okk da, varen" },
      { label: "No", text: "illa da, mudiyadhu" },
    ]);
    expect(replyOptions("Ok bro", pool())).toEqual([{ label: "Reply", text: "okk da" }]);
    expect(replyOptions('{"options":[]}', pool())).toEqual([]);
  });

  it("asks the model for options and to copy your spelling, words and stock messages", () => {
    const p = { ...pool(), words: ["okk", "pannalam"], stock: ["okk da"] };
    const { system, prompt } = poolPrompt(p);
    expect(system).toContain("copy my spellings, shortcuts, slang and mistakes exactly");
    expect(system).toContain('{"options":[{"label":"…","text":"…"}]}');
    expect(prompt).toContain("Words as I spell them (use these spellings): okk, pannalam.");
    expect(prompt).toContain("ok → okk");
    expect(prompt).toContain('Messages I often send, word for word (reuse them when they fit): "okk da".');
  });
});


describe("what memory knows about the person a reply is for", () => {
  const J = "919876543210@s.whatsapp.net";
  function memoryWithJayesh() {
    const dir = mkdtempSync(join(tmpdir(), "orc-know-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const r = new MemoryReplica(join(dir, "m.db"), "hub");

    cleanup.unshift(() => r.close());
    // as the brain mirrors him: the chat id is a slugged alias
    r.put({ uid: "person:jayesh-daga", kind: "person", title: "Jayesh Daga", body: "Classmate; co-inventor on the patent.", aliases: ["919876543210-s-whatsapp-net", "jd"] });
    r.put({ kind: "fact", title: "calls", body: "Jayesh prefers calls after 6 pm on weekdays.", subject: "person:jayesh-daga" });
    r.put({ uid: "relation:jayesh-daga~co_inventor_of~water-patent", kind: "relation", title: "Jayesh Daga co inventor of Water patent", data: { src: "person:jayesh-daga", rel: "co_inventor_of", dst: "project:water-patent" } });
    r.put({ uid: "task:7", kind: "task", title: "Send the patent draft to Jayesh", tags: "Jayesh Daga", data: { status: "open", due_at: "2026-10-31T12:30:00+00:00" } });
    r.put({ uid: "task:8", kind: "task", title: "Old thing with Jayesh", tags: "Jayesh Daga", data: { status: "done" } });
    r.put({ uid: "task:9", kind: "task", title: "Pay Jayaraman", tags: "Jayaraman", data: { status: "open" } });
    return r;
  }

  it("finds them by chat id even under another name, and by exact name; never by a near miss", () => {
    const r = memoryWithJayesh();
    expect(findPerson(r, { name: "JD College", chatId: J, isGroup: false })?.uid).toBe("person:jayesh-daga");
    expect(findPerson(r, { name: "Jayesh Daga", chatId: "1@s.whatsapp.net", isGroup: false })?.uid).toBe("person:jayesh-daga");
    expect(findPerson(r, { name: "Jayesh", chatId: "1@s.whatsapp.net", isGroup: false })).toBeUndefined();
    expect(findPerson(r, { name: "+91 98765 43210", chatId: "2@s.whatsapp.net", isGroup: false })).toBeUndefined();
  });

  it("gives who they are, facts, links and only their open tasks", () => {
    const lines = personKnowledge(memoryWithJayesh(), { name: "Jayesh Daga", chatId: J, isGroup: false });
    expect(lines[0]).toBe("Jayesh Daga: Classmate; co-inventor on the patent.");
    expect(lines).toContain("Jayesh prefers calls after 6 pm on weekdays.");
    expect(lines).toContain("Jayesh Daga co inventor of Water patent");
    expect(lines).toContain("Open task with them: Send the patent draft to Jayesh (due 2026-10-31)");
    expect(lines.join("\n")).not.toMatch(/Old thing|Jayaraman/);
  });

  it("goes into the reply prompt as background, and the drafter asks for it", async () => {
    const r = memoryWithJayesh();
    const book: StyleBook = { version: 1, builtAt: 0, model: "m", owner: { stats: chatStats([]) }, contacts: [], graph: buildGraph([], new Map()) };
    const p = buildPool(book, { chatId: J, name: "Jayesh Daga", isGroup: false }, [msg(J, true, "hi", 1), msg(J, false, "bro can you send it today?", 2)], {
      knowledge: personKnowledge(r, { name: "Jayesh Daga", chatId: J, isGroup: false }),
    });
    const { prompt } = poolPrompt(p);
    expect(prompt).toContain("What I know about them, from my own notes");
    expect(prompt).toContain("- Open task with them: Send the patent draft to Jayesh (due 2026-10-31)");
    expect(p.newContact).toBe(false); // I have written to him
    expect(prompt).not.toContain("never written to");
  });
});

describe("first contacts", () => {
  const book: StyleBook = { version: 1, builtAt: 0, model: "m", owner: { stats: chatStats([]) }, contacts: [], graph: buildGraph([], new Map()) };
  const N = "4455@s.whatsapp.net";

  it("an unknown number gets the stranger rules: neutral, nothing personal, ask who, skip spam", () => {
    const p = buildPool(book, { chatId: N, name: "+91 44 5566 7788", isGroup: false }, [msg(N, false, "hi is this the hackathon team lead?", 1)]);
    expect(p).toMatchObject({ newContact: true, unknownNumber: true });
    const { prompt } = poolPrompt(p);
    expect(prompt).toContain("is not in my contacts and I have never written to them");
    expect(prompt).toContain('labelled "Who is this?"');
    expect(prompt).toContain("don't agree to meet, pay, send money or commit");
    expect(prompt).toContain('answer {"options":[]}');
  });

  it("a saved contact I never wrote to is new but not unknown, and my notes about them still count", () => {
    const p = buildPool(book, { chatId: N, name: "Prof. Om Kumar", isGroup: false }, [msg(N, false, "Please send the report", 1)], {
      knowledge: ["Prof. Om Kumar: professor; co-inventor on the patent."],
    });
    expect(p).toMatchObject({ newContact: true, unknownNumber: false });
    expect(newContactRule(p)).toContain("I have never written to Prof. Om Kumar before");
    expect(newContactRule(p)).toContain("beyond what my notes above say");
  });

  it("groups never get the stranger rules", () => {
    const G = "999@g.us";
    const p = buildPool(book, { chatId: G, name: "New hackathon group", isGroup: true }, [msg(G, false, "welcome all", 1)]);
    expect(poolPrompt(p).prompt).not.toContain("never written to");
  });
});
