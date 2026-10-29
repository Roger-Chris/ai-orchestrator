import { addressTerms, type AddressUse } from "./address.js";
import { ollamaJson, type LocalModelOptions } from "./local.js";
import { spellingMap, stockMessages, topWords } from "./spelling.js";
import { groundCard } from "./pool.js";
import { spoken, type WaChat, type WaMessage, type WaStore } from "./store.js";

/**
 * Learns how you write on WhatsApp, chat by chat, using only the local model: what you call each
 * person, the language and script you use with them, how long and how casual your messages are,
 * your emoji and pet phrases, and real examples of their message → your reply. The result (the
 * "style book") is what the hub's online models are given to draft replies that sound like you.
 */

/** Measured from your own messages; no model involved. */
export interface ChatStats {
  mine: number;
  theirs: number;
  avgWords: number;
  /** Share of your messages of four words or fewer. */
  shortShare: number;
  emojiPerMessage: number;
  topEmoji: string[];
  /** Share of your messages written in Tamil script (the rest is Latin letters). */
  tamilScript: number;
  /** Share of your messages that start with a lowercase letter. */
  lowercaseStart: number;
  /** Share of your messages that end with a full stop. */
  fullStops: number;
  /** Your most common first and last words: greetings and terms of address live here. */
  openers: string[];
  closers: string[];
  /** How many messages you send in a row on average. */
  burst: number;
  voiceNotes: number;
  /** Median minutes before you reply. */
  replyMinutes?: number;
  /** What you call them (sir, ji, bro, machi, da, di…), counted from your messages; most used first. */
  address: AddressUse[];
  /** Your spelling of words with several spellings: { ok: "okk", because: "bcoz" }. */
  spelling: Record<string, string>;
  /** Your most used words, spelt your way. */
  words: string[];
  /** Short messages you send again and again, exactly as typed. */
  stock: string[];
}

/** A real exchange: what they said, then what you sent back. */
export interface ReplyPair {
  them: string;
  me: string;
  ts: number;
}

/** The local model's notes on how you write to one person or group. */
export interface StyleCard {
  relationship: string;
  addressAs: string[];
  theyCallMe: string[];
  language: string;
  tone: string;
  /** 1 very casual … 5 formal. */
  formality: number;
  length: string;
  emoji: string;
  phrases: string[];
  topics: string[];
  avoid: string[];
  notes: string;
}

export interface ContactStyle {
  chatId: string;
  name: string;
  isGroup: boolean;
  stats: ChatStats;
  card?: StyleCard;
  examples: ReplyPair[];
  /** Newest message seen when this was learnt; a later run reuses the card if nothing is newer. */
  lastTs: number;
}

export interface Voice {
  summary: string;
  languages: string;
  habits: string[];
  phrases: string[];
  avoid: string[];
}

export interface StyleGraph {
  nodes: { id: string; label: string; kind: "me" | "person" | "group"; weight: number }[];
  edges: { from: string; to: string; kind: "chats" | "member"; weight: number; label?: string }[];
}

export interface StyleBook {
  version: 1;
  builtAt: number;
  /** The local model that wrote the cards. */
  model: string;
  owner: { id?: string; stats: ChatStats; voice?: Voice };
  contacts: ContactStyle[];
  graph: StyleGraph;
}

export interface LearnOptions extends Pick<LocalModelOptions, "ollamaUrl" | "model"> {
  /** Chats where you have sent fewer messages than this are skipped. */
  minMine: number;
  maxContacts: number;
  /** Only (re)learn chats whose name contains this. */
  only?: string;
  /** Your own id, so the notes-to-self chat is left out. */
  me?: string;
  log: (s: string) => void;
  http?: typeof fetch;
}

const EMOJI = /\p{Extended_Pictographic}/gu;
const TAMIL = /[஀-௿]/;
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
const top = (counts: Map<string, number>, n: number, min = 2) =>
  [...counts.entries()]
    .filter(([, c]) => c >= min)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
