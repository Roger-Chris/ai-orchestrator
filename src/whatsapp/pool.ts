import type { ChatStats, ContactStyle, ReplyPair, StyleBook, StyleCard, Voice } from "./learn.js";
import { spoken, type WaMessage } from "./store.js";
import { addressTerms, type AddressUse } from "./address.js";

/**
 * The context pool a reply is written from. Every analysed person in the style book feeds it:
 * this chat's own profile and examples first, then the people most like them (same kind of
 * relationship and formality) when this chat has few examples or none, plus your overall voice,
 * the groups you share and the conversation so far. `poolPrompt` turns it into the instructions
 * an online model gets to write your next message.
 */

export interface PoolExample extends ReplyPair {
  /** Whose chat the example comes from; differs from the pool's chat when it was borrowed. */
  from: string;
}

export interface ContextPool {
  chatId: string;
  name: string;
  isGroup: boolean;
  voice?: Voice;
  /** This person's profile; for a chat never studied, the closest person's. */
  card?: StyleCard;
  stats?: ChatStats;
  /** What you call them, counted from your messages in this chat; never borrowed from anyone else. */
  address: AddressUse[];
  /** How many of your messages that count is based on. */
  addressBasis: number;
  /** Your spellings (yours over all chats, this chat's on top), your words and stock messages. */
  spelling: Record<string, string>;
  words: string[];
  stock: string[];
  /** "own": studied chat. "similar": borrowed from the people in `similar`. "voice": only your overall voice. */
  basis: "own" | "similar" | "voice";
  similar: string[];
  examples: PoolExample[];
  sharedGroups: string[];
  recent: WaMessage[];
  /** Their messages since your last one: what the reply answers. Empty means a follow-up from you. */
  incoming: WaMessage[];
}

export interface PoolOptions {
  /** Examples in the pool. */
  examples?: number;
  /** Below this many own examples, look-alikes lend theirs. */
  minOwn?: number;
  /** Messages of the conversation shown. */
  recent?: number;
}

const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []);

function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.sqrt(a.size * b.size);
}

/** How many of your messages contain `term` as a whole word or phrase. */
function uses(term: string, mine: string[]): number {
  const t = term.toLowerCase().trim();
  if (!t) return 0;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "iu");
  return mine.filter((m) => re.test(m)).length;
}

/**
 * Keeps only what the evidence supports: terms of address and phrases you really used in this
 * chat (at least twice), most used first. The local model sometimes lists every Tamil term of
 * address it knows, or plain words like "okk"; those would make replies sound wrong.
 */
export function groundCard(card: StyleCard, mine: string[], name?: string): StyleCard {
  const keep = (list: string[]) =>
    list
      .map((t) => ({ t, n: uses(t, mine) }))
      .filter((x) => x.n >= 2)
      .sort((a, b) => b.n - a.n)
      .map((x) => x.t);
  // A term of address is a known one (da, bro, sir…) or part of their name, never a word like "okk".
  const nameWords = new Set((name ?? "").toLowerCase().match(/\p{L}{3,}/gu) ?? []);
  const isAddress = (t: string) => ADDRESS.has(t.toLowerCase().trim()) || nameWords.has(t.toLowerCase().trim());
  return { ...card, addressAs: keep(card.addressAs.filter(isAddress)), theyCallMe: card.theyCallMe.filter((t) => ADDRESS.has(t.toLowerCase().trim()) || /^\p{Lu}/u.test(t)), phrases: keep(card.phrases) };
}

/** Terms of address used in Tamil and English chats. */
const ADDRESS = new Set(
  "da daa di dei dey bro broo bruh machi macha machan machaa mapla mams mama maams nanba nanbaa thala thalaiva boss sir sirr madam mam maam ma'am anna annaa akka akkaa thambi thangachi thangam chellam kanna kannu paa pa maa ma appa amma uncle aunty aunt bhai dude buddy man guys guyss team frnds friends ji".split(" "),
);

