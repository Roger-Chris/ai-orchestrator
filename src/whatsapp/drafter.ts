import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelRouter } from "../ai/route.js";
import type { ProviderPool } from "../providers/registry.js";
import type { PushPayload } from "../server/push.js";
import type { Store } from "../store/db.js";
import type { ProviderId, ReplyDraft, ReplyOption } from "../types.js";
import { fitAddress, fixAddress } from "./address.js";
import type { StyleBook } from "./learn.js";
import { parseJson } from "./local.js";
import { buildPool, type ContextPool, poolPrompt } from "./pool.js";
import { mimic } from "./spelling.js";
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
  /** What the shared memory knows about the person a reply is for (knowledge.ts); none when absent. */
  knowledge?: (who: { name: string; chatId: string; isGroup: boolean }) => string[];
  /** The model router (R2): picks the model and falls back. Without it, the fixed ORDER below. */
  router?: ModelRouter;
}

/** Gemini last: its free tier is often busy; ChatGPT (codex) and Groq answer first. */
const ORDER: ProviderId[] = ["claude", "codex", "groq", "gemini"];

/** The model's answer as message text: no quotes, fences or "Me:" prefix. Undefined for SKIP. */
export function cleanDraft(text: string): string | undefined {
  let t = text.trim().replace(/^```\w*\n?|```$/g, "").trim();
  t = t.replace(/^(me|reply|draft)\s*:\s*/i, "").trim();
  if (/^["“][\s\S]*["”]$/.test(t) && !t.slice(1, -1).includes('"')) t = t.slice(1, -1).trim();
  return !t || /^skip\.?$/i.test(t) ? undefined : t;
}

/**
 * The model's options, each made to sound like you: your term of address for them (direct chats)
 * and your spellings, casing and full stops. A plain-text answer becomes a single option.
 */
export function replyOptions(answer: string, p: ContextPool): ReplyOption[] {
  const parsed = parseJson<{ options?: unknown }>(answer);
  const raw: { label: string; text: string }[] = Array.isArray(parsed?.options)
    ? parsed.options.filter((o: any) => typeof o?.text === "string").map((o: any) => ({ label: typeof o.label === "string" && o.label.trim() ? o.label.trim().slice(0, 24) : "Reply", text: o.text }))
    : parsed
      ? [] // valid JSON with no options: nothing worth sending
      : [{ label: "Reply", text: answer }];
  const habits = { spelling: p.spelling, lowercaseStart: p.stats?.lowercaseStart ?? 0.5, fullStops: p.stats?.fullStops ?? 0.5 };
  const out: ReplyOption[] = [];
  for (const o of raw) {
    const clean = cleanDraft(o.text);
    if (!clean) continue;
    const text = mimic(p.isGroup ? clean : fitAddress(fixAddress(clean, p.address.map((a) => a.term)).text, p.address).text, habits);
    if (text && !out.some((x) => x.text === text)) out.push({ label: o.label, text });
  }
  return out.slice(0, 4);
}

const phoneOf = (chatId: string) => (chatId.endsWith("@s.whatsapp.net") ? chatId.split("@")[0] : undefined);

/** How long after a phone's last suggestion request the hub leaves WhatsApp notifications to it. */
const PHONE_HANDLES_MS = 24 * 3600_000;

/** Who wrote, what they said, and what you might answer: the notification for a new draft. */
export function draftNotice(name: string, incoming: string, options: ReplyOption[]): PushPayload & { tag: string } {
  const answer = options.length > 1 ? options.map((o) => `${o.label}: ${o.text}`).join(" / ") : (options[0]?.text ?? "");
  const said = incoming.replace(/\s+/g, " ").trim();
  return { title: `WhatsApp · ${name}`, body: `They: ${said.slice(0, 120)}\nYou: ${answer}`.slice(0, 240), url: "/", tag: `wa:${name}` };
}

