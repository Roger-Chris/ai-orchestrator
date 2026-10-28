import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProviderPool } from "../providers/registry.js";
import type { PushPayload } from "../server/push.js";
import type { Store } from "../store/db.js";
import type { ProviderId, ReplyDraft } from "../types.js";
import { fixAddress } from "./address.js";
import type { StyleBook } from "./learn.js";
import { buildPool, poolPrompt } from "./pool.js";
import { spoken, type WaMessage, type WaStore } from "./store.js";

/**
 * Drafts your WhatsApp replies on the hub. New messages arrive from the device that runs the
 * link (POST /api/whatsapp/messages); a short while after someone stops typing, the context pool
 * for that chat goes to one of your online models and the draft lands on the phone's Home screen.
 * Nothing is ever sent: you read the draft, change it if you like, and send it yourself.
 */

export interface DrafterOptions {
  dataDir: string;
  /** Wait this long after their last message before drafting, so a burst gets one reply. */
  delaySeconds: number;
  /** Draft for new messages by themselves; off means only when you ask. */
  auto: boolean;
  /** Also draft for group chats (off: only direct chats). */
  groups: boolean;
  provider: "auto" | ProviderId;
  node: string;
}

const ORDER: ProviderId[] = ["claude", "gemini", "codex", "groq"];

/** The model's answer as message text: no quotes, fences or "Me:" prefix. Undefined for SKIP. */
export function cleanDraft(text: string): string | undefined {
  let t = text.trim().replace(/^```\w*\n?|```$/g, "").trim();
  t = t.replace(/^(me|reply|draft)\s*:\s*/i, "").trim();
  if (/^["“][\s\S]*["”]$/.test(t) && !t.slice(1, -1).includes('"')) t = t.slice(1, -1).trim();
  return !t || /^skip\.?$/i.test(t) ? undefined : t;
}

const phoneOf = (chatId: string) => (chatId.endsWith("@s.whatsapp.net") ? chatId.split("@")[0] : undefined);

export class ReplyDrafter {
  private cached?: { mtime: number; book: StyleBook };
  private timers = new Map<string, NodeJS.Timeout>();
  private lastError?: string;

