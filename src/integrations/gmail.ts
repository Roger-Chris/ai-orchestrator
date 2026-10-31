import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import type { ModelRouter } from "../ai/route.js";
import type { ProviderPool } from "../providers/registry.js";
import { localDay } from "../server/home.js";
import type { Store } from "../store/db.js";
import type { ProviderId } from "../types.js";

/**
 * Reads your Gmail (read-only) every few minutes and turns mail you have to act on
 * (appointments, bills due, deliveries, requests) into tasks for the home screen.
 * Uses your own Google OAuth client (gmail-client.json) and one of your models (Groq first) to
 * pick the tasks out; no mail is stored, only the ids of messages already looked at.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
/** The sign-in that may send: kept apart from the reader's, so the reader never holds send rights. */
export const SEND_SCOPES = ["https://www.googleapis.com/auth/gmail.send", SCOPE];

export interface GmailOptions {
  /** Token file in dataDir (default gmail-token.json) and what it may do (default read-only). */
  tokenName?: string;
  scopes?: string[];
  /** OAuth client file downloaded from Google Cloud (Desktop app). */
  clientFile: string;
  dataDir: string;
  query: string;
  provider: "auto" | ProviderId;
  node: string;
  /** The model router (R2): each batch goes to the best ready model, falling back on failure. */
  router?: ModelRouter;
}

interface Client {
  client_id: string;
  client_secret: string;
}

interface Token {
  refresh_token: string;
  email?: string;
}

export interface GmailStatus {
  /** An OAuth client file is in place. */
  configured: boolean;
  connected: boolean;
  email?: string;
  lastCheck?: number;
  lastError?: string;
  /** Tasks added by the last check. */
  lastAdded?: number;
}

/** Mail the model is shown: enough to spot a task, not the whole thread. */
export interface Mail {
  id: string;
  from: string;
  subject: string;
  date: string;
  body: string;
}

const b64url = (b: Buffer) => b.toString("base64url");

function readClient(file: string): Client | undefined {
  if (!existsSync(file)) return undefined;
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const c = raw.installed ?? raw.web ?? raw;
  if (!c.client_id || !c.client_secret) throw new Error(`${file} is not a Google OAuth client file (download it from Google Cloud → Credentials → OAuth client → Desktop app)`);
  return { client_id: c.client_id, client_secret: c.client_secret };
}

/** Plain text of a Gmail message payload: the text/plain part, or the HTML part with tags stripped. */
export function mailText(payload: any): string {
  const parts: any[] = [];
  const walk = (p: any) => {
    if (!p) return;
    parts.push(p);
    for (const c of p.parts ?? []) walk(c);
  };
  walk(payload);
  const decode = (p: any) => (p?.body?.data ? Buffer.from(p.body.data, "base64url").toString("utf8") : "");
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plain) return decode(plain);
  const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
  return html
    ? decode(html)
        .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
    : "";
}

