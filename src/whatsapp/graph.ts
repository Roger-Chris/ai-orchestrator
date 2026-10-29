import type { ContactStyle, StyleBook } from "./learn.js";

/**
 * Your people as a graph for Graphify (`orc style graph`): one node per person and group with
 * everything the replies are written from (what you call them, how often you talk, tone,
 * formality, language, phrases…), linked to you, to the term you address them by, to the kind
 * of relationship and to the groups you share. Graphify clusters and draws it (graph.html), so
 * you can check every person before their profile is used to write messages.
 */

export interface Activity {
  first: number;
  last: number;
  /** All stored messages in the chat, and yours among them (the profile studies only the latest 400). */
  total: number;
  mine: number;
  /** Messages in the last 30 days, both sides. */
  last30: number;
}

interface Node {
  id: string;
  label: string;
  file_type: string;
  source_file: string;
  [key: string]: unknown;
}

interface Link {
  source: string;
  target: string;
  relation: string;
  confidence: "EXTRACTED";
  confidence_score: number;
  weight: number;
  source_file: string;
}

const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

/** "daily", "weekly", "monthly" or "rarely", from messages per week over the chat's life. */
export function frequency(total: number, a?: Activity): string {
  if (!a || a.last <= a.first) return "rarely";
  const weeks = Math.max(1, (a.last - a.first) / (7 * 86400));
  const perWeek = total / weeks;
  return perWeek >= 20 ? "daily" : perWeek >= 4 ? "weekly" : perWeek >= 1 ? "monthly" : "rarely";
}

/** Everything about one person, as plain lines (Graphify shows node details as text). */
export function describe(c: ContactStyle, a?: Activity): string[] {
  const s = c.stats;
  const card = c.card;
  const lines = [
    `${c.isGroup ? "Group" : "Person"}: ${c.name}`,
    card?.relationship && `Relationship: ${card.relationship}`,
    !c.isGroup && `I call them: ${s.address?.length ? s.address.map((t) => `${t.term} (${t.n}×)`).join(", ") : "nothing in particular"}`,
    card?.theyCallMe.length && `They call me: ${card.theyCallMe.join(", ")}`,
    a
      ? `Messages: ${a.total} (${a.mine} mine), ${frequency(a.total, a)}; ${a.last30} in the last 30 days; ${day(a.first)} to ${day(a.last)}`
      : `Messages: ${s.mine + s.theirs} studied (${s.mine} mine)`,
    card && `Tone: ${card.tone}; formality ${card.formality}/5; ${card.length}`,
    card?.language && `Language: ${card.language}`,
    `My messages: ~${s.avgWords} words, ${Math.round(s.shortShare * 100)}% four words or fewer, ${s.burst} in a row, ${Math.round(s.lowercaseStart * 100)}% start lowercase, ${Math.round(s.tamilScript * 100)}% Tamil script`,
    `Emoji: ${s.emojiPerMessage < 0.05 ? "almost none" : `${s.emojiPerMessage} per message ${s.topEmoji.join(" ")}`}`,
    s.replyMinutes !== undefined && `I usually reply in ~${s.replyMinutes} min`,
    card?.phrases.length && `My phrases here: ${card.phrases.join(", ")}`,
    s.stock?.length && `Messages I send again and again: ${s.stock.slice(0, 6).map((t) => `"${t}"`).join(", ")}`,
    card?.topics.length && `We talk about: ${card.topics.join(", ")}`,
    card?.avoid.length && `I never: ${card.avoid.join("; ")}`,
    card?.notes && `Notes: ${card.notes}`,
  ];
  return lines.filter((l): l is string => typeof l === "string" && !!l);
}

const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "");

/** The graph in Graphify's node-link format (what `graphify cluster-only` reads). */
export function peopleGraph(book: StyleBook, activity: (chatId: string) => Activity | undefined) {
  const nodes = new Map<string, Node>();
  const links: Link[] = [];
  const add = (n: Node) => nodes.set(n.id, { ...nodes.get(n.id), ...n });
  const link = (source: string, target: string, relation: string, weight = 1) =>
    links.push({ source, target, relation, confidence: "EXTRACTED", confidence_score: 1, weight, source_file: `${relation.replace(/_/g, " ")} (${weight})` });

  const v = book.owner.voice;
  add({ id: "me", label: "Me", file_type: "person", source_file: v ? `My voice: ${v.summary}` : "Me", kind: "me", details: v ? [v.summary, v.languages, ...v.habits] : [] });

  for (const c of book.contacts) {
    const a = activity(c.chatId);
    const details = describe(c, a);
    const term = c.stats.address?.[0]?.term;
    add({
      id: c.chatId,
      label: c.isGroup ? c.name : term ? `${c.name} · ${term}` : c.name,
      file_type: c.isGroup ? "group" : "person",
      // Graphify's panel shows the source; here it is the person's whole profile.
      source_file: details.join(" | "),
      kind: c.isGroup ? "group" : "person",
      details,
      messages: a?.total ?? c.stats.mine + c.stats.theirs,
      frequency: frequency(a?.total ?? c.stats.mine + c.stats.theirs, a),
      relationship: c.card?.relationship ?? "",
      address: (c.stats.address ?? []).map((t) => t.term),
      formality: c.card?.formality ?? 0,
      tone: c.card?.tone ?? "",
    });
    link("me", c.chatId, c.isGroup ? "member_of" : "chats_with", Math.max(1, Math.round(Math.log2(1 + (a?.total ?? c.stats.mine + c.stats.theirs)))));

    if (!c.isGroup) {
      for (const t of c.stats.address ?? []) {
        const id = `address:${t.term}`;
        add({ id, label: `"${t.term}"`, file_type: "address", source_file: `What I call people: ${t.term}`, kind: "address" });
        link(c.chatId, id, "addressed_as", t.n);
      }
    }
    if (c.card?.relationship) {
      const id = `relationship:${slug(c.card.relationship)}`;
      add({ id, label: c.card.relationship, file_type: "relationship", source_file: `Relationship: ${c.card.relationship}`, kind: "relationship" });
      link(c.chatId, id, "is_my");
    }
  }
  for (const e of book.graph.edges) if (e.kind === "member" && nodes.has(e.from) && nodes.has(e.to)) link(e.from, e.to, "in_group");

  return { directed: false, multigraph: false, graph: { name: "WhatsApp people" }, nodes: [...nodes.values()], links, hyperedges: [] };
}
