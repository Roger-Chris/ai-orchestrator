/**
 * Terms of address (sir, ji, bro, machi, da, di…): what you call each person is fixed per chat,
 * so it is counted from your own messages, never guessed by a model, and every draft is checked
 * against it. A reply that calls your professor "da" or your friend "sir" is worse than no reply.
 */

export interface AddressUse {
  term: string;
  /** How many of your messages in the chat use it. */
  n: number;
  /** What your messages with it were doing (asking a favour, joking…): moment -> count. */
  when?: Partial<Record<Moment, number>>;
  /** What their message just before was doing, for your replies that use it. */
  after?: Partial<Record<Moment, number>>;
  /** Where it sits in your message: first word, last word, or the whole message. */
  at?: { start: number; end: number; alone: number };
  /** Real exchanges with it, "Them: … → Me: …", different moments where there are. */
  examples?: string[];
}

/**
 * What one message is doing, read from Tanglish/English cues. With the same person you may say
 * "ji" when asking a favour, "machi" when joking and "da" the rest of the time, so the term is
 * learnt per moment, not per person.
 */
export type Moment = "sorry" | "thanks" | "ask" | "refuse" | "greet" | "bye" | "tease" | "excited" | "question" | "agree" | "inform";

export const MOMENTS: Moment[] = ["sorry", "thanks", "ask", "refuse", "greet", "bye", "tease", "excited", "question", "agree", "inform"];

export const MOMENT_LABEL: Record<Moment, string> = {
  sorry: "apologising",
  thanks: "thanking",
  ask: "asking a favour or for something",
  refuse: "saying no",
  greet: "greeting",
  bye: "signing off",
  tease: "joking or teasing",
  excited: "excited or praising",
  question: "asking a question",
  agree: "agreeing / ok",
  inform: "just telling something",
};

