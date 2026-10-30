import type { PersonSummary } from "../types.js";
import type { StyleBook } from "./learn.js";

/**
 * The people in the style book for the app's People screen: each direct chat's card (relationship,
 * what you call them, tone…) and how much you talk, busiest first. No message text or reply
 * examples leave the hub this way.
 */
export function people(book: StyleBook): PersonSummary[] {
  return book.contacts
    .filter((c) => !c.isGroup)
    .map((c) => ({
      chatId: c.chatId,
      name: c.name,
      relationship: c.card?.relationship ?? "",
      addressAs: c.card?.addressAs ?? [],
      theyCallMe: c.card?.theyCallMe ?? [],
      language: c.card?.language ?? "",
      tone: c.card?.tone ?? "",
      formality: c.card?.formality,
      topics: c.card?.topics ?? [],
      notes: c.card?.notes ?? "",
      mine: c.stats.mine,
      theirs: c.stats.theirs,
      lastTs: c.lastTs,
    }))
    .sort((a, b) => b.mine + b.theirs - (a.mine + a.theirs));
}
