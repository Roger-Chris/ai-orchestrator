import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import makeWASocket, { DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, jidNormalizedUser, useMultiFileAuthState, type WAMessage } from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import type { WaMessage, WaStore } from "./store.js";

/**
 * Your WhatsApp as a linked device (like WhatsApp Web), through Baileys, the same library the
 * AI_Assistant bridge uses. READ-ONLY: it keeps messages and voice notes so your style can be
 * learnt and replies drafted, and there is deliberately no way to send from here.
 */

export interface LinkOptions {
  dataDir: string;
  /** "full" asks the phone for as much history as it will give; history only arrives when you link. */
  history: "off" | "recent" | "full";
  /** Download voice notes (yours anywhere, and everyone's in direct chats) so they can be transcribed. */
  voiceNotes: boolean;
  /** Chat ids to skip. */
  ignore: string[];
  /** New messages, including ones caught up after a reconnect (not the history sync). */
  onLive?: (messages: WaMessage[]) => void;
  /** A queued voice note was downloaded (`ok`) or could not be. Fired for history ones too. */
  onVoice?: (message: WaMessage, ok: boolean) => void;
  print: (s: string) => void;
}

export interface LinkStatus {
  state: "starting" | "waiting_for_scan" | "open" | "closed" | "logged_out";
  me?: string;
  historyMessages: number;
  voiceDownloaded: number;
}

const MAX_VOICE_BYTES = 6 * 1024 * 1024;