const bump = (m: Map<string, number>, k: string | undefined) => k && m.set(k, (m.get(k) ?? 0) + 1);
const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function chatStats(msgs: WaMessage[]): ChatStats {
  const mine = msgs.filter((m) => m.fromMe);
  const texts = mine.map((m) => (m.transcript ?? m.text).trim()).filter(Boolean);
  const emoji = new Map<string, number>();
  const openers = new Map<string, number>();
  const closers = new Map<string, number>();
  let totalWords = 0;
  let short = 0;
  let emojiCount = 0;
  let tamil = 0;
  let lower = 0;
  let stops = 0;
  for (const t of texts) {
    const w = words(t);
    totalWords += w.length;
    if (w.length <= 4) short++;
    for (const e of t.match(EMOJI) ?? []) {
      emojiCount++;
      bump(emoji, e);
    }
    if (TAMIL.test(t)) tamil++;
    if (/^\p{Ll}/u.test(t)) lower++;
    if (/[^.]\.$/.test(t)) stops++;
    bump(openers, w[0]);
    if (w.length > 1) bump(closers, w[w.length - 1]);
  }
  let runs = 0;
  for (let i = 0; i < msgs.length; i++) if (msgs[i].fromMe && (i === 0 || !msgs[i - 1].fromMe)) runs++;
  const gaps = replyGaps(msgs).sort((a, b) => a - b);
  const n = texts.length || 1;
  return {
    mine: mine.length,
    theirs: msgs.length - mine.length,
    avgWords: round(totalWords / n, 1),
    shortShare: round(short / n),
    emojiPerMessage: round(emojiCount / n),
    topEmoji: top(emoji, 6),
    tamilScript: round(tamil / n),
    lowercaseStart: round(lower / n),
    fullStops: round(stops / n),
    openers: top(openers, 8, 3),
    closers: top(closers, 8, 3),
    burst: round(mine.length / (runs || 1), 1),
    voiceNotes: mine.filter((m) => m.mediaType === "audio").length,
    replyMinutes: gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : undefined,
    address: addressTerms(texts),
    spelling: spellingMap(texts),
    words: topWords(texts),
    stock: stockMessages(texts),
  };
}

/** Minutes between their last message and your answer, for answers within six hours. */
function replyGaps(msgs: WaMessage[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < msgs.length; i++) {
    if (msgs[i].fromMe && !msgs[i - 1].fromMe) {
      const gap = (msgs[i].ts - msgs[i - 1].ts) / 60;
      if (gap >= 0 && gap <= 360) out.push(gap);
    }
  }
  return out;
}

/** Their messages followed by your reply (within six hours), newest last; at most `max`. */
export function replyPairs(msgs: WaMessage[], max = 10): ReplyPair[] {
  const runs: { fromMe: boolean; items: WaMessage[] }[] = [];
  for (const m of msgs) {
    const last = runs[runs.length - 1];
    if (last && last.fromMe === m.fromMe) last.items.push(m);
    else runs.push({ fromMe: m.fromMe, items: [m] });
  }
  const pairs: ReplyPair[] = [];
  for (let i = 1; i < runs.length; i++) {
    const them = runs[i - 1];
    const me = runs[i];
    if (!me.fromMe || them.fromMe) continue;
    if (me.items[0].ts - them.items[them.items.length - 1].ts > 6 * 3600) continue;
    // Only replies with words in them teach style; a lone photo or sticker does not.
    const mine = me.items.filter((m) => /\p{L}/u.test(m.transcript ?? m.text)).map(spoken);
    if (!mine.length) continue;
    const theirs = them.items.slice(-3).map((m) => (m.isGroup && m.senderName ? `${m.senderName}: ${spoken(m)}` : spoken(m)));
    pairs.push({ them: clip(theirs.join("\n"), 400), me: clip(mine.join("\n"), 400), ts: me.items[0].ts });
  }
  return pairs.slice(-max);
}

/** The conversation as a model reads it: oldest first, one line per message. */
export function transcriptOf(msgs: WaMessage[], max = 120): string {
  return msgs
    .slice(-max)
    .map((m) => `${m.fromMe ? "Me" : m.isGroup ? (m.senderName ?? "Someone") : "Them"}: ${clip(spoken(m).replace(/\s*\n\s*/g, " / "), 220)}`)
    .join("\n");
}

const CARD_SYSTEM =
  'You study how one person, "Me", writes on WhatsApp so that an assistant can later reply exactly like them. Look only at how Me writes. Many chats are in Tanglish (Tamil written in English letters, mixed with English); keep such words exactly as written, never translate them. Answer with JSON only.';

