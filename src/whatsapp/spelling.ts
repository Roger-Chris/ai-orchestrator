/**
 * Your spelling, shortcuts and habits, taken as they are: "okk" not "ok", "bcoz" not "because",
 * no capital letters or full stops if you don't use them. A draft is meant to read like you
 * typed it, mistakes included, so the model's tidy English is undone here after it writes.
 */

/** Words with several common spellings, one group per line. */
const GROUPS = `
ok okay okk okkk k kk okey okie oki okayy
please pls plz plss plzz pleasee
because bcoz bcz coz cuz cos becoz bcos
thanks thank thanku thankyou thx tnx tq thanq tnq tqs thanx
you u yu
your ur yr
are r
tomorrow tmrw tmr tmrrw tomo tommorow tomorow tmrow
today tdy 2day
message msg
messages msgs
sorry sry sorryy sori
good gud
night nyt nite
morning mrng mng morng
really rly realy
yes yeah ya yaa yea yep yess yup
what wat wht wt
where wer whr
know knw kno
don't dont dnt
can't cant
i'm im
going goin
something smthng sumthing
people ppl
wait w8 waitt
enna ena
eppadi epdi epudi eppudi
ippo ipo
illa ila ilaa illaa
nalla nala nalaa
irukku iruku irukuu irukkuu
sollu solu
konjam konjo konjum
evlo evalo evlov
`;

const GROUP_OF = new Map<string, string[]>();
for (const line of GROUPS.trim().split("\n")) {
  const variants = line.trim().split(/\s+/);
  for (const v of variants) GROUP_OF.set(v, variants);
}

const tokens = (s: string) => s.match(/[\p{L}\p{N}']+/gu) ?? [];

/**
 * For each word you spell one way most of the time (at least 3 uses, half of them), the spellings
 * you hardly ever use map to yours: { okay: "okk", because: "bcoz" }.
 */
export function spellingMap(mine: string[]): Record<string, string> {
  const counts = new Map<string, number>();
  for (const m of mine) for (const t of tokens(m.toLowerCase())) if (GROUP_OF.has(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  const map: Record<string, string> = {};
  for (const group of new Set(GROUP_OF.values())) {
    const used = group.map((v) => ({ v, n: counts.get(v) ?? 0 })).sort((a, b) => b.n - a.n);
    const total = used.reduce((s, u) => s + u.n, 0);
    if (total < 3 || used[0].n / total < 0.5) continue;
    // Only spellings you (almost) never use are changed: if you write both "ok" and "okk", both stay.
    for (const u of used) if (u.v !== used[0].v && u.n / total < 0.15) map[u.v] = used[0].v;
  }
  return map;
}

/** Your most used words in these messages, spelt your way. */
export function topWords(mine: string[], n = 40): string[] {
  const counts = new Map<string, number>();
  for (const m of mine) for (const t of tokens(m.toLowerCase())) if (t.length > 1 && !/^\d+$/.test(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}

/** Short messages you send again and again ("okk da", "seri bro"), exactly as you type them. */
export function stockMessages(mine: string[], n = 15): string[] {
  const counts = new Map<string, { text: string; n: number }>();
  for (const m of mine) {
    const t = m.trim();
    if (!/\p{L}/u.test(t) || t.split(/\s+/).length > 6 || t.length > 40) continue;
    const key = t.toLowerCase().replace(/[.!?]+$/, "");
    const e = counts.get(key) ?? { text: t, n: 0 };
    e.n++;
    counts.set(key, e);
  }
  return [...counts.values()]
    .filter((e) => e.n >= 2)
    .sort((a, b) => b.n - a.n)
    .slice(0, n)
    .map((e) => e.text);
}

export interface Habits {
  spelling: Record<string, string>;
  /** Share of your messages that start lowercase / end with a full stop. */
  lowercaseStart: number;
  fullStops: number;
}

/**
 * Rewrites a draft into your habits: your spellings, a lowercase start and no closing full stop
 * when that is how you write. The words themselves stay as written.
 */
export function mimic(text: string, h: Habits): string {
  const spelt = text.replace(/[\p{L}\p{N}']+/gu, (w) => {
    const mine = h.spelling[w.toLowerCase()];
    if (!mine) return w;
    return /^\p{Lu}/u.test(w) && h.lowercaseStart < 0.5 ? mine[0].toUpperCase() + mine.slice(1) : mine;
  });
  return spelt
    .split("\n")
    .map((line) => {
      let l = line;
      if (h.lowercaseStart >= 0.7) l = l.replace(/^(\s*)(\p{Lu})(?!\p{Lu})/u, (_, sp: string, c: string) => sp + c.toLowerCase());
      if (h.fullStops <= 0.1) l = l.replace(/([^.])\.\s*$/, "$1");
      return l;
    })
    .join("\n");
}
