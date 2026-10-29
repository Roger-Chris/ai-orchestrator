import { type MemoryRecord, type MemoryReplica, slug } from "../shared/replica.js";

/**
 * What the shared memory knows about the person (or group) a reply is for: who they are, facts and
 * decisions about them, how they connect to things, and what is still open with them. It goes into
 * the reply prompt as background, so "can you send it?" from Jayesh is answered knowing the patent
 * draft is due and that he prefers calls after 6.
 *
 * Matching is exact, never fuzzy: the chat id (the brain's graph stores it as an alias, slugged:
 * 919876543210@s.whatsapp.net -> 919876543210-s-whatsapp-net), then the name as a uid or an alias.
 * A wrong person is worse than none, so a name that only half-matches finds nothing.
 */

export interface Who {
  name: string;
  chatId: string;
  isGroup: boolean;
}

const OPEN = new Set(["open", "pending_confirmation", "watching"]);
const MAX_LINES = 12;

function aliasMatch(r: MemoryReplica, alias: string): MemoryRecord | undefined {
  if (!alias) return undefined;
  const row = r.db
    .prepare("SELECT uid FROM records WHERE deleted = 0 AND kind IN ('person', 'org') AND (',' || aliases || ',') LIKE ? LIMIT 1")
    .get(`%,${alias},%`) as { uid: string } | undefined;
  return row ? r.get(row.uid) : undefined;
}

/** The memory record for this chat's person or group, or undefined. Exact matches only. */
export function findPerson(r: MemoryReplica, who: Who): MemoryRecord | undefined {
  const kind = who.isGroup ? "org" : "person";
  const byId = aliasMatch(r, slug(who.chatId));
  if (byId) return byId;
  const name = who.name.trim();
  if (!name || /^\+?[\d\s-]+$/.test(name)) return undefined; // a bare number is not a name
  const byUid = r.get(`${kind}:${slug(name)}`);
  if (byUid && !byUid.deleted) return byUid;
  return aliasMatch(r, slug(name));
}

const short = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** Background lines for the reply prompt; empty when memory knows nothing about them. */
export function personKnowledge(r: MemoryReplica, who: Who): string[] {
  const rec = findPerson(r, who);
  const lines: string[] = [];
  if (rec) {
    lines.push(`${rec.title}${rec.body ? `: ${short(rec.body, 220)}` : ""}`);
    const about = r.about(rec.uid, 20);
    for (const l of about?.linked ?? []) {
      if (["fact", "decision", "note"].includes(l.kind)) lines.push(short(l.body || l.title, 200));
    }
    for (const rel of (about?.relations ?? []).slice(0, 4)) lines.push(short(rel.title, 160));
  }
  // Open tasks with them: the brain mirrors tasks with the people in `tags` (comma-separated names).
  const first = who.name.trim().split(/\s+/)[0]?.toLowerCase();
  const names = new Set([rec?.title.toLowerCase(), who.name.trim().toLowerCase()].filter(Boolean) as string[]);
  if (first && first.length >= 3 && !/^\+?\d/.test(first)) {
    const tasks = (r.db
      .prepare("SELECT uid FROM records WHERE deleted = 0 AND kind IN ('task', 'event') AND lower(tags) LIKE ? ORDER BY updated_at DESC LIMIT 20")
      .all(`%${first}%`) as { uid: string }[])
      .map((x) => r.get(x.uid)!)
      .filter((t) => t && OPEN.has(String(t.data.status ?? "")))
      // the tag must name this person exactly, not just share a first name substring
      .filter((t) => t.tags.toLowerCase().split(",").map((x) => x.trim()).some((x) => names.has(x) || x === first))
      .slice(0, 3);
    for (const t of tasks) {
      const due = t.data.due_at ? ` (due ${String(t.data.due_at).slice(0, 10)})` : "";
      lines.push(`Open ${t.kind === "event" ? "event" : "task"} with them: ${short(t.title, 140)}${due}`);
    }
  }
  return [...new Set(lines)].slice(0, MAX_LINES);
}
