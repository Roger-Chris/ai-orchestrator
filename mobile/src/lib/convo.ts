import type { AssistantReply } from "./api";

/** One exchange with the assistant, typed or spoken. */
export interface Turn {
  id: number;
  you: string;
  spoken?: boolean;
  reply?: AssistantReply;
  error?: string;
}

/**
 * The conversation, kept for the whole app session and shared by the Assistant tab and the Talk
 * screen, so you can start by voice and carry on typing (or the other way round).
 */
let log: Turn[] = [];
let nextId = 1;
const listeners = new Set<(t: Turn[]) => void>();

export const convo = {
  get: () => log,
  set(t: Turn[]) {
    log = t;
    for (const l of listeners) l(log);
  },
  add(you: string, spoken = false): Turn {
    const turn: Turn = { id: nextId++, you, spoken };
    convo.set([...log, turn]);
    return turn;
  },
  touch: () => convo.set([...log]),
  clear: () => convo.set([]),
  subscribe(l: (t: Turn[]) => void) {
    listeners.add(l);
    return () => void listeners.delete(l);
  },
  /** The last three exchanges, so "open it" or "and the other one?" work. */
  history: () =>
    log
      .filter((t) => t.reply)
      .slice(-3)
      .flatMap((t) => [
        { role: "user" as const, content: t.you },
        { role: "assistant" as const, content: t.reply!.answer },
      ]),
};