/** A plain UTF-8 mail as Gmail wants it. Line breaks in a header could add recipients, so they are refused. */
export function rawMessage(m: { to: string; subject: string; body: string }): string {
  if (/[\r\n]/.test(m.to) || /[\r\n]/.test(m.subject)) throw new Error("a line break in the address or subject is not allowed");
  const subject = /^[\x20-\x7e]*$/.test(m.subject) ? m.subject : `=?UTF-8?B?${Buffer.from(m.subject).toString("base64")}?=`;
  const text = [`To: ${m.to}`, `Subject: ${subject}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", Buffer.from(m.body).toString("base64")].join("\r\n");
  return Buffer.from(text).toString("base64url");
}

/** The prompt that asks a model to pick today's and upcoming tasks out of a batch of mail. */
export function taskPrompt(mails: Mail[], now = new Date()): string {
  const today = `${localDay(now)} (${now.toLocaleDateString("en-GB", { weekday: "long" })})`;
  return [
    `Today is ${today}. Below are new emails to me. List only the things I have to do or attend: appointments, meetings, calls, bills or payments due, deliveries to collect, forms or documents to send, replies someone is waiting for.`,
    "Skip newsletters, marketing, receipts and confirmations that need nothing from me, security alerts, and automatic notifications.",
    'Answer with JSON only, no prose: {"tasks":[{"email":<number>,"title":"<short imperative, e.g. Pay electricity bill>","day":"YYYY-MM-DD","time":"<e.g. 10:00 or by 5 pm, or null>","detail":"<who or what, a few words, e.g. amount or sender>"}]}.',
    'Use the date the thing is due or happens; if it is "today" or has no date, use today. Use {"tasks":[]} when there is nothing to do.',
    "",
    ...mails.map((m, i) => `--- EMAIL ${i + 1}\nFrom: ${m.from}\nDate: ${m.date}\nSubject: ${m.subject}\n\n${m.body}`),
  ].join("\n");
}

/** Tasks from the model's answer; anything malformed is dropped rather than guessed at. */
export function parseTasks(text: string, mails: Mail[], today: string) {
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let tasks: unknown;
  try {
    tasks = JSON.parse(json).tasks;
  } catch {
    return undefined;
  }
  if (!Array.isArray(tasks)) return undefined;
  const out: { id: string; day: string; time?: string; title: string; detail?: string }[] = [];
  tasks.forEach((t: any, i) => {
    const mail = mails[Number(t?.email) - 1];
    const title = typeof t?.title === "string" ? t.title.trim().slice(0, 300) : "";
    if (!mail || !title) return;
    const day = typeof t.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.day) ? t.day : today;
    if (day < today) return; // already past
    const time = typeof t.time === "string" && t.time.trim() && t.time !== "null" ? t.time.trim().slice(0, 40) : undefined;
    const detail = typeof t.detail === "string" && t.detail.trim() ? t.detail.trim().slice(0, 200) : undefined;
    out.push({ id: `gmail:${mail.id}:${i}`, day, time, title, detail });
  });
  return out;
}

export class GmailReader {
  private access?: { token: string; until: number };
  private state: Omit<GmailStatus, "configured" | "connected" | "email"> = {};
  private checking?: Promise<{ scanned: number; added: number }>;
  private timer?: NodeJS.Timeout;

  constructor(
    private store: Store,
    private pool: Pick<ProviderPool, "available" | "run">,
    private opts: GmailOptions,
    private http: typeof fetch = fetch,
  ) {
    store.db.exec("CREATE TABLE IF NOT EXISTS gmail_seen (id TEXT PRIMARY KEY, ts INTEGER NOT NULL)");
  }

  private get tokenFile() {
    return join(this.opts.dataDir, this.opts.tokenName ?? "gmail-token.json");
  }

  private token(): Token | undefined {
    return existsSync(this.tokenFile) ? JSON.parse(readFileSync(this.tokenFile, "utf8")) : undefined;
  }

  status(): GmailStatus {
    let configured = false;
    try {
      configured = !!readClient(this.opts.clientFile);
    } catch {}
    const t = this.token();
    return { configured, connected: !!t, email: t?.email, ...this.state };
  }

  /** Checks soon and then every `minutes`; quietly does nothing until you connect. */
  start(minutes: number) {
    const tick = () => {
      if (this.token()) this.check().catch(() => {});
    };
    setTimeout(tick, 15_000).unref();
    this.timer = setInterval(tick, minutes * 60_000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** One pass: new mail since last time → tasks. Concurrent calls share the same pass. */
  check(): Promise<{ scanned: number; added: number }> {
    this.checking ??= this.pass().finally(() => (this.checking = undefined));
    return this.checking;
  }

  private async pass() {
    try {
      const r = await this.scan();
      this.state = { lastCheck: Date.now(), lastAdded: r.added };
      return r;
    } catch (e) {
      this.state = { ...this.state, lastCheck: Date.now(), lastError: (e as Error).message };
      throw e;
    }
  }

  private async scan() {
    const list = await this.get<{ messages?: { id: string }[] }>(`/messages?maxResults=40&q=${encodeURIComponent(this.opts.query)}`);
    const seen = this.store.db.prepare("SELECT 1 FROM gmail_seen WHERE id = ?");
    const fresh = (list.messages ?? []).filter((m) => !seen.get(m.id));
    if (!fresh.length) return { scanned: 0, added: 0 };

    const mails: Mail[] = [];
    for (const m of fresh) {
      const msg = await this.get<any>(`/messages/${m.id}?format=full`);
      const h = (name: string) => msg.payload?.headers?.find((x: any) => x.name.toLowerCase() === name)?.value ?? "";
      const body = (mailText(msg.payload) || msg.snippet || "").replace(/\s+/g, " ").trim();
      mails.push({ id: m.id, from: h("from"), subject: h("subject"), date: h("date"), body: body.slice(0, 1500) });
    }

    const provider = this.opts.router ? undefined : await this.pickProvider();
    const mark = this.store.db.prepare("INSERT OR IGNORE INTO gmail_seen (id, ts) VALUES (?, ?)");
    const today = localDay();
    let added = 0;
    // Small batches keep each prompt short and let one bad answer cost only a few emails.
    for (let i = 0; i < mails.length; i += 10) {
      const batch = mails.slice(i, i + 10);
      let r: { ok: boolean; text: string; error?: string; provider: ProviderId };
      if (this.opts.router) {
        // a pinned gmail.provider stays the only one; "auto" lets the router choose and fall back
        const o = await this.opts.router.run("mail", { prompt: taskPrompt(batch), timeoutMs: 240_000 }, { override: this.opts.provider, strict: this.opts.provider !== "auto" });
        r = { ok: true, text: o.text, provider: o.provider };
      } else {
        const res = await this.pool.run(provider!, { prompt: taskPrompt(batch), permission: "read", timeoutMs: 240_000 });
        this.store.recordUsage(provider!, this.opts.node, res.ok, res.durationMs, res.usage);
        r = res;
      }
      const tasks = r.ok ? parseTasks(r.text, batch, today) : undefined;
      if (!tasks) throw new Error(`could not read tasks from ${r.provider}'s answer${r.error ? `: ${r.error.slice(0, 200)}` : ""}`);
      for (const t of tasks) this.store.addTask({ ...t, source: "gmail" });
      added += tasks.length;
      // Only now are these emails done: a failed batch is tried again next time.
      for (const m of batch) mark.run(m.id, Date.now());
    }
    return { scanned: mails.length, added };
  }

  private async pickProvider(): Promise<ProviderId> {
    if (this.opts.provider !== "auto") return this.opts.provider;
    const ready = await this.pool.available();
    const pick = (["groq", "claude", "gemini", "codex"] as ProviderId[]).find((p) => ready.includes(p));
    if (!pick) throw new Error("no model is ready to read mail (Groq, Claude, Gemini or ChatGPT)");
    return pick;
  }

  /** Sends one finished message and returns Gmail's id. Only MailDesk calls this, after the owner's Send. */
  async send(mail: { to: string; subject: string; body: string }): Promise<string> {
    const res = await this.http(`${API}/messages/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: rawMessage(mail) }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (res.status === 403) throw new Error("Gmail refused: this sign-in can't send. Run `orc gmail connect-send` on the hub and allow sending.");
    if (!res.ok || !body.id) throw new Error(`Gmail ${res.status}: ${body.error?.message ?? res.statusText}`);
    return body.id;
  }

  /** The owner's own recent mail, as examples of their voice: to this person when there is any, else any. */
  async recentSent(to?: string, count = 5): Promise<string[]> {
    const search = async (q: string) => (await this.get<{ messages?: { id: string }[] }>(`/messages?maxResults=${count}&q=${encodeURIComponent(q)}`)).messages ?? [];
    let found = to ? await search(`in:sent to:${to}`) : [];
    if (!found.length) found = await search("in:sent");
    const out: string[] = [];
    for (const m of found) {
      const msg = await this.get<any>(`/messages/${m.id}?format=full`);
      // Only the owner's words: quoted replies below "On ... wrote:" are someone else's words.
      const text = mailText(msg.payload).split(/\r?\n(?:On .{5,200} wrote:|>)/)[0].trim();
      if (text) out.push(text.slice(0, 800));
    }
    return out;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.http(`${API}${path}`, { headers: { Authorization: `Bearer ${await this.accessToken()}` } });
    if (res.status === 401) this.access = undefined;
    if (!res.ok) throw new Error(`Gmail ${res.status}: ${((await res.json().catch(() => ({}))) as any).error?.message ?? res.statusText}`);
    return (await res.json()) as T;
  }

  private async accessToken(): Promise<string> {
    if (this.access && this.access.until > Date.now() + 60_000) return this.access.token;
    const client = readClient(this.opts.clientFile);
    const token = this.token();
    if (!client || !token) throw new Error(`Gmail is not connected: run \`orc gmail ${this.opts.scopes ? "connect-send" : "connect"}\` on the hub`);
    const res = await this.http(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, refresh_token: token.refresh_token, grant_type: "refresh_token" }),
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (body.error === "invalid_grant") throw new Error("Gmail sign-in expired or was revoked: run `orc gmail connect` on the hub again");
    if (!res.ok || !body.access_token) throw new Error(`Google sign-in failed: ${body.error ?? res.status}`);
    this.access = { token: body.access_token, until: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  /**
   * Signs in with Google and keeps a refresh token in the data folder.
   * Works on a headless hub too: open the printed link on any device; if the browser
   * can't reach this machine afterwards, paste the address it ended on here.
   */
  async connect(io: { print: (s: string) => void; pasted: Promise<string> }): Promise<string> {
    const client = readClient(this.opts.clientFile);
    if (!client) throw new Error(`No OAuth client at ${this.opts.clientFile}. See "Gmail" in the README for the Google Cloud setup.`);
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(16));

    let resolveCode!: (u: URL) => void;
    const got = new Promise<URL>((r) => (resolveCode = r));
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (!u.searchParams.has("code") && !u.searchParams.has("error")) return void res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end("Gmail is connected to the orchestrator. You can close this tab.");
      resolveCode(u);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const redirect = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const url = `${AUTH_URL}?${new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: redirect,
        response_type: "code",
        scope: (this.opts.scopes ?? [SCOPE]).join(" "),
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: b64url(createHash("sha256").update(verifier).digest()),
        code_challenge_method: "S256",
      })}`;
      io.print(`Open this link and allow ${this.opts.scopes ? "reading your mail and sending the mail you approve" : "read-only access to Gmail"}:\n\n${url}\n\nIf the last page says it can't connect (the hub is another machine), copy that page's address and paste it here.`);
      const back = await Promise.race([got, io.pasted.then((s) => new URL(s.trim()))]);
      if (back.searchParams.get("error")) throw new Error(`Google said: ${back.searchParams.get("error")}`);
      if (back.searchParams.get("state") !== state) throw new Error("that address is from a different sign-in attempt; run connect again");

      const res = await this.http(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: client.client_id,
          client_secret: client.client_secret,
          code: back.searchParams.get("code")!,
          code_verifier: verifier,
          redirect_uri: redirect,
          grant_type: "authorization_code",
        }),
      });
      const body = (await res.json()) as { refresh_token?: string; access_token?: string; expires_in?: number; error_description?: string };
      if (!res.ok || !body.refresh_token) throw new Error(`Google sign-in failed: ${body.error_description ?? res.status}`);
      this.access = body.access_token ? { token: body.access_token, until: Date.now() + (body.expires_in ?? 3600) * 1000 } : undefined;
      writeFileSync(this.tokenFile, JSON.stringify({ refresh_token: body.refresh_token }), { mode: 0o600 });
      const profile = await this.get<{ emailAddress: string }>("/profile");
      writeFileSync(this.tokenFile, JSON.stringify({ refresh_token: body.refresh_token, email: profile.emailAddress }), { mode: 0o600 });
      return profile.emailAddress;
    } finally {
      server.close();
    }
  }

  /** Forgets the sign-in here and tells Google to revoke it. */
  async disconnect() {
    const t = this.token();
    if (t) await this.http(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(t.refresh_token)}`, { method: "POST" }).catch(() => {});
    rmSync(this.tokenFile, { force: true });
    this.access = undefined;
  }
}