const silent = {
  level: "silent",
  child: () => silent,
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Peels ephemeral / view-once / edited wrappers down to the real content. */
function unwrap(message: any): any {
  let m = message;
  for (let i = 0; i < 4 && m; i++) {
    const inner =
      m.ephemeralMessage?.message ||
      m.viewOnceMessage?.message ||
      m.viewOnceMessageV2?.message ||
      m.editedMessage?.message?.protocolMessage?.editedMessage ||
      m.documentWithCaptionMessage?.message;
    if (!inner) break;
    m = inner;
  }
  return m ?? {};
}

/** Text and kind of a message, or undefined for things that are not messages (reactions, receipts). */
export function content(message: any): { text: string; mediaType?: string; quoted?: string } | undefined {
  const m = unwrap(message);
  const ctx = (Object.values(m).find((v: any) => v?.contextInfo) as any)?.contextInfo;
  const q = ctx?.quotedMessage ? unwrap(ctx.quotedMessage) : undefined;
  const quotedText = q ? (q.conversation ?? q.extendedTextMessage?.text ?? q.imageMessage?.caption ?? (q.audioMessage ? "[voice note]" : undefined)) : undefined;
  const quoted = quotedText ? String(quotedText).slice(0, 160) : undefined;
  if (m.conversation) return { text: m.conversation, quoted };
  if (m.extendedTextMessage) return { text: m.extendedTextMessage.text ?? "", quoted };
  if (m.audioMessage) return { text: "", mediaType: "audio", quoted };
  if (m.imageMessage) return { text: m.imageMessage.caption ?? "", mediaType: "image", quoted };
  if (m.videoMessage) return { text: m.videoMessage.caption ?? "", mediaType: "video", quoted };
  if (m.documentMessage) return { text: m.documentMessage.caption ?? m.documentMessage.fileName ?? "", mediaType: "document", quoted };
  if (m.stickerMessage) return { text: "", mediaType: "sticker", quoted };
  if (m.contactMessage) return { text: m.contactMessage.displayName ?? "", mediaType: "contact" };
  if (m.locationMessage) return { text: "", mediaType: "location" };
  if (m.pollCreationMessage) return { text: m.pollCreationMessage.name ?? "", mediaType: "poll" };
  return undefined;
}

export class WhatsAppLink {
  private state: LinkStatus = { state: "starting", historyMessages: 0, voiceDownloaded: 0 };
  private lidToPn = new Map<string, string>();
  private names = new Map<string, string>();
  private voiceQueue: { msg: WAMessage; out: WaMessage }[] = [];
  private downloading = false;
  private sock?: ReturnType<typeof makeWASocket>;
  private stopped = false;

  constructor(
    private store: WaStore,
    private opts: LinkOptions,
  ) {}

  status(): LinkStatus {
    return { ...this.state };
  }

  stop() {
    this.stopped = true;
    this.sock?.end(undefined);
  }

  async start(): Promise<void> {
    const authDir = join(this.opts.dataDir, "whatsapp", "auth");
    mkdirSync(authDir, { recursive: true });
    mkdirSync(join(this.opts.dataDir, "whatsapp", "voice"), { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({
      version,
      auth: state,
      logger: silent as any,
      markOnlineOnConnect: false, // your phone keeps getting its notifications
      syncFullHistory: this.opts.history === "full",
      shouldSyncHistoryMessage: () => this.opts.history !== "off",
      browser: ["AI Orchestrator", "Desktop", "0.1"],
    });
    this.sock = sock;
    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (u) => {
      if (u.qr) {
        this.state.state = "waiting_for_scan";
        this.opts.print("Scan this with WhatsApp on your phone: Settings → Linked devices → Link a device.");
        qrcode.generate(u.qr, { small: true }, (s) => this.opts.print(s));
      }
      if (u.connection === "open") {
        const me = sock.user?.id ? jidNormalizedUser(sock.user.id) : undefined;
        const lid = (sock.user as any)?.lid ? jidNormalizedUser((sock.user as any).lid) : undefined;
        if (me && lid) this.lidToPn.set(lid, me);
        this.state = { ...this.state, state: "open", me };
        this.opts.print(`WhatsApp linked as ${me?.split("@")[0] ?? "you"}.${this.opts.history !== "off" ? " History arrives over the next few minutes." : ""}`);
        // One call for every group's name: per-message lookups hit WhatsApp's rate limit.
        sock
          .groupFetchAllParticipating()
          .then((all) => {
            for (const [id, g] of Object.entries(all)) if (g?.subject) this.store.nameChat(id, g.subject, true);
          })
          .catch(() => {});
      }
      if (u.connection === "close") {
        const code = (u.lastDisconnect?.error as any)?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          this.state.state = "logged_out";
          this.opts.print(`WhatsApp logged this device out. Delete ${authDir} and link again.`);
          return;
        }
        this.state.state = "closed";
        if (!this.stopped) setTimeout(() => void this.start().catch((e) => this.opts.print(`WhatsApp reconnect failed: ${(e as Error).message}`)), 3000);
      }
    });

    const noteContact = (c: any) => {
      if (!c?.id) return;
      const name = c.name || c.notify || c.verifiedName;
      if (c.lid && c.id.endsWith("@s.whatsapp.net")) this.lidToPn.set(c.lid, c.id);
      if (name && c.id.endsWith("@s.whatsapp.net")) {
        this.names.set(c.id, name);
        this.store.nameChat(c.id, name, false);
      }
    };
    sock.ev.on("contacts.upsert", (cs) => cs.forEach(noteContact));
    sock.ev.on("contacts.update", (cs) => cs.forEach(noteContact));

    sock.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
      // The history bundle carries chat names and LID mappings: take them before the messages.
      for (const c of chats ?? []) {
        if (c.id?.endsWith("@g.us") && c.name) this.store.nameChat(c.id, c.name, true);
        else noteContact({ id: c.id, name: c.name, lid: (c as any).lidJid });
      }
      for (const c of contacts ?? []) noteContact(c);
      this.state.historyMessages += this.keep(messages).length;
      this.opts.print(`history: ${this.state.historyMessages} messages so far`);
    });

    // "notify" is a message arriving now; "append" is one caught up after a reconnect. Both are
    // passed on: the hub only drafts for messages under an hour old, so old ones just add context.
    sock.ev.on("messages.upsert", ({ messages }) => {
      const kept = this.keep(messages);
      if (kept.length) this.opts.onLive?.(kept);
    });
  }

  /** Whether a voice note in this chat gets downloaded (and so `onVoice` will fire for it). */
  wantsVoice(m: WaMessage): boolean {
    return this.opts.voiceNotes && m.mediaType === "audio" && (m.fromMe || !m.isGroup);
  }

  /** Converts, stores and queues voice notes for download; returns what was kept. */
  private keep(messages: WAMessage[]): WaMessage[] {
    const out: WaMessage[] = [];
    for (const msg of messages) {
      const m = this.convert(msg);
      if (!m) continue;
      out.push(m);
      if (this.wantsVoice(m)) this.voiceQueue.push({ msg, out: m });
    }
    this.store.save(out);
    void this.downloadVoice();
    return out;
  }

  /** WhatsApp's newer "LID" ids: use the phone-number id when known, so one contact is one chat. */
  private resolve(jid: string, alt?: string | null): string {
    if (!jid.endsWith("@lid")) return jid;
    if (alt) {
      this.lidToPn.set(jid, alt);
      return alt;
    }
    return this.lidToPn.get(jid) ?? jid;
  }

  private convert(msg: WAMessage): WaMessage | undefined {
    const key = msg.key as any;
    let chatId: string | undefined = key.remoteJid;
    if (!chatId || !msg.message || chatId === "status@broadcast" || chatId.endsWith("@newsletter") || chatId.endsWith("@broadcast")) return undefined;
    chatId = this.resolve(chatId, key.remoteJidAlt ?? key.senderPn);
    if (this.opts.ignore.includes(chatId)) return undefined;
    const c = content(msg.message);
    if (!c) return undefined;
    const isGroup = chatId.endsWith("@g.us");
    const fromMe = !!key.fromMe;
    let senderId: string = isGroup ? (key.participant ?? chatId) : fromMe ? (this.state.me ?? "me") : chatId;
    senderId = this.resolve(senderId, key.participantAlt ?? key.participantPn);
    const senderName = fromMe ? "me" : (msg.pushName ?? this.names.get(senderId) ?? undefined);
    if (!isGroup && !fromMe && msg.pushName && !this.names.has(chatId)) {
      this.names.set(chatId, msg.pushName);
      this.store.nameChat(chatId, msg.pushName, false);
    }
    const ts = Number(msg.messageTimestamp ?? 0) || Math.floor(Date.now() / 1000);
    return { id: key.id, chatId, senderId, senderName, fromMe, isGroup, text: c.text, mediaType: c.mediaType, quoted: c.quoted, ts };
  }

  /** Downloads queued voice notes one at a time; old ones WhatsApp no longer has are skipped. */
  private async downloadVoice() {
    if (this.downloading || !this.sock) return;
    this.downloading = true;
    try {
      while (this.voiceQueue.length) {
        const { msg, out } = this.voiceQueue.shift()!;
        const len = Number(unwrap(msg.message).audioMessage?.fileLength ?? 0);
        if (len > MAX_VOICE_BYTES) {
          this.opts.onVoice?.(out, false);
          continue;
        }
        try {
          const buf = await downloadMediaMessage(msg, "buffer", {}, { logger: silent as any, reuploadRequest: this.sock.updateMediaMessage });
          const path = join(this.opts.dataDir, "whatsapp", "voice", `${out.id.replace(/[^\w-]/g, "_")}.ogg`);
          writeFileSync(path, buf);
          this.store.save([{ ...out, mediaPath: path }]);
          this.state.voiceDownloaded++;
          this.opts.onVoice?.({ ...out, mediaPath: path }, true);
        } catch {
          // Expired on WhatsApp's servers and gone from the phone: nothing to transcribe.
          this.opts.onVoice?.(out, false);
        }
      }
    } finally {
      this.downloading = false;
    }
  }
}
