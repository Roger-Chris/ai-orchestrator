/**
 * "Hey Jarvis" on a computer (`orc wake`, or `wake.enabled` with `orc serve`). tools/wakeword.py
 * listens on the microphone with openWakeWord (CPU, no key) and records what you say after the wake
 * word; this sends it to the hub's `POST /api/assistant/voice` (the same thinking loop as the phone:
 * memory, tasks, device actions; anything risky still waits for your tap on the phone), then speaks
 * the short answer with the hub's voice (`POST /api/tts`, WAV) or, failing that, the computer's own.
 * It keeps listening for follow-ups without the wake word until you go quiet or say bye.
 */

import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Config } from "../config.js";

export interface WakeOptions {
  /** The hub with the brain (its /api/assistant/voice). */
  hub: string;
  token?: string;
  uv: string;
  /** Repo root (for tools/wakeword.py). */
  root: string;
  model: string;
  threshold: number;
  chime: boolean;
  device?: string;
  /** Follow-up questions without the wake word before it goes back to waiting. */
  followUps: number;
  /** "hub": the hub's voice, then the computer's; "system": always the computer's. */
  voice: "hub" | "system";
  /** Where the recorder and the answer write their (always overwritten) WAV files. */
  outDir: string;
}

export interface WakeEvent {
  event: "ready" | "wake" | "utterance" | "nothing" | "played" | "error";
  path?: string;
  score?: number;
  error?: string;
  model?: string;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
}

interface VoiceReply {
  heard?: string;
  answer?: string;
  say?: string;
  pending?: { device: string; action: string; status: string }[];
  error?: string;
}

export interface WakeDeps {
  spawn?: typeof nodeSpawn;
  http?: typeof fetch;
  /** The computer's own voice; resolves when it has finished. */
  systemSay?: (text: string) => Promise<void>;
  log?: (line: string) => void;
  now?: () => number;
}

