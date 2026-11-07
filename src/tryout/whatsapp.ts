import { existsSync } from "node:fs";
import { basename } from "node:path";
import { PROJECT_FILE } from "../whatsapp/link.js";

/**
 * "Kishanujith sent me a zip on WhatsApp, run it": the newest archive that person sent, from the
 * messages the hub's WhatsApp link keeps (wa_messages). Names come from speech, so they are matched
 * loosely, but only against people who sent files, and two close matches are asked about, never guessed.
 */

export interface SentFile {
  path: string;
  file: string;
  person: string;
  /** Unix seconds. */
  at: number;
}

export class SentFileError extends Error {
  constructor(
    message: string,
    public status: 404 | 409,
  ) {
    super(message);
  }
}

interface Row {
  chat_id: string;
  is_group: number;
  sender_name: string | null;
  chat_name: string | null;
  text: string;
  media_path: string | null;
  ts: number;
}

const compact = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

/** Optimal string alignment distance: edits, with two swapped letters counting as one. */
export function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

/** How well a spoken name fits a saved one, 0 to 1: the whole name, or its first word ("Jitho" for "Jitho san"). */
export function nameScore(said: string, saved: string): number {
  const a = compact(said);
  if (!a) return 0;
  const options = [saved, saved.split(/\s+/)[0]].map(compact).filter(Boolean);
  return Math.max(0, ...options.map((b) => (b === a ? 1 : 1 - editDistance(a, b) / Math.max(a.length, b.length))));
}

const MIN_SCORE = 0.75;

export function findSentFile(db: { prepare(sql: string): { all(...args: unknown[]): unknown[] } }, who: string): SentFile {
  const rows = db
    .prepare(
      `SELECT m.chat_id, m.is_group, m.sender_name, c.name AS chat_name, m.text, m.media_path, m.ts
       FROM wa_messages m LEFT JOIN wa_chats c ON c.id = m.chat_id
       WHERE m.media_type = 'document' AND m.from_me = 0 ORDER BY m.ts DESC LIMIT 5000`,
    )
    .all() as Row[];
  const person = (r: Row) => (r.is_group ? r.sender_name : (r.chat_name ?? r.sender_name)) ?? "";
  const scores = new Map<string, number>();
  for (const r of rows) {
    const p = person(r);
    if (p && !scores.has(p)) scores.set(p, nameScore(who, p));
  }
  const ranked = [...scores].filter(([, s]) => s >= MIN_SCORE).sort((x, y) => y[1] - x[1]);
  if (!ranked.length) throw new SentFileError(`No file from anyone called "${who}" on WhatsApp.`, 404);
  const [best, top] = ranked[0];
  const close = ranked.filter(([p, s]) => p !== best && compact(p) !== compact(best) && top - s < 0.05);
  if (close.length) throw new SentFileError(`"${who}" could be ${[best, ...close.map(([p]) => p)].join(" or ")}: say which.`, 409);

  const theirs = rows.filter((r) => compact(person(r)) === compact(best));
  const fileOf = (r: Row) => (r.media_path ? basename(r.media_path).replace(/^[\w]+?-/, "") : r.text);
  const archives = theirs.filter((r) => PROJECT_FILE.test(fileOf(r)) || PROJECT_FILE.test(r.text));
  const pick = archives[0] ?? theirs[0];
  if (pick.media_path && existsSync(pick.media_path)) return { path: pick.media_path, file: fileOf(pick), person: best, at: pick.ts };
  const when = new Date(pick.ts * 1000).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  throw new SentFileError(
    `${best} sent "${pick.text || "a file"}" on ${when}, but the hub doesn't have the file: it came before the hub kept WhatsApp files, or WhatsApp would not give it. Ask ${best} to send it again, or upload it in the app (More → Try a project).`,
    409,
  );
}