  constructor(
    private store: Store,
    private wa: WaStore,
    private pool: Pick<ProviderPool, "available" | "run">,
    private opts: DrafterOptions,
    private notify?: (p: PushPayload) => void,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS wa_drafts (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, incoming TEXT NOT NULL, text TEXT NOT NULL,
      provider TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL
    )`);
  }

  private get bookFile() {
    return join(this.opts.dataDir, "style", "stylebook.json");
  }

  /** The style book from `orc style push` (or a local `orc style learn`), reread when it changes. */
  book(): StyleBook | undefined {
    if (!existsSync(this.bookFile)) return undefined;
    const mtime = statSync(this.bookFile).mtimeMs;
    if (this.cached?.mtime !== mtime) this.cached = { mtime, book: JSON.parse(readFileSync(this.bookFile, "utf8")) };
    return this.cached.book;
  }

  saveBook(book: StyleBook) {
    mkdirSync(dirname(this.bookFile), { recursive: true });
    writeFileSync(this.bookFile, JSON.stringify(book));
  }

  status() {
    const b = this.book();
    return {
      book: b ? { builtAt: b.builtAt, contacts: b.contacts.length, voice: b.owner.voice?.summary } : undefined,
      messages: this.wa.counts().messages,
      auto: this.opts.auto,
      lastError: this.lastError,
    };
  }

  /** Saves messages from the link. Your own message in a chat retires its open drafts; theirs schedule one. */
  ingest(messages: WaMessage[], live = true): { saved: number; scheduled: number } {
    const saved = this.wa.save(messages);
    let scheduled = 0;
    if (!live) return { saved, scheduled };
    const now = Date.now() / 1000;
    for (const chatId of new Set(messages.map((m) => m.chatId))) {
      const last = messages.filter((m) => m.chatId === chatId).reduce((a, b) => (b.ts > a.ts ? b : a));
      clearTimeout(this.timers.get(chatId));
      if (last.fromMe) {
        this.retire(chatId, "sent");
        continue;
      }
      if (!this.opts.auto || now - last.ts > 3600 || !this.wanted(chatId, last.isGroup)) continue;
      const t = setTimeout(() => {
        this.timers.delete(chatId);
        void this.draft(chatId).catch((e) => (this.lastError = (e as Error).message));
      }, this.opts.delaySeconds * 1000);
      t.unref();
      this.timers.set(chatId, t);
      scheduled++;
    }
    return { saved, scheduled };
  }

  private wanted(chatId: string, isGroup: boolean): boolean {
    const book = this.book();
    return !!book && chatId !== book.owner.id && (!isGroup || this.opts.groups);
  }

  /** Writes a draft for a chat now; `ask` says what you want to say. Undefined when you would not reply. */
  async draft(chatId: string, ask?: string): Promise<ReplyDraft | undefined> {
    const book = this.book();
    if (!book) throw new Error("no style book on this hub yet: run `orc style learn` and `orc style push` on the laptop");
    const messages = this.wa.messages(chatId, 200);
    if (!messages.length) throw new Error("no messages from this chat on the hub yet");
    const isGroup = chatId.endsWith("@g.us");
    const p = buildPool(book, { chatId, name: this.wa.chatName(chatId), isGroup }, messages);
    if (!ask && !p.incoming.length) return undefined; // your message is the last one: nothing to answer
    const { system, prompt } = poolPrompt(p, ask);

    const ready = await this.pool.available();
    const order = this.opts.provider === "auto" ? ORDER.filter((id) => ready.includes(id)) : [this.opts.provider];
    if (!order.length) throw new Error("no online model is ready to draft (Claude, Gemini, ChatGPT or Groq)");
    let error = "";
    for (const provider of order) {
      const r = await this.pool.run(provider, { system, prompt, permission: "read", timeoutMs: 120_000 });
      this.store.recordUsage(provider, this.opts.node, r.ok, r.durationMs);
      if (!r.ok) {
        error = `${provider}: ${r.error ?? "failed"}`;
        continue;
      }
      const raw = cleanDraft(r.text);
      if (!raw) return undefined;
      // What you call them is not up to the model: a wrong term of address is swapped for yours.
      const text = isGroup ? raw : fixAddress(raw, p.address.map((a) => a.term)).text;
      if (!text) return undefined;
      this.retire(chatId, "replaced");
      const draft: ReplyDraft = {
        id: `${chatId.split("@")[0]}-${Date.now().toString(36)}`,
        chatId,
        name: p.name,
        isGroup,
        phone: phoneOf(chatId),
        incoming: (p.incoming.length ? p.incoming : p.recent.slice(-1)).map(spoken).join("\n").slice(0, 500),
        text,
        provider,
        createdAt: Date.now(),
      };
      this.store.db
        .prepare("INSERT INTO wa_drafts (id, chat_id, incoming, text, provider, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(draft.id, chatId, draft.incoming, text, provider, draft.createdAt);
      this.lastError = undefined;
      this.notify?.({ title: `Reply to ${p.name}`, body: text.slice(0, 200), url: "/", tag: `wa:${chatId}` });
      return draft;
    }
    throw new Error(`could not draft: ${error}`);
  }

  /** Open drafts, newest first. */
  drafts(limit = 20): ReplyDraft[] {
    const book = this.book();
    return (this.store.db.prepare("SELECT * FROM wa_drafts WHERE status = 'open' ORDER BY created_at DESC LIMIT ?").all(limit) as any[]).map((r) => ({
      id: r.id,
      chatId: r.chat_id,
      name: [this.wa.chatName(r.chat_id), book?.contacts.find((c) => c.chatId === r.chat_id)?.name].find((n) => n && !n.startsWith("+")) ?? `+${r.chat_id.split("@")[0]}`,
      isGroup: r.chat_id.endsWith("@g.us"),
      phone: phoneOf(r.chat_id),
      incoming: r.incoming,
      text: r.text,
      provider: r.provider,
      createdAt: r.created_at,
    }));
  }

  /** "sent": you used it; "dismissed": you didn't want it. */
  close(id: string, status: "sent" | "dismissed"): boolean {
    return this.store.db.prepare("UPDATE wa_drafts SET status = ? WHERE id = ? AND status = 'open'").run(status, id).changes > 0;
  }

  private retire(chatId: string, status: string) {
    this.store.db.prepare("UPDATE wa_drafts SET status = ? WHERE chat_id = ? AND status = 'open'").run(status, chatId);
  }

  stop() {
    for (const t of this.timers.values()) clearTimeout(t);
  }
}
