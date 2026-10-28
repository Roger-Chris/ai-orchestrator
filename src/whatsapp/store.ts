import type { Store } from "../store/db.js";

/** One WhatsApp message as the orchestrator keeps it. `ts` is in seconds, like WhatsApp's own. */
export interface WaMessage {
  id: string;
  chatId: string;
  chatName?: string;
  senderId: string;
  senderName?: string;
  fromMe: boolean;
  isGroup: boolean;
  text: string;
  /** "audio" for voice notes, "image", "document", …; absent for plain text. */
  mediaType?: string;
  /** Where a downloaded voice note lives on this device. */
  mediaPath?: string;
  /** What a voice note says (local Whisper). */
  transcript?: string;
  /** The message this one replied to, a few words of it. */
  quoted?: string;
  ts: number;
}

export interface WaChat {
  id: string;
  name?: string;
  isGroup: boolean;
  messages: number;
  mine: number;
  last: number;
}

/** WhatsApp messages and chat names, in the orchestrator's own database. */
export class WaStore {
  constructor(private store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS wa_chats (id TEXT PRIMARY KEY, name TEXT, is_group INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS wa_messages (
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, sender_id TEXT NOT NULL, sender_name TEXT,
        from_me INTEGER NOT NULL, is_group INTEGER NOT NULL, text TEXT NOT NULL, media_type TEXT,
        media_path TEXT, transcript TEXT, quoted TEXT, ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS wa_messages_chat ON wa_messages(chat_id, ts);
    `);
  }

  /** Saves new messages; a message seen again keeps its transcript and fills in a media path it lacked. */
  save(messages: WaMessage[]): number {
    const insert = this.store.db.prepare(
      `INSERT INTO wa_messages (id, chat_id, sender_id, sender_name, from_me, is_group, text, media_type, media_path, transcript, quoted, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET media_path = COALESCE(wa_messages.media_path, excluded.media_path),
         transcript = COALESCE(wa_messages.transcript, excluded.transcript)`,
    );
    const known = this.store.db.prepare("SELECT 1 FROM wa_messages WHERE id = ?");
    let added = 0;
    for (const m of messages) {
      if (m.chatName) this.nameChat(m.chatId, m.chatName, m.isGroup);
      else this.store.db.prepare("INSERT OR IGNORE INTO wa_chats (id, is_group) VALUES (?, ?)").run(m.chatId, m.isGroup ? 1 : 0);
      if (!known.get(m.id)) added++;
      insert.run(
        m.id,
        m.chatId,
        m.senderId,
        m.senderName ?? null,
        m.fromMe ? 1 : 0,
        m.isGroup ? 1 : 0,
        m.text,
        m.mediaType ?? null,
        m.mediaPath ?? null,
        m.transcript ?? null,
        m.quoted ?? null,
        m.ts,
      );
    }
    return added;
  }

  nameChat(id: string, name: string, isGroup = id.endsWith("@g.us")) {
    this.store.db
      .prepare("INSERT INTO wa_chats (id, name, is_group) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name")
      .run(id, name, isGroup ? 1 : 0);
  }

  chatName(id: string): string | undefined {
    return (this.store.db.prepare("SELECT name FROM wa_chats WHERE id = ?").get(id) as { name?: string } | undefined)?.name ?? undefined;
  }

  /** Chats with at least one message, busiest (by your own messages) first. */
  chats(): WaChat[] {
    return (
      this.store.db
        .prepare(
          `SELECT c.id, c.name, c.is_group, COUNT(m.id) AS n, SUM(m.from_me) AS mine, MAX(m.ts) AS last
           FROM wa_chats c JOIN wa_messages m ON m.chat_id = c.id GROUP BY c.id ORDER BY mine DESC, last DESC`,
        )
        .all() as any[]
    ).map((r) => ({ id: r.id, name: r.name ?? undefined, isGroup: !!r.is_group, messages: Number(r.n), mine: Number(r.mine ?? 0), last: Number(r.last) }));
  }

  /** A chat's messages, oldest first: the latest `limit` of them. */
  messages(chatId: string, limit = 400): WaMessage[] {
    return (this.store.db.prepare("SELECT * FROM (SELECT * FROM wa_messages WHERE chat_id = ? ORDER BY ts DESC LIMIT ?) ORDER BY ts").all(chatId, limit) as any[]).map(row);
  }

  /** A random sample of your own messages across every chat, for the overall voice. */
  sampleMine(limit: number): WaMessage[] {
    return (this.store.db.prepare("SELECT * FROM wa_messages WHERE from_me = 1 AND (length(text) > 3 OR transcript IS NOT NULL) ORDER BY random() LIMIT ?").all(limit) as any[]).map(row);
  }

  /** Voice notes downloaded but not yet transcribed, newest first. */
  untranscribed(limit = 2000): WaMessage[] {
    return (this.store.db.prepare("SELECT * FROM wa_messages WHERE media_path IS NOT NULL AND transcript IS NULL ORDER BY ts DESC LIMIT ?").all(limit) as any[]).map(row);
  }

  setTranscript(id: string, text: string) {
    this.store.db.prepare("UPDATE wa_messages SET transcript = ? WHERE id = ?").run(text, id);
  }

  counts(): { messages: number; mine: number; chats: number; voice: number; transcribed: number } {
    const r = this.store.db
      .prepare(
        "SELECT COUNT(*) AS messages, SUM(from_me) AS mine, COUNT(DISTINCT chat_id) AS chats, SUM(media_type = 'audio') AS voice, SUM(transcript IS NOT NULL) AS transcribed FROM wa_messages",
      )
      .get() as any;
    return { messages: Number(r.messages), mine: Number(r.mine ?? 0), chats: Number(r.chats), voice: Number(r.voice ?? 0), transcribed: Number(r.transcribed ?? 0) };
  }
}

function row(r: any): WaMessage {
  return {
    id: r.id,
    chatId: r.chat_id,
    senderId: r.sender_id,
    senderName: r.sender_name ?? undefined,
    fromMe: !!r.from_me,
    isGroup: !!r.is_group,
    text: r.text,
    mediaType: r.media_type ?? undefined,
    mediaPath: r.media_path ?? undefined,
    transcript: r.transcript ?? undefined,
    quoted: r.quoted ?? undefined,
    ts: Number(r.ts),
  };
}

/** What a message says, voice notes included, as one line for a prompt. */
export function spoken(m: WaMessage): string {
  if (m.transcript) return `[voice note] ${m.transcript}`;
  if (m.mediaType === "audio") return "[voice note, not transcribed]";
  if (!m.mediaType) return m.text;
  return m.text ? `[${m.mediaType}] ${m.text}` : `[${m.mediaType}]`;
}