const CUES: [Moment, RegExp][] = [
  ["sorry", /\b(sorry+|sry|soryy|sorri|mannichu\w*|apologi[sz]e\w*|apologies|my bad)\b/],
  ["thanks", /\b(thanks?|thanku|thank you|thx|thnx|tnx|tq|ty|nandri)\b/],
  ["ask", /\b(pls|plz|plss|please|pleasee|kindly|can (you|u)|could (you|u)|will (you|u)|kudu\w*|kodu\w*|anupp?u\w*|send( me)?|help|venum|mudiyuma|konjam|favou?r|need)\b/],
  ["refuse", /\b(no+|nope|illa+|illai|mudiyathu|mudiyadhu|mudiyaathu|can'?t|cannot|venam|vendam|vendaam|not possible)\b/],
  ["greet", /^(hi+|hey+|hello+|hai|gm|good morning|vanakkam|yo)\b/],
  ["bye", /\b(bye+|gn|good night|tc|take care|cya|see (you|u)|apram pesalam|later pesalam)\b/],
  ["tease", /\b(lol+|ha(ha)+h?|he(he)+|lmao|loosu|mokka|kalaai\w*)\b|[\u{1F602}\u{1F923}\u{1F606}\u{1F61C}\u{1F61D}]/u],
  ["excited", /!+\s*$|!!|\b(super|semma|mass|vera level|wow+|congrats|congratulations|awesome|kalakk\w*)\b|[\u{1F525}\u{1F389}\u{1F60D}\u{2764}\u{1F64C}]/u],
  ["question", /\?|\b(enna|ena|epo|eppo|eppadi|epdi|enga|yaaru?|evlo|ethuku|edhuku|why|what|when|where|how|which)\b/],
  ["agree", /\b(ok+|okay|seri|sari|sure|done|yes+|yeah|yep|hm+|k+|fine|aama|aamaa)\b/],
];

/** What this message is doing; the first cue wins, in the order of `MOMENTS`. */
export function momentOf(text: string): Moment {
  const t = text.toLowerCase().trim();
  for (const [m, re] of CUES) if (re.test(t)) return m;
  return "inform";
}

/**
 * Every term of address and its spellings; the first word of each line is the term the others
 * count as ("daa" is "da", "macha" is "machi"). Tamil first, then family words, other Indian
 * languages and English. Words that are also ordinary words ("all", "love", "team") are left out.
 */
const TERMS = `
da daa daaa dhaa
di dii dee
dei dey deii deyy
machi macha machan machaa machii mchi machiii machha
mapla maplae mapillai maaple mapula
mama maama maams mams mamu
nanba nanbaa nanbane nanbare
nanbi nanbii
thala thalaiva thalaivaa thalaivare thalaivar
thalaivi
boss bossu bos
sami saami swamy swami
ayya aiyaa aiya ayyaa
kutty kutti kuttyma kuttima
chellam chellame chella
kanna kannu kannama kanne
thangam thangame
pa paa pah
ma maa mah
anna annaa annae anne annan
akka akkaa akkae
thambi thambii thambii thambiii
thangachi thangachii thangai
anni annii anniyaa
athan athaan atthan
athai atthai
appa appaa pappa
amma ammaa mummy mumma mom
chithi chitti
chithappa chittappa
periyappa periyamma
paati paatti aaya
thatha thaatha
uncle uncl
aunty aunti aunt
ji jii
bhai bhaai bhaiya bhaiyya bhaya bhayya
didi
bhabhi bhabi
yaar yar yaara
bhidu
sahab saab sahib saheb
ra raa
eda edaa
edi edee
mone monu
mole molu
chetta chettan chettaa
chechi chechii
maga magane
bava baava
mowa mawa
guru guruji
sir sirr sirji sirrr saar sar
madam mam maam ma'am mdm madm
bro broo brooo bruh bruv brah brotha brother
sis sissy sister
dude dood
buddy bud
man
mate
pal
chief
captain capt
champ
dear dearie
prof professor
`;

const FAMILY: Record<string, string> = Object.fromEntries(
  TERMS.trim()
    .split("\n")
    .flatMap((line) => {
      const [term, ...variants] = line.trim().split(/\s+/);
      return [term, ...variants].map((v) => [v, term]);
    }),
);

/**
 * Terms safe to correct in a draft. Family words (anna, akka, mama, appa…) also mean "brother",
 * "sister", "uncle" ("anna kitta kelu": ask your brother), and pa / ma are everyday endings, so a
 * draft using them is never rewritten.
 */
const REPLACEABLE = new Set(
  "da di dei machi mapla nanba nanbi thala thalaivi boss sami ayya ji bhai yaar bhidu sahab ra eda edi guru sir madam bro sis dude buddy mate pal chief champ dear".split(" "),
);

/**
 * Your own terms and nicknames (config `style.addressTerms`), one string per term with its
 * spellings: "chinna chinnu chinnaa". They are counted like the built-in ones; a draft is never
 * rewritten to remove them, only to use them where they are what you call that person.
 */
export function addTerms(lines: string[]) {
  for (const line of lines) {
    const [term, ...variants] = line.trim().toLowerCase().split(/\s+/);
    if (term) for (const v of [term, ...variants]) FAMILY[v] = term;
  }
}

const tokens = (s: string) => s.toLowerCase().match(/[\p{L}']+/gu) ?? [];

/** The terms you use in these messages (yours, from one chat), most used first. Rare ones are dropped. */
export function addressTerms(mine: string[]): AddressUse[] {
  const counts = new Map<string, number>();
  for (const m of mine) {
    const seen = new Set(tokens(m).map((t) => FAMILY[t]).filter(Boolean));
    for (const f of seen) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  const all = [...counts.entries()].map(([term, n]) => ({ term, n })).sort((a, b) => b.n - a.n);
  const top = all[0]?.n ?? 0;
  // Twice at least, and not a stray: a term used once for every twenty uses of the main one is noise.
  return all.filter((a) => a.n >= 2 && a.n * 20 >= top);
}

const bump = <K extends string>(o: Partial<Record<K, number>>, k: K) => (o[k] = (o[k] ?? 0) + 1);
const lines = (s: string) => s.split(/\n+/).map((l) => l.trim()).filter(Boolean);
const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export interface AddressStudy {
  terms: AddressUse[];
  /** Moments where you used no term at all: moment -> how many of your messages. */
  none: Partial<Record<Moment, number>>;
}

/**
 * When you use which term with this person: each of your messages is read for what it is doing
 * (`momentOf`) and which of the terms it carries; your replies are also read against what they
 * had just said. `terms` (the counted ones, `addressTerms`) are the only ones studied.
 */
export function studyAddress(mine: string[], pairs: { them: string; me: string }[], terms: AddressUse[] = addressTerms(mine)): AddressStudy {
  const known = new Set(terms.map((t) => t.term));
  const out = new Map(terms.map((t) => [t.term, { ...t, when: {} as Partial<Record<Moment, number>>, after: {} as Partial<Record<Moment, number>>, at: { start: 0, end: 0, alone: 0 }, examples: [] as string[] }]));
  const none: Partial<Record<Moment, number>> = {};
  const termsIn = (l: string) => tokens(l).map((t, i, all) => ({ f: FAMILY[t], i, last: all.length - 1 })).filter((x) => x.f && known.has(x.f));
  for (const m of mine.flatMap(lines)) {
    const found = termsIn(m);
    const moment = momentOf(m);
    if (!found.length) bump(none, moment);
    for (const f of new Set(found.map((x) => x.f))) {
      const u = out.get(f)!;
      bump(u.when, moment);
      const hits = found.filter((x) => x.f === f);
      if (hits[0].last === 0) u.at.alone++;
      else if (hits.some((x) => x.i === 0)) u.at.start++;
      else if (hits.some((x) => x.i === x.last)) u.at.end++;
    }
  }
  // Examples and what they had said: the shortest real exchanges, one per moment first.
  const seen = new Map<string, Set<Moment>>();
  const sorted = [...pairs].sort((a, b) => a.me.length - b.me.length);
  for (const pass of [0, 1]) {
    for (const p of sorted) {
      for (const l of lines(p.me)) {
        for (const f of new Set(termsIn(l).map((x) => x.f))) {
          const u = out.get(f)!;
          const moment = momentOf(l);
          const s = seen.get(f) ?? new Set();
          seen.set(f, s);
          if (pass === 0) bump(u.after, momentOf(lines(p.them).slice(-1)[0] ?? ""));
          const ex = `Them: ${clip(p.them.replace(/\n/g, " / "), 90)} → Me: ${clip(l, 90)}`;
          if (u.examples.length < 3 && !u.examples.includes(ex) && (pass === 1 || !s.has(moment))) {
            u.examples.push(ex);
            s.add(moment);
          }
        }
      }
    }
  }
  return { terms: [...out.values()], none };
}

const sum = (o: Partial<Record<string, number>> = {}) => Object.values(o).reduce((a: number, b) => a + (b ?? 0), 0);

/**
 * In this moment, which term you use: the term with most uses there when it clearly leads (three
 * uses at least and most of the term uses), else undefined (no clear habit; leave the draft alone).
 */
export function termFor(moment: Moment, terms: AddressUse[]): string | undefined {
  const ranked = terms.map((t) => ({ t: t.term, n: t.when?.[moment] ?? 0 })).sort((a, b) => b.n - a.n);
  const all = ranked.reduce((a, b) => a + b.n, 0);
  return ranked[0] && ranked[0].n >= 3 && ranked[0].n / all >= 0.6 ? ranked[0].t : undefined;
}

/**
 * Makes each term in a draft the one you use for what that line is doing: "can you send it machi"
 * becomes "…ji" when every favour you ask them carries "ji" and "machi" never does. Only terms
 * with a learnt moment profile are touched, and only when the habit is clear (`termFor`).
 */
export function fitAddress(text: string, terms: AddressUse[]): { text: string; fixed: string[] } {
  if (terms.length < 2 || !terms.some((t) => sum(t.when))) return { text, fixed: [] };
  const by = new Map(terms.map((t) => [t.term, t]));
  const fixed: string[] = [];
  const out = text
    .split("\n")
    .map((l) => {
      const want = termFor(momentOf(l), terms);
      if (!want) return l;
      return l.replace(/[\p{L}']+/gu, (word) => {
        const f = FAMILY[word.toLowerCase()];
        if (!f || f === want || !by.has(f) || !REPLACEABLE.has(f) || !REPLACEABLE.has(want)) return word;
        if ((by.get(f)!.when?.[momentOf(l)] ?? 0) > 0) return word; // you do use it here sometimes
        fixed.push(word);
        return matchCase(want, word);
      });
    })
    .join("\n");
  return { text: out, fixed };
}

const matchCase = (word: string, like: string) => (/^\p{Lu}/u.test(like) ? word[0].toUpperCase() + word.slice(1) : word);

/**
 * Replaces terms of address you don't use with this person by the one you use most.
 * `allowed` empty: you have no term for them, so a stray one is dropped rather than replaced.
 */
export function fixAddress(text: string, allowed: string[]): { text: string; fixed: string[] } {
  const ok = new Set(allowed.map((t) => FAMILY[t.toLowerCase()] ?? t.toLowerCase()));
  const main = allowed[0];
  const fixed: string[] = [];
  const out = text.replace(/[\p{L}']+/gu, (word) => {
    const f = FAMILY[word.toLowerCase()];
    if (!f || ok.has(f) || !REPLACEABLE.has(f)) return word;
    fixed.push(word);
    return main ? matchCase(main, word) : "\u0000";
  });
  // A dropped term leaves "\0": take it out with the space or comma before it.
  return { text: out.replace(/[ \t]*,?[ \t]*\u0000/g, "").replace(/^\u0000[ \t,]*/gm, "").trim(), fixed };
}