/** People in the book most like this one: same group-ness, then same relationship and formality. */
export function similarPeople(book: StyleBook, target: { isGroup: boolean; card?: StyleCard; formal?: boolean }, exclude: string, n = 3): ContactStyle[] {
  const rel = target.card?.relationship.toLowerCase() ?? "";
  const formality = target.card?.formality ?? (target.formal ? 4 : 1);
  return book.contacts
    .filter((c) => c.chatId !== exclude && c.card && c.isGroup === target.isGroup && c.examples.length)
    .map((c) => {
      const r = c.card!.relationship.toLowerCase();
      const sameRel = rel && r && (r === rel || r.includes(rel) || rel.includes(r)) ? 2 : 0;
      return { c, score: sameRel - Math.abs(c.card!.formality - formality) + Math.min(c.examples.length, 10) / 20 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.c);
}

/** Sounds formal (sir, madam, dear, kindly…): only used to pick look-alikes for a chat never studied. */
const FORMAL = /\b(sir|madam|ma'?am|mam|dear|kindly|regards|respected|greetings)\b/i;

export function buildPool(book: StyleBook, chat: { chatId: string; name?: string; isGroup: boolean }, messages: WaMessage[], o: PoolOptions = {}): ContextPool {
  const max = o.examples ?? 8;
  const minOwn = o.minOwn ?? 5;
  const recent = messages.slice(-(o.recent ?? 30));
  const lastMine = recent.map((m) => m.fromMe).lastIndexOf(true);
  const incoming = recent.slice(lastMine + 1);
  const own = book.contacts.find((c) => c.chatId === chat.chatId);
  const name = [chat.name, own?.name].find((n) => n && !n.startsWith("+")) ?? chat.name ?? own?.name ?? `+${chat.chatId.split("@")[0]}`;

  const ownExamples = (own?.examples ?? []).filter((e) => /\p{L}/u.test(e.me)).map((e) => ({ ...e, from: name }));
  const mine = [...messages.filter((m) => m.fromMe).map((m) => m.transcript ?? m.text), ...ownExamples.map((e) => e.me)];
  let card = own?.card ? groundCard(own.card, mine, name) : undefined;

  const theirText = incoming.map(spoken).join(" ");
  const look = similarPeople(book, { isGroup: chat.isGroup, card, formal: FORMAL.test(theirText) }, chat.chatId);
  const basis: ContextPool["basis"] = card ? "own" : look.length ? "similar" : "voice";
  if (!card && look[0]?.card) card = { ...look[0].card, addressAs: [], theyCallMe: [], topics: [], notes: `not studied yet; written the way I write to ${look[0].name} (${look[0].card.relationship})` };

  // The best examples answer something like what they just said; this chat's own count for more.
  const want = words(theirText || recent.slice(-4).map(spoken).join(" "));
  const borrowed = ownExamples.length < minOwn ? look.flatMap((c) => c.examples.map((e) => ({ ...e, from: c.name }))) : [];
  const examples = [...ownExamples.map((e) => ({ e, bonus: 0.3 })), ...borrowed.map((e) => ({ e, bonus: 0 }))]
    .map(({ e, bonus }) => ({ e, score: bonus + overlap(want, words(e.them)) + e.ts / 1e11 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.e)
    .sort((a, b) => a.ts - b.ts);

  // The book's count covers far more of your messages than the hub keeps; fall back to what is here.
  const address = own?.stats.address ?? addressTerms(mine);
  const addressBasis = own?.stats.address ? own.stats.mine : mine.length;

  const groupName = new Map(book.graph.nodes.filter((n) => n.kind === "group").map((n) => [n.id, n.label]));
  const sharedGroups = book.graph.edges.filter((e) => e.kind === "member" && e.from === chat.chatId).map((e) => groupName.get(e.to) ?? e.to);

  return {
    chatId: chat.chatId,
    name,
    isGroup: chat.isGroup,
    voice: book.owner.voice,
    card,
    stats: own?.stats,
    address,
    addressBasis,
    // A book learnt before these were counted has none; the prompt then just leaves them out.
    spelling: { ...(book.owner.stats.spelling ?? {}), ...(own?.stats.spelling ?? {}) },
    words: own?.stats.words?.length ? own.stats.words : (book.owner.stats.words ?? []),
    stock: [...new Set([...(own?.stats.stock ?? []), ...(book.owner.stats.stock ?? [])])].slice(0, 15),
    basis,
    similar: borrowed.length || basis !== "own" ? look.map((c) => c.name) : [],
    examples,
    sharedGroups,
    recent,
    incoming,
  };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const line = (m: WaMessage, who: string) => `${m.fromMe ? "Me" : m.isGroup ? (m.senderName ?? "Someone") : who}: ${spoken(m).replace(/\s*\n\s*/g, " / ")}`;

/** What to call them, as a rule the model must not bend: the term is how they know it is you. */
export function addressRule(p: Pick<ContextPool, "address" | "addressBasis">): string {
  if (p.address.length) {
    const used = p.address.map((a) => `"${a.term}" (in ${a.n} of my messages)`).join(", ");
    return `What I call them: ${used}. Use ${p.address.length > 1 ? "these, mostly the first," : `"${p.address[0].term}"`} wherever I would address them, and never any other term (no sir, ji, bro, machi, da, di or the like unless listed here).`;
  }
  return p.addressBasis >= 10
    ? "I never use a term of address with them (no sir, ji, bro, machi, da, di): do not add one."
    : "I have not written to them enough to know what I call them: use no term of address (no sir, ji, bro, machi, da, di).";
}

/** The pool as instructions for an online model: system = who you are and how you write, prompt = this chat. */
export function poolPrompt(p: ContextPool, ask?: string): { system: string; prompt: string } {
  const v = p.voice;
  const c = p.card;
  const s = p.stats;
  const system = [
    "You write WhatsApp messages as me, in my own words, so the other person cannot tell it was not me typing. You are not an assistant in this chat and never say you are one.",
    v && `How I write in general: ${v.summary}`,
    v?.languages && `Languages: ${v.languages}`,
    v?.habits.length && `My habits: ${v.habits.join("; ")}.`,
    v?.phrases.length && `Words I use a lot: ${v.phrases.join(", ")}.`,
    v?.avoid.length && `I never: ${v.avoid.join("; ")}.`,
    "Write like I really type, not like a polished writer: copy my spellings, shortcuts, slang and mistakes exactly (okk, pls, bcoz, missing apostrophes, wrong spellings, no capitals or full stops if I don't use them). Never correct my grammar or spelling and never write more neatly than I do. Build replies from my own words and from messages I really sent; don't invent new phrasing when mine fits.",
    "Keep Tanglish as Tanglish (Tamil in English letters): never translate it, and never switch to Tamil script unless I do in this chat. If I would send several short messages, put each on its own line. Never invent facts, times, amounts or promises; where a reply needs something only I know, write a short placeholder in [square brackets].",
    `Answer with JSON only: {"options":[{"label":"…","text":"…"}]}. Give two to four options. When they ask, invite or request something, include one option that agrees and one that says no (and, if natural, one in between such as later, maybe, or a question back). Otherwise give different replies I might really send. "label" is one or two English words (Yes, No, Later, Ask why, Thanks, Okay…); "text" is the message exactly as I would type it.`,
  ]
    .filter(Boolean)
    .join("\n");

  const card =
    c &&
    [
      `${p.isGroup ? "This group" : "They"}: ${c.relationship || "unknown"}${p.basis === "similar" ? ` (${c.notes})` : ""}.`,
      `How I write here: ${c.language}; ${c.tone}; formality ${c.formality} of 5; ${c.length}; emoji: ${c.emoji}.`,
      c.theyCallMe.length && `They call me: ${c.theyCallMe.join(", ")}.`,
      c.phrases.length && `Phrases I use with them: ${c.phrases.join(", ")}.`,
      c.avoid.length && `Here I never: ${c.avoid.join("; ")}.`,
      c.topics.length && `We usually talk about: ${c.topics.join(", ")}.`,
      p.basis === "own" && c.notes,
    ]
      .filter(Boolean)
      .join("\n");
  const prompt = [
    `Chat: ${p.isGroup ? `the group "${p.name}"` : `direct chat with ${p.name}`}.`,
    card,
    !p.isGroup && addressRule(p),
    s &&
      [
        `Measured from my ${s.mine} messages here: about ${s.avgWords} words each, ${pct(s.shortShare)} are four words or fewer, ${s.burst} messages in a row, ${pct(s.lowercaseStart)} start lowercase, ${pct(s.fullStops)} end with a full stop.`,
        s.tamilScript < 0.03 ? "I never write Tamil script here, only English letters." : `${pct(s.tamilScript)} of my messages here are in Tamil script.`,
        s.emojiPerMessage < 0.05 ? "I almost never use emoji here: use none." : `${s.emojiPerMessage} emoji per message${s.topEmoji.length ? `, mostly ${s.topEmoji.join(" ")}` : ""}.`,
      ].join(" "),
    p.words.length && `Words as I spell them (use these spellings): ${p.words.join(", ")}.`,
    Object.keys(p.spelling).length &&
      `My spellings of common words (always write the right side): ${Object.entries(p.spelling)
        .slice(0, 30)
        .map(([a, b]) => `${a} → ${b}`)
        .join(", ")}.`,
    p.stock.length && `Messages I often send, word for word (reuse them when they fit): ${p.stock.map((t) => `"${t}"`).join(", ")}.`,
    p.sharedGroups.length && `Groups we are both in: ${p.sharedGroups.slice(0, 6).join(", ")}.`,
    p.examples.length &&
      [
        `How I actually replied${p.similar.length ? ` (some examples are from my chats with ${p.similar.join(", ")}, people I write to the same way)` : ""}:`,
        ...p.examples.map((e) => `---\nThem: ${e.them.replace(/\n/g, " / ")}\nMe: ${e.me}`),
        "---",
      ].join("\n"),
    `The conversation so far, oldest first:\n${p.recent.map((m) => line(m, p.isGroup ? "Someone" : p.name)).join("\n")}`,
    ask
      ? `Write my next message, as two or three ways I might put it. What I want to say: ${ask}`
      : p.incoming.length
        ? "Give my reply options to their last message(s)."
        : 'My last message has no answer yet. Give follow-up options from me, or {"options":[]} if I would not send anything.',
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system, prompt };
}