const GOODBYE = /^(ok(ay)?\s+)?(bye|goodbye|bye bye|that'?s all|that is all|stop|stop listening|never ?mind|thanks?,? that'?s all|thank you,? that'?s all)[.!]?$/i;
/** A conversation older than this starts fresh. */
const FORGET_MS = 5 * 60_000;

export class WakeListener {
  private child?: ChildProcess;
  private history: Turn[] = [];
  private lastAt = 0;
  private followUpsLeft = 0;
  private played?: () => void;
  private http: typeof fetch;
  private log: (line: string) => void;
  private now: () => number;
  private systemSay: (text: string) => Promise<void>;
  private stopped = false;
  /** Serialises events: an utterance is fully answered before the next event is looked at. */
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private opts: WakeOptions,
    private deps: WakeDeps = {},
  ) {
    this.http = deps.http ?? fetch;
    this.log = deps.log ?? ((l) => console.log(l));
    this.now = deps.now ?? Date.now;
    this.systemSay = deps.systemSay ?? ((t) => systemSay(t, deps.spawn ?? nodeSpawn));
  }

  /** Starts the recorder; resolves when it exits. */
  start(): Promise<number> {
    mkdirSync(this.opts.outDir, { recursive: true });
    const args = ["run", resolve(this.opts.root, "tools", "wakeword.py"), "--model", this.opts.model, "--threshold", String(this.opts.threshold), "--out-dir", this.opts.outDir];
    if (!this.opts.chime) args.push("--no-chime");
    if (this.opts.device) args.push("--device", this.opts.device);
    const child = (this.deps.spawn ?? nodeSpawn)(this.opts.uv, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stderr?.on("data", (d) => {
      for (const line of String(d).split(/\r?\n/)) if (line.startsWith("wakeword:")) this.log(line);
    });
    child.on("error", (e) => this.log(`! couldn't start the wake word listener (${this.opts.uv}): ${e.message}. Install uv: https://docs.astral.sh/uv/`));
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let ev: WakeEvent;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      // "played"/"error" are what an answer in progress waits for, so they can't queue behind it.
      if (ev.event === "played" || ev.event === "error") return void this.handle(ev);
      this.chain = this.chain.then(() => this.handle(ev)).catch((e) => this.log(`! ${(e as Error).message}`));
    });
    return new Promise((done) => child.on("close", (code) => done(code ?? 0)));
  }

  stop() {
    this.stopped = true;
    this.send({ cmd: "quit" });
    this.child?.kill();
  }

  /** One event from the recorder. Public for tests. */
  async handle(ev: WakeEvent): Promise<void> {
    switch (ev.event) {
      case "ready":
        this.log(`Listening for "Hey Jarvis" (${ev.model ?? this.opts.model}) → ${this.opts.hub}`);
        return;
      case "wake":
        this.followUpsLeft = this.opts.followUps;
        if (this.now() - this.lastAt > FORGET_MS) this.history = [];
        this.log(`· heard the wake word (${ev.score ?? "?"})`);
        return;
      case "nothing":
        return; // the recorder went back to waiting for the wake word by itself
      case "played":
        this.played?.();
        this.played = undefined;
        return;
      case "error":
        this.log(`! wake word: ${ev.error}`);
        this.played?.(); // a failed play must not leave the answer waiting for ever
        this.played = undefined;
        return;
      case "utterance":
        if (ev.path) await this.answer(ev.path);
        return;
    }
  }

  private async answer(path: string) {
    let reply: VoiceReply;
    try {
      reply = await this.ask(readFileSync(path));
    } catch (e) {
      this.log(`! ${(e as Error).message}`);
      await this.say("Sorry, I couldn't reach the hub.");
      return this.send({ cmd: "resume" });
    }
    const heard = (reply.heard ?? "").trim();
    if (heard) this.log(`You: ${heard}`);
    if (heard && GOODBYE.test(heard)) {
      await this.say("Okay.");
      return this.send({ cmd: "resume" });
    }
    const say = reply.say || (reply.error ? "Sorry, that didn't work." : reply.answer) || "Done.";
    if (reply.answer) this.log(`Jarvis: ${reply.answer}`);
    if (reply.error) this.log(`! ${reply.error}`);
    if (heard) {
      this.history.push({ role: "user", content: heard }, { role: "assistant", content: reply.answer || say });
      this.history = this.history.slice(-12);
      this.lastAt = this.now();
    }
    await this.say(say);
    if (this.stopped) return;
    // Keep the conversation going without the wake word, a few turns at most.
    if (heard && this.followUpsLeft-- > 0) this.send({ cmd: "listen" });
    else this.send({ cmd: "resume" });
  }

  private async ask(wav: Buffer): Promise<VoiceReply> {
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "clip.wav");
    form.append("history", JSON.stringify(this.history));
    let res: Response;
    try {
      res = await this.http(`${this.opts.hub.replace(/\/+$/, "")}/api/assistant/voice`, { method: "POST", headers: this.auth(), body: form, signal: AbortSignal.timeout(120_000) });
    } catch (e) {
      throw new Error(`the hub at ${this.opts.hub} did not answer (${(e as Error).message})`);
    }
    if (res.status === 401) throw new Error("the hub rejected the token (server.token / ORC_TOKEN must match the hub's)");
    const body = (await res.json().catch(() => ({}))) as VoiceReply;
    if (!res.ok) return { ...body, error: body.error ?? `HTTP ${res.status}` };
    return body;
  }

  /** The hub's voice as WAV played by the recorder, else the computer's own voice. */
  private async say(text: string): Promise<void> {
    if (this.opts.voice === "hub") {
      try {
        const res = await this.http(`${this.opts.hub.replace(/\/+$/, "")}/api/tts`, {
          method: "POST",
          headers: { ...this.auth(), "Content-Type": "application/json" },
          body: JSON.stringify({ text, format: "wav" }),
          signal: AbortSignal.timeout(30_000),
        });
        if (res.ok && (res.headers.get("content-type") ?? "").includes("wav")) {
          const file = join(this.opts.outDir, "answer.wav");
          writeFileSync(file, new Uint8Array(await res.arrayBuffer()));
          await new Promise<void>((done) => {
            this.played = done;
            this.send({ cmd: "play", path: file });
          });
          return;
        }
      } catch {
        /* the computer says it */
      }
    }
    await this.systemSay(text).catch((e) => this.log(`! couldn't speak: ${(e as Error).message}`));
  }

  private auth(): Record<string, string> {
    return this.opts.token ? { Authorization: `Bearer ${this.opts.token}` } : {};
  }

  private send(cmd: Record<string, unknown>) {
    const stdin = this.child?.stdin;
    if (stdin && !stdin.destroyed) stdin.write(`${JSON.stringify(cmd)}\n`);
  }
}

/**
 * The computer's own voice: Windows System.Speech, macOS `say`, Linux `spd-say`/`espeak`.
 * The text goes in on stdin, never on a command line.
 */
export function systemSay(text: string, spawn: typeof nodeSpawn = nodeSpawn, platform = process.platform): Promise<void> {
  const [cmd, args] =
    platform === "win32"
      ? ["powershell", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Speak([Console]::In.ReadToEnd())"]]
      : platform === "darwin"
        ? ["say", ["-f", "-"]]
        : ["espeak", ["--stdin"]];
  return new Promise((done, fail) => {
    const child = spawn(cmd, args as string[], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", fail);
    child.on("close", () => done());
    child.stdin?.end(text);
  });
}

/** Where `orc wake` sends what it hears: wake.hub, else the device's hub setting, else this machine's own hub. */
export function wakeOptions(config: Config, root: string, over: { threshold?: number; device?: string } = {}): WakeOptions {
  const w = config.wake;
  return {
    hub: w.hub || config.sharedMemory.hub || config.whatsapp.hub || `http://127.0.0.1:${config.server.port}`,
    token: config.server.token,
    uv: config.style.uv,
    root,
    model: w.model,
    threshold: over.threshold ?? w.threshold,
    chime: w.chime,
    device: over.device ?? w.device,
    followUps: w.followUps,
    voice: w.voice,
    outDir: join(tmpdir(), "jarvis-wake"),
  };
}
