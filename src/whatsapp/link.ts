import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  /** Download photos people send you in direct chats (live ones only), so they can be described. */
  images: boolean;
  /** Also download the voice notes in history (for a device that transcribes them itself). */
  historyVoice?: boolean;
  /** A queued voice note or photo was downloaded (`ok`) or could not be. Fired for history voice notes too. */
  onMedia?: (message: WaMessage, ok: boolean) => void;
  print: (s: string) => void;
}

export interface LinkStatus {
  state: "starting" | "waiting_for_scan" | "open" | "closed" | "logged_out";
  me?: string;
  historyMessages: number;
  voiceDownloaded: number;
  /** Messages WhatsApp delivered that could not be decrypted, and how many a retry later recovered. */
  undecrypted: { direct: number; group: number; recovered: number };
}

const MAX_MEDIA_BYTES = 6 * 1024 * 1024;
/** proto.WebMessageInfo.StubType.CIPHERTEXT: a message Baileys could not decrypt. */
const CIPHERTEXT = 2;

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
  private state: LinkStatus = { state: "starting", historyMessages: 0, voiceDownloaded: 0, undecrypted: { direct: 0, group: 0, recovered: 0 } };
  private failed = new Set<string>();
  private failedChats = new Set<string>();
  private lidToPn = new Map<string, string>();
  private pnToLid = new Map<string, string>();
  private names = new Map<string, string>();
  private mediaQueue: { msg: WAMessage; out: WaMessage }[] = [];
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
    this.loadLidMappings(authDir);
    mkdirSync(join(this.opts.dataDir, "whatsapp", "voice"), { recursive: true });
    mkdirSync(join(this.opts.dataDir, "whatsapp", "images"), { recursive: true });
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
        if (me && lid) this.mapLid(lid, me);
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

    // Baileys 7 contacts carry both ids (id is either; lid / phoneNumber say which is which).
    const noteContact = (c: any) => {
      if (!c?.id || c.id.endsWith("@g.us")) return;
      const lid: string | undefined = c.lid ?? (c.id.endsWith("@lid") ? c.id : undefined);
      const pn: string | undefined = c.phoneNumber ?? (c.id.endsWith("@s.whatsapp.net") ? c.id : undefined);
      if (lid && pn) this.mapLid(lid, pn);
      const name = c.name || c.notify || c.verifiedName;
      if (!name) return;
      // Named under both ids: the chat may be stored under either.
      for (const id of [lid, pn]) {
        if (!id) continue;
        this.names.set(id, name);
        this.store.nameChat(id, name, false);
      }
    };
    sock.ev.on("contacts.upsert", (cs) => cs.forEach(noteContact));
    sock.ev.on("contacts.update", (cs) => cs.forEach(noteContact));
    sock.ev.on("lid-mapping.update" as any, (m: { lid: string; pn: string }) => {
      if (m?.lid && m?.pn) this.mapLid(jidNormalizedUser(m.lid), jidNormalizedUser(m.pn));
    });

    sock.ev.on("messaging-history.set", ({ chats, contacts, messages }) => {
      // The history bundle carries chat names and LID mappings: take them before the messages.
      for (const c of chats ?? []) {
        if (c.id?.endsWith("@g.us") && c.name) this.store.nameChat(c.id, c.name, true);
        else noteContact({ id: c.id, name: c.name, lid: (c as any).lidJid });
      }
      for (const c of contacts ?? []) noteContact(c);
      this.state.historyMessages += this.keep(messages, false).length;
      this.opts.print(`history: ${this.state.historyMessages} messages so far`);
    });

    // "notify" is a message arriving now; "append" is one caught up after a reconnect. Both are
    // passed on: the hub only drafts for messages under an hour old, so old ones just add context.
    sock.ev.on("messages.upsert", ({ messages }) => {
      this.noteUndecrypted(messages);
      const kept = this.keep(messages, true);
      if (kept.length) this.opts.onLive?.(kept);
    });
  }

  /**
   * A message that failed to decrypt arrives as a CIPHERTEXT placeholder; if WhatsApp's retry
   * works, the real message comes later with the same id. Both are counted here.
   */
  private noteUndecrypted(messages: WAMessage[]) {
    const u = this.state.undecrypted;
    for (const msg of messages) {
      const id = msg.key.id;
      if (!id) continue;
      if (msg.messageStubType === CIPHERTEXT && !msg.message) {
        if (this.failed.has(id)) continue;
        this.failed.add(id);
        if (msg.key.remoteJid?.endsWith("@g.us")) u.group++;
        else u.direct++;
        const k = msg.key as any;
        const where = `${k.remoteJid}${k.participant ? ` from ${k.participant}` : ""}${k.fromMe ? " (sent by you)" : ""}`;
        if (!this.failedChats.has(where)) {
          this.failedChats.add(where);
          this.opts.print(`cannot decrypt messages in ${where} (${msg.messageStubParameters?.[0] ?? "no reason given"})`);
        }
      } else if (msg.message && this.failed.delete(id)) u.recovered++;
    }
  }

  /**
   * Whether this message's media gets downloaded (and so `onMedia` will fire for it): voice notes
   * (yours anywhere, everyone's in direct chats) and, when live, photos sent to you in direct chats.
   */
  wantsMedia(m: WaMessage, live = true): boolean {
    if (m.mediaType === "audio") return this.opts.voiceNotes && (live || this.opts.historyVoice !== false) && (m.fromMe || !m.isGroup);
    return m.mediaType === "image" && live && this.opts.images && !m.fromMe && !m.isGroup;
  }

  /** Converts, stores and queues media for download; returns what was kept. */
  private keep(messages: WAMessage[], live: boolean): WaMessage[] {
    const out: WaMessage[] = [];
    for (const msg of messages) {
      const m = this.convert(msg);
      if (!m) continue;
      out.push(m);
      if (this.wantsMedia(m, live)) this.mediaQueue.push({ msg, out: m });
    }
    this.store.save(out);
    void this.downloadMedia();
    return out;
  }

  /**
   * One contact is one chat although WhatsApp knows them by two ids: a hidden "LID" and their
   * phone number. A chat stays under whichever id its history is already stored as (the style
   * book is keyed by it); a new contact gets the phone-number id when it is known.
   */
  private resolve(jid: string, alt?: string | null): string {
    if (jid.endsWith("@g.us")) return jid;
    const other = alt && alt !== jid ? alt : undefined;
    let lid = jid.endsWith("@lid") ? jid : other?.endsWith("@lid") ? other : this.pnToLid.get(jid);
    let pn = jid.endsWith("@s.whatsapp.net") ? jid : other?.endsWith("@s.whatsapp.net") ? other : lid && this.lidToPn.get(lid);
    if (lid && pn) this.mapLid(lid, pn);
    if (lid && this.store.hasChat(lid)) return lid;
    if (pn && this.store.hasChat(pn)) return pn;
    return pn ?? lid ?? jid;
  }

  private mapLid(lid: string, pn: string) {
    this.lidToPn.set(lid, pn);
    this.pnToLid.set(pn, lid);
  }

  /**
   * Baileys keeps every hidden id it has learnt in the sign-in folder (lid-mapping-<lid>_reverse.json
   * holds the phone number). Loaded at start so a hidden-id chat's number is known before WhatsApp
   * mentions it again: "Send in WhatsApp" needs the number to open that chat.
   */
  private loadLidMappings(authDir: string) {
    for (const f of readdirSync(authDir)) {
      const m = f.match(/^lid-mapping-(\d+)_reverse\.json$/);
      if (!m) continue;
      try {
        const pn = String(JSON.parse(readFileSync(join(authDir, f), "utf8")));
        if (/^\d{6,15}$/.test(pn)) this.mapLid(`${m[1]}@lid`, `${pn}@s.whatsapp.net`);
      } catch {
        // a file Baileys was writing: skip it
      }
    }
  }

  /** Hidden-id chats this device stores, with their phone numbers (digits), for the hub. */
  phones(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [lid, pn] of this.lidToPn) if (this.store.hasChat(lid)) out[lid] = pn.split("@")[0];
    return out;
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
    const chatPhone = chatId.endsWith("@lid") ? this.lidToPn.get(chatId)?.split("@")[0] : undefined;
    return { id: key.id, chatId, senderId, senderName, fromMe, isGroup, text: c.text, mediaType: c.mediaType, quoted: c.quoted, ts, chatPhone };
  }

  /** Downloads queued voice notes and photos one at a time; old ones WhatsApp no longer has are skipped. */
  private async downloadMedia() {
    if (this.downloading || !this.sock) return;
    this.downloading = true;
    try {
      while (this.mediaQueue.length) {
        const { msg, out } = this.mediaQueue.shift()!;
        const inner = unwrap(msg.message);
        const len = Number((inner.audioMessage ?? inner.imageMessage)?.fileLength ?? 0);
        if (len > MAX_MEDIA_BYTES) {
          this.opts.onMedia?.(out, false);
          continue;
        }
        try {
          const buf = await downloadMediaMessage(msg, "buffer", {}, { logger: silent as any, reuploadRequest: this.sock.updateMediaMessage });
          const [dir, ext] = out.mediaType === "image" ? ["images", "jpg"] : ["voice", "ogg"];
          const path = join(this.opts.dataDir, "whatsapp", dir, `${out.id.replace(/[^\w-]/g, "_")}.${ext}`);
          writeFileSync(path, buf);
          this.store.save([{ ...out, mediaPath: path }]);
          if (out.mediaType === "audio") this.state.voiceDownloaded++;
          this.opts.onMedia?.({ ...out, mediaPath: path }, true);
        } catch {
          // Expired on WhatsApp's servers and gone from the phone: nothing to read.
          this.opts.onMedia?.(out, false);
        }
      }
    } finally {
      this.downloading = false;
    }
  }
}
