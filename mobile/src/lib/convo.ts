import * as FileSystem from "expo-file-system/legacy";
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
 * The conversation, saved on this phone and shared by the Assistant tab and the Talk
 * screen, so you can start by voice and carry on typing (or the other way round).
 */
let log: Turn[] = [];
let nextId = 1;
const listeners = new Set<(t: Turn[]) => void>();

const FILE = `${FileSystem.documentDirectory}jarvis-chat.json`;
let saving: ReturnType<typeof setTimeout> | undefined;
function save() {
  clearTimeout(saving);
  saving = setTimeout(() => void FileSystem.writeAsStringAsync(FILE, JSON.stringify(log.slice(-40))).catch(() => {}), 500);
}

export const convo = {
  get: () => log,
  /** Brings back the chat from the last time the app was open; a missing or broken file is an empty chat. */
  async load() {
    try {
      const saved = JSON.parse(await FileSystem.readAsStringAsync(FILE)) as Turn[];
      nextId = Math.max(0, ...saved.map((t) => t.id)) + 1;
      convo.set(saved);
    } catch {
      /* nothing saved yet */
    }
  },
  set(t: Turn[]) {
    log = t;
    save();
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