export function cardPrompt(c: { name: string; isGroup: boolean }, stats: ChatStats, msgs: WaMessage[]): string {
  return [
    `Chat: ${c.isGroup ? `the group "${c.name}"` : `a direct chat with ${c.name}`}.`,
    `Measured from my ${stats.mine} messages here: ${stats.avgWords} words on average, ${Math.round(stats.shortShare * 100)}% are four words or fewer, ${stats.emojiPerMessage} emoji per message${stats.topEmoji.length ? ` (${stats.topEmoji.join(" ")})` : ""}, ${Math.round(stats.tamilScript * 100)}% in Tamil script, ${Math.round(stats.lowercaseStart * 100)}% start lowercase, ${Math.round(stats.fullStops * 100)}% end with a full stop, ${stats.burst} messages in a row on average. Common first words: ${stats.openers.join(", ") || "none"}. Common last words: ${stats.closers.join(", ") || "none"}.`,
    "",
    "Conversation, oldest first:",
    transcriptOf(msgs),
    "",
    "Describe how I (Me) write in this chat. Return this JSON:",
    `{"relationship": "who they are to me in a few words (e.g. close friend, younger brother, classmate, professor, client, family group)",
"addressAs": ["names, nicknames or words I use to address them, e.g. da, machi, bro, sir, anna, their name"],
"theyCallMe": ["what they call me"],
"language": "the language and script I write in here, e.g. Tanglish (Tamil in English letters mixed with English)",
"tone": "a few words",
"formality": 1,
"length": "one-liners | short | medium | long",
"emoji": "how I use emoji here",
"phrases": ["up to 8 words or short phrases I really use here, copied exactly"],
"topics": ["up to 6 things we talk about"],
"avoid": ["things I never do here, e.g. no full stops, no formal greetings, never English-only"],
"notes": "one or two sentences on anything else that matters to reply as me"}`,
    "formality is 1 (very casual) to 5 (formal).",
  ].join("\n");
}

const strs = (v: unknown, n: number) =>
  (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : [])
    .filter((x): x is string => typeof x === "string" && !!x.trim())
    .map((x) => x.trim().slice(0, 80))
    .slice(0, n);
const str = (v: unknown, n = 300) => (typeof v === "string" ? v.trim().slice(0, n) : "");

/** Keeps a model's card to the expected shape; undefined when it is not a card at all. */
export function normalizeCard(raw: any): StyleCard | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const card: StyleCard = {
    relationship: str(raw.relationship, 80),
    addressAs: strs(raw.addressAs, 8),
    theyCallMe: strs(raw.theyCallMe, 6),
    language: str(raw.language, 120),
    tone: str(raw.tone, 80),
    formality: Math.min(5, Math.max(1, Math.round(Number(raw.formality) || 2))),
    length: str(raw.length, 40),
    emoji: str(raw.emoji, 120),
    phrases: strs(raw.phrases, 8),
    topics: strs(raw.topics, 6),
    avoid: strs(raw.avoid, 6),
    notes: str(raw.notes, 400),
  };
  return card.language || card.tone || card.relationship ? card : undefined;
}

export function voicePrompt(stats: ChatStats, cards: { name: string; card: StyleCard }[], sample: WaMessage[]): string {
  return [
    `Measured over all my ${stats.mine} messages: ${stats.avgWords} words on average, ${Math.round(stats.shortShare * 100)}% four words or fewer, ${stats.emojiPerMessage} emoji per message, ${Math.round(stats.tamilScript * 100)}% in Tamil script, ${Math.round(stats.lowercaseStart * 100)}% start lowercase, ${Math.round(stats.fullStops * 100)}% end with a full stop.`,
    "",
    "How I write to some of the people I talk to most:",
    ...cards.slice(0, 25).map(({ name, card }) => `- ${name} (${card.relationship}): ${card.language}; ${card.tone}; formality ${card.formality}; I call them ${card.addressAs.join("/") || "nothing in particular"}`),
    "",
    "A random sample of my own messages:",
    ...sample.map((m) => `- ${clip(spoken(m).replace(/\s*\n\s*/g, " / "), 200)}`),
    "",
    "Describe my overall way of writing on WhatsApp. Return this JSON:",
    `{"summary": "three or four sentences an assistant can follow to sound like me",
"languages": "which languages and scripts I use and when I switch",
"habits": ["up to 8 habits: casing, punctuation, message splitting, emoji, spelling, slang"],
"phrases": ["up to 10 words or phrases I use a lot, copied exactly"],
"avoid": ["up to 6 things I never do"]}`,
  ].join("\n");
}

