/**
 * Terms of address (sir, ji, bro, machi, da, di…): what you call each person is fixed per chat,
 * so it is counted from your own messages, never guessed by a model, and every draft is checked
 * against it. A reply that calls your professor "da" or your friend "sir" is worse than no reply.
 */

export interface AddressUse {
  term: string;
  /** How many of your messages in the chat use it. */
  n: number;
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
