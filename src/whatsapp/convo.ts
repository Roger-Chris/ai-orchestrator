import type { QuietChat } from "../types.js";
import type { WaMessage } from "./store.js";

/**
 * Where a conversation stands, from its last messages alone (no model):
 * - "open": they said something that wants an answer;
 * - "winding_down": they are signing off ("ok da gn", "seri bye"), so a short closing reply fits;
 * - "ended": they only acknowledged what you said ("ok", "seri", 👍, a sticker): nothing to answer;
 * - "waiting": you had the last word, recently;
 * - "died_out": you had the last word and nothing came back for `quietHours`.
 */
export type ConvoState = "open" | "winding_down" | "ended" | "waiting" | "died_out";

/** Words people end or acknowledge with, Tanglish and English. */
const CLOSERS = new Set(
  `ok okk okkk okay okey k kk kkk seri sari serri sariii haan haa ha hmm hmmm hm mm ya yaa yeah yes yep yup s fine done
  thanks thank thanku thankyou thx tq tqs ty welcome np noted sure cool nice super semma
  gn goodnight night nite bye byee bie tc take care see cya later ttyl sleep sleeping good`.split(/\s+/),
);
/** Words that sign off rather than just agree. */
const SIGN_OFF = new Set("gn goodnight night nite bye byee bie tc take care see cya later ttyl sleep sleeping".split(" "));
/** Terms of address ride along ("ok da", "seri bro") without changing what the message is. */
const FILLER = new Set("da daa di dei bro machi macha mapla sir madam mam ji bhai pa ma anna akka thambi dear".split(" "));

const words = (s: string) => s.toLowerCase().match(/[\p{L}']+/gu) ?? [];
const onlyEmoji = (s: string) => /\p{Extended_Pictographic}/u.test(s) && !/[\p{L}\p{N}]/u.test(s);

/** What one message is: an acknowledgement, a sign-off, or something to answer. */
export function messageKind(m: WaMessage): "ack" | "sign_off" | "content" {
  if (m.mediaType === "sticker") return "ack";
  const text = (m.transcript ?? m.text).trim();
  // Photos, documents, voice notes and the like want an answer (a voice note counts by what it says).
  if (m.mediaType && !(m.mediaType === "audio" && m.transcript)) return "content";
  if (!text) return "content";
  if (onlyEmoji(text)) return "ack";
  if (text.includes("?")) return "content";
  const w = words(text).filter((x) => !FILLER.has(x));
  if (!w.length) return "ack"; // just "da" or "bro"
  if (w.length > 6 || !w.every((x) => CLOSERS.has(x))) return "content";
  return w.some((x) => SIGN_OFF.has(x)) ? "sign_off" : "ack";
}

/**
 * Direct chats that went quiet after your message: older than `quietHours`, newer than
 * `withinDays`, and not let go (`letGo`) since. Busiest-first is not useful here; newest first is.
 */
export function quietChats(
  db: { prepare: (sql: string) => { all: (...a: any[]) => unknown[]; run: (...a: any[]) => unknown } },
  nameOf: (chatId: string) => string,
  o: { now?: number; quietHours?: number; withinDays?: number } = {},
): QuietChat[] {
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  db.prepare("CREATE TABLE IF NOT EXISTS wa_quiet_let_go (chat_id TEXT PRIMARY KEY, ts INTEGER NOT NULL)").run();
  const rows = db
    .prepare(
      `SELECT m.chat_id, m.text, m.ts FROM wa_messages m
       JOIN (SELECT chat_id, MAX(ts) AS ts FROM wa_messages WHERE is_group = 0 GROUP BY chat_id) l ON l.chat_id = m.chat_id AND l.ts = m.ts
       LEFT JOIN wa_quiet_let_go g ON g.chat_id = m.chat_id AND g.ts >= m.ts
       WHERE m.from_me = 1 AND m.ts < ? AND m.ts > ? AND g.chat_id IS NULL AND m.chat_id NOT LIKE '%@newsletter'
       ORDER BY m.ts DESC LIMIT 10`,
    )
    .all(now - (o.quietHours ?? 12) * 3600, now - (o.withinDays ?? 3) * 86400) as { chat_id: string; text: string; ts: number }[];
  return rows.map((r) => ({ chatId: r.chat_id, name: nameOf(r.chat_id), last: (r.text || "[media]").replace(/\s+/g, " ").slice(0, 80), since: Number(r.ts) * 1000 }));
}

/** Hides a quiet chat until its next message (it remembers the last message, not the time you tapped). */
export function letGo(db: { prepare: (sql: string) => { run: (...a: any[]) => unknown } }, chatId: string) {
  db.prepare("CREATE TABLE IF NOT EXISTS wa_quiet_let_go (chat_id TEXT PRIMARY KEY, ts INTEGER NOT NULL)").run();
  db.prepare("INSERT OR REPLACE INTO wa_quiet_let_go (chat_id, ts) SELECT chat_id, MAX(ts) FROM wa_messages WHERE chat_id = ? GROUP BY chat_id").run(chatId);
}

export function convoState(recent: WaMessage[], o: { now?: number; quietHours?: number } = {}): { state: ConvoState; since?: number } {
  const last = recent[recent.length - 1];
  if (!last) return { state: "waiting" };
  const now = o.now ?? Date.now() / 1000;
  if (last.fromMe) return { state: now - last.ts > (o.quietHours ?? 12) * 3600 ? "died_out" : "waiting", since: last.ts };
  // Their messages since your last one decide.
  const run: WaMessage[] = [];
  for (let i = recent.length - 1; i >= 0 && !recent[i].fromMe; i--) run.unshift(recent[i]);
  const kinds = run.map(messageKind);
  if (kinds.includes("content")) return { state: "open", since: last.ts };
  if (kinds.includes("sign_off")) return { state: "winding_down", since: last.ts };
  // Only "ok" / 👍: the end of the conversation, if it answered something you said.
  return { state: run.length < recent.length ? "ended" : "open", since: last.ts };
}