function normalizeVoice(raw: any): Voice | undefined {
  if (!raw || typeof raw !== "object" || !str(raw.summary)) return undefined;
  return { summary: str(raw.summary, 800), languages: str(raw.languages, 200), habits: strs(raw.habits, 8), phrases: strs(raw.phrases, 10), avoid: strs(raw.avoid, 6) };
}

/** Who you talk to, how much, and which of them share your groups. */
export function buildGraph(contacts: ContactStyle[], members: Map<string, Set<string>>, me = "me"): StyleGraph {
  const nodes: StyleGraph["nodes"] = [{ id: me, label: "Me", kind: "me", weight: 0 }];
  const edges: StyleGraph["edges"] = [];
  const people = new Set(contacts.filter((c) => !c.isGroup).map((c) => c.chatId));
  for (const c of contacts) {
    const weight = c.stats.mine + c.stats.theirs;
    nodes.push({ id: c.chatId, label: c.name, kind: c.isGroup ? "group" : "person", weight });
    edges.push({ from: me, to: c.chatId, kind: "chats", weight, label: c.card?.relationship || undefined });
    nodes[0].weight += weight;
    if (c.isGroup) for (const p of members.get(c.chatId) ?? []) if (people.has(p)) edges.push({ from: p, to: c.chatId, kind: "member", weight: 1 });
  }
  return { nodes, edges };
}

/** Builds (or refreshes) the style book. Unchanged chats keep their card from `previous`. */
export async function learnStyle(store: WaStore, o: LearnOptions, previous?: StyleBook): Promise<StyleBook> {
  const old = new Map((previous?.contacts ?? []).map((c) => [c.chatId, c]));
  const chats = store
    .chats()
    .filter((c: WaChat) => c.mine >= o.minMine && c.id !== o.me)
    .slice(0, o.maxContacts);
  const contacts: ContactStyle[] = [];
  const members = new Map<string, Set<string>>();
  const all: WaMessage[] = [];
  for (const [i, c] of chats.entries()) {
    const msgs = store.messages(c.id, 400);
    all.push(...msgs);
    if (c.isGroup) members.set(c.id, new Set(msgs.filter((m) => !m.fromMe).map((m) => m.senderId)));
    const name = c.name ?? `+${c.id.split("@")[0]}`;
    const stats = chatStats(msgs);
    const base: ContactStyle = { chatId: c.id, name, isGroup: c.isGroup, stats, examples: replyPairs(msgs, 10), lastTs: c.last };
    const prev = old.get(c.id);
    const wanted = !o.only || name.toLowerCase().includes(o.only.toLowerCase());
    const mine = msgs.filter((m) => m.fromMe).map((m) => m.transcript ?? m.text);
    if (!wanted || (prev?.card && prev.lastTs === c.last)) {
      contacts.push({ ...base, card: prev?.card && groundCard(prev.card, mine, name) });
      continue;
    }
    o.log(`  [${i + 1}/${chats.length}] ${name}${c.isGroup ? " (group)" : ""}: ${c.mine} of your messages`);
    const raw = await ollamaJson<unknown>(o, CARD_SYSTEM, cardPrompt({ name, isGroup: c.isGroup }, stats, msgs), o.http).catch((e) => {
      o.log(`    skipped: ${(e as Error).message}`);
      return undefined;
    });
    const card = normalizeCard(raw) ?? prev?.card;
    contacts.push({ ...base, card: card && groundCard(card, mine, name) });
  }

  const stats = chatStats(all.sort((a, b) => a.ts - b.ts));
  o.log("Writing your overall voice…");
  const cards = contacts.filter((c) => c.card).map((c) => ({ name: c.name, card: c.card! }));
  const voice = normalizeVoice(await ollamaJson<unknown>(o, CARD_SYSTEM, voicePrompt(stats, cards, store.sampleMine(80)), o.http).catch(() => undefined)) ?? previous?.owner.voice;
  return {
    version: 1,
    builtAt: Date.now(),
    model: o.model,
    owner: { id: o.me, stats, voice },
    contacts,
    graph: buildGraph(contacts, members, o.me ?? "me"),
  };
}
