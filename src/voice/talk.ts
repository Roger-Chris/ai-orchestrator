/**
 * Talking to Jarvis: what the phone hears goes to the brain's thinking loop (the same one as the
 * Assistant tab: memory, tasks, device actions, approvals), and the answer comes back twice, in
 * full for the screen and as `say`, a short plain version for the phone to speak.
 */

export interface AskReply {
  answer: string;
  steps?: { tool: string; args: Record<string, unknown>; result: string }[];
  pending?: { device: string; action: string; status: string }[];
}

export interface TalkReply extends AskReply {
  /** What the hub heard (your words, transcribed or typed). */
  heard: string;
  /** What the phone says out loud. */
  say: string;
}

/** Plain words for speech: no markdown, links, code, emoji or lists; at most `max` characters, cut at a sentence. */
export function spokenText(text: string, max = 320): string {
  let t = text
    .replace(/```[\s\S]*?```/g, " (the code is on screen) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "the link on screen")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "")
    .replace(/[*_~>|]/g, "")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/\.(\s*\.)+/g, ".")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  t = end > max / 3 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(" "))}…`;
  return `${t} The rest is on screen.`;
}

/** The spoken line, plus a nudge when something waits for your tap. */
export function sayFor(reply: AskReply): string {
  const waiting = (reply.pending ?? []).filter((p) => p.status === "waiting" || p.status === "pending" || p.status === "ask");
  const base = spokenText(reply.answer || "Done.");
  if (!waiting.length) return base;
  const what = waiting.length === 1 ? `${waiting[0].action} on ${waiting[0].device}` : `${waiting.length} actions`;
  return `${base} I need your OK for ${what}: tap Approve on the screen.`;
}