/** Without a style book: the conversation so far, and a plain instruction to answer the last message. */
export function plainPrompt(name: string, messages: WaMessage[]): { system: string; prompt: string } {
  const lines = messages.slice(-12).map((m) => `${m.fromMe ? "Me" : name}: ${spoken(m)}`);
  return {
    system: "You write WhatsApp replies for the phone's owner, as the owner. One short message in the language and tone of the chat. No quotes, no explanations. If no reply is needed, answer SKIP.",
    prompt: `Chat with ${name}:\n${lines.join("\n")}\n\nWrite my reply to the last message.`,
  };
}

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
    // Drafts made before options existed have none; their text is the one option.
    if (!(store.db.prepare("PRAGMA table_info(wa_drafts)").all() as { name: string }[]).some((c) => c.name === "options")) {
      store.db.exec("ALTER TABLE wa_drafts ADD COLUMN options TEXT");
    }
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
    const who = { chatId, name: this.wa.chatName(chatId) ?? "", isGroup };
    const p = buildPool(book, { ...who, name: who.name || undefined }, messages, { knowledge: this.know({ ...who, name: who.name || (book.contacts.find((c) => c.chatId === chatId)?.name ?? "") }) });
    // Nothing to answer: your message is the last one, or they only acknowledged it ("ok", 👍).
    if (!ask && (!p.incoming.length || p.state === "ended")) return undefined;
    const { system, prompt } = poolPrompt(p, ask);
    const { provider, text: answer } = await this.generate(system, prompt);
    const options = replyOptions(answer, p);
    if (!options.length) return undefined;
    const text = options[0].text;
    this.retire(chatId, "replaced");
    const draft: ReplyDraft = {
      id: `${chatId.split("@")[0]}-${Date.now().toString(36)}`,
      chatId,
      name: p.name,
      isGroup,
      phone: phoneOf(chatId),
      incoming: (p.incoming.length ? p.incoming : p.recent.slice(-1)).map(spoken).join("\n").slice(0, 500),
      text,
      options,
      provider,
      createdAt: Date.now(),
    };
    this.store.db
      .prepare("INSERT INTO wa_drafts (id, chat_id, incoming, text, options, provider, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(draft.id, chatId, draft.incoming, text, JSON.stringify(options), provider, draft.createdAt);
    this.lastError = undefined;
    // A phone that reads WhatsApp's own notifications shows its own, clearer one (with Send); don't double up.
    if (Date.now() - this.phoneAt > PHONE_HANDLES_MS) this.notify?.(draftNotice(p.name, draft.incoming, options));
    return draft;
  }

  /** When a phone last asked for a suggestion (`suggest`): it then shows WhatsApp replies itself. */
  private phoneAt = 0;

  /**
   * A reply for a WhatsApp message the phone saw in WhatsApp's own notification. The phone knows the
   * person by the name your contacts give them; it is matched exactly (never fuzzily) to a chat here
   * for its history and style card, else the reply is written from your voice alone. Nothing is
   * stored or sent: the phone shows the options, and WhatsApp itself sends the one you pick.
   */
  async suggest(name: string, text: string, isGroup = false): Promise<{ provider: ProviderId; options: ReplyOption[]; known: boolean }> {
    this.phoneAt = Date.now();
    const key = name.trim().toLowerCase();
    const book = this.book();
    const same = (n?: string) => n?.trim().toLowerCase() === key;
    // A chat this hub has seen under that name, or a contact the style book knows by it.
    const chat =
      this.wa.chats().find((c) => same(c.name) && c.isGroup === isGroup) ??
      book?.contacts.filter((c) => same(c.name) && c.isGroup === isGroup).map((c) => ({ id: c.chatId, name: c.name }))[0];
    const chatId = chat?.id ?? `phone:${name.trim()}`;
    const history = chat ? this.wa.messages(chat.id, 200) : [];
    const last = history.at(-1);
    // The hub's own link may already have this message; add it only when it does not.
    const messages =
      last && !last.fromMe && last.text.trim() === text.trim()
        ? history
        : [...history, { id: `phone-${Date.now()}`, chatId, chatName: name, senderId: chatId, senderName: name, fromMe: false, isGroup, text, ts: Math.floor(Date.now() / 1000) }];
    if (book) {
      const p = buildPool(book, { chatId, name: chat?.name ?? name.trim(), isGroup }, messages, {
        knowledge: this.know({ chatId, name: chat?.name ?? name.trim(), isGroup }),
      });
      const { system, prompt } = poolPrompt(p);
      const { provider, text: answer } = await this.generate(system, prompt);
      return { provider, options: replyOptions(answer, p), known: !!chat };
    }
    // No style book on this hub yet: a short, plain reply in the conversation's own language.
    const { system, prompt } = plainPrompt(name.trim(), messages);
    const { provider, text: answer } = await this.generate(system, prompt);
    const clean = cleanDraft(answer);
    return { provider, options: clean ? [{ label: "Reply", text: clean }] : [], known: !!chat };
  }

  /** Memory lines about them; a memory problem never stops a reply. */
  private know(who: { name: string; chatId: string; isGroup: boolean }): string[] {
    try {
      return this.opts.knowledge?.(who) ?? [];
    } catch {
      return [];
    }
  }

  /** The first ready model (or the configured one) answers; usage is recorded per try. */
  private async generate(system: string, prompt: string): Promise<{ provider: ProviderId; text: string }> {
    if (this.opts.router) {
      // a pinned replyProvider stays the only one, as before; "auto" lets the router choose and fall back
      const r = await this.opts.router.run("whatsapp_draft", { system, prompt, timeoutMs: 120_000 }, { override: this.opts.provider, strict: this.opts.provider !== "auto" });
      return { provider: r.provider, text: r.text };
    }
    const ready = await this.pool.available();
    const order = this.opts.provider === "auto" ? ORDER.filter((id) => ready.includes(id)) : [this.opts.provider];
    if (!order.length) throw new Error("no online model is ready to draft (Claude, Gemini, ChatGPT or Groq)");
    let error = "";
    for (const provider of order) {
      const r = await this.pool.run(provider, { system, prompt, permission: "read", timeoutMs: 120_000 });
      this.store.recordUsage(provider, this.opts.node, r.ok, r.durationMs);
      if (r.ok) return { provider, text: r.text };
      error = `${provider}: ${r.error ?? "failed"}`;
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
      options: r.options ? JSON.parse(r.options) : [{ label: "Reply", text: r.text }],
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
