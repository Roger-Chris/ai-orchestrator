import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { wavFromPcm } from "../src/voice/tts.js";
import { WakeListener, type WakeOptions, systemSay, wakeOptions } from "../src/voice/wake.js";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));

/** A stand-in for tools/wakeword.py: we write its events, and read the commands it was sent. */
function fakeRecorder() {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { stdout, stdin, stderr, kill: () => child.emit("close", 0) });
  const commands: Record<string, unknown>[] = [];
  stdin.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => commands.push(JSON.parse(l))));
  const spawned: { cmd: string; args: string[] }[] = [];
  const spawn = ((cmd: string, args: string[]) => (spawned.push({ cmd, args }), child)) as never;
  const emit = (ev: object) => stdout.write(`${JSON.stringify(ev)}\n`);
  return { spawn, emit, commands, spawned, child };
}

type Sent = { url: string; auth?: string; body: unknown };

/** The hub: /api/assistant/voice answers the next queued reply; /api/tts gives WAV unless `ttsDown`. */
function fakeHub(replies: object[], opts: { ttsDown?: boolean } = {}) {
  const sent: Sent[] = [];
  const http = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    if (url.endsWith("/api/assistant/voice")) {
      const form = init!.body as FormData;
      const audio = form.get("audio") as File;
      sent.push({ url, auth, body: { audio: { name: audio.name, type: audio.type, size: audio.size }, history: JSON.parse(String(form.get("history"))) } });
      return Response.json(replies.shift() ?? { heard: "", answer: "", say: "Sorry, I didn't catch that." });
    }
    sent.push({ url, auth, body: JSON.parse(String(init!.body)) });
    if (opts.ttsDown) return Response.json({ error: "no service", fallback: "phone" }, { status: 409 });
    return new Response(wavFromPcm([new Uint8Array(32)]) as BodyInit, { headers: { "Content-Type": "audio/wav" } });
  }) as typeof fetch;
  return { http, sent };
}

function setup(replies: object[], over: Partial<WakeOptions> = {}, hubOpts: { ttsDown?: boolean } = {}) {
  const outDir = mkdtempSync(join(tmpdir(), "orc-wake-"));
  cleanup.push(() => rmSync(outDir, { recursive: true, force: true }));
  const clip = join(outDir, "utterance.wav");
  writeFileSync(clip, wavFromPcm([new Uint8Array(3200)], { channels: 1, sampleRate: 16_000, bitsPerSample: 16 }));
  const rec = fakeRecorder();
  const hub = fakeHub(replies, hubOpts);
  const spoken: string[] = [];
  const logs: string[] = [];
  let t = 1_000_000;
  const opts: WakeOptions = { hub: "http://hub:4317/", token: "secret-token", uv: "uv", root: "/repo", model: "hey_jarvis", threshold: 0.5, chime: true, followUps: 1, voice: "hub", outDir, ...over };
  const w = new WakeListener(opts, { spawn: rec.spawn, http: hub.http, systemSay: async (s) => void spoken.push(s), log: (l) => logs.push(l), now: () => t });
  const done = w.start();
  /** Waits until the listener has sent `n` commands in all (answers are async: hub, voice, play). */
  const settle = async (n: number) => {
    for (let i = 0; i < 200 && rec.commands.length < n; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 10));
  };
  /** Answers "play" commands the way the recorder does. */
  const autoPlay = () => rec.child.stdin.on("data", (d) => String(d).includes('"play"') && setTimeout(() => rec.emit({ event: "played" }), 5));
  return { w, rec, hub, spoken, logs, clip, outDir, done, settle, autoPlay, advance: (ms: number) => (t += ms) };
}

describe("Hey Jarvis on a computer", () => {
  it("starts the recorder with uv and the configured model", () => {
    const s = setup([], { threshold: 0.4, device: "2", chime: false });
    expect(s.rec.spawned[0].cmd).toBe("uv");
    expect(s.rec.spawned[0].args).toEqual(["run", resolve("/repo", "tools", "wakeword.py"), "--model", "hey_jarvis", "--threshold", "0.4", "--out-dir", s.outDir, "--no-chime", "--device", "2"]);
  });

  it("sends what you said to the hub, plays the hub's voice, then listens for a follow-up", async () => {
    const s = setup([
      { heard: "what's on today", answer: "Two tasks: **gym** at 6 and call Varun.", say: "Two tasks: gym at 6 and call Varun.", pending: [] },
      { heard: "remind me about gym", answer: "Okay, reminder set.", say: "Okay, reminder set." },
    ]);
    s.autoPlay();
    s.rec.emit({ event: "ready", model: "hey_jarvis" });
    s.rec.emit({ event: "wake", score: 0.91 });
    s.rec.emit({ event: "utterance", path: s.clip });
    await s.settle(2);
    const [voice, tts] = s.hub.sent;
    expect(voice.url).toBe("http://hub:4317/api/assistant/voice");
    expect(voice.auth).toBe("Bearer secret-token");
    expect(voice.body).toMatchObject({ audio: { name: "clip.wav", type: "audio/wav" }, history: [] });
    expect(tts).toEqual({ url: "http://hub:4317/api/tts", auth: "Bearer secret-token", body: { text: "Two tasks: gym at 6 and call Varun.", format: "wav" } });
    expect(s.rec.commands).toEqual([{ cmd: "play", path: join(s.outDir, "answer.wav") }, { cmd: "listen" }]);
    expect(readFileSync(join(s.outDir, "answer.wav")).subarray(0, 4).toString()).toBe("RIFF");
    expect(s.logs).toContain("You: what's on today");

    // the follow-up carries the conversation; after the last follow-up it goes back to the wake word
    s.rec.emit({ event: "utterance", path: s.clip });
    await s.settle(4);
    expect((s.hub.sent[2].body as { history: unknown[] }).history).toEqual([
      { role: "user", content: "what's on today" },
      { role: "assistant", content: "Two tasks: **gym** at 6 and call Varun." },
    ]);
    expect(s.rec.commands.slice(2)).toEqual([{ cmd: "play", path: join(s.outDir, "answer.wav") }, { cmd: "resume" }]);
    expect(s.spoken).toEqual([]);
  });

  it("uses the computer's own voice when the hub has none, and stops on bye", async () => {
    const s = setup([{ heard: "open vs code", answer: "Waiting for your OK.", say: "I need your OK for apps.open on omen: tap Approve on the screen." }, { heard: "bye", answer: "", say: "" }], {}, { ttsDown: true });
    s.rec.emit({ event: "wake", score: 0.8 });
    s.rec.emit({ event: "utterance", path: s.clip });
    await s.settle(1);
    expect(s.spoken).toEqual(["I need your OK for apps.open on omen: tap Approve on the screen."]);
    expect(s.rec.commands).toEqual([{ cmd: "listen" }]);
    s.rec.emit({ event: "utterance", path: s.clip });
    await s.settle(2);
    expect(s.spoken[1]).toBe("Okay.");
    expect(s.rec.commands.at(-1)).toEqual({ cmd: "resume" });
    expect(s.hub.sent.filter((x) => x.url.endsWith("/voice"))).toHaveLength(2);
  });

  it("forgets an old conversation, and says so when the hub is unreachable", async () => {
    const s = setup([{ heard: "hi", answer: "Hello.", say: "Hello." }], { voice: "system", followUps: 0 });
    s.rec.emit({ event: "wake" });
    s.rec.emit({ event: "utterance", path: s.clip });
    await s.settle(1);
    expect(s.spoken).toEqual(["Hello."]);
    expect(s.rec.commands).toEqual([{ cmd: "resume" }]); // no follow-ups configured
    s.advance(6 * 60_000);
    s.rec.emit({ event: "wake" });
    s.rec.emit({ event: "utterance", path: s.clip });
    await s.settle(2);
    expect((s.hub.sent.at(-1)!.body as { history: unknown[] }).history).toEqual([]);

    const down = setup([], { voice: "system" });
    (down.w as unknown as { http: typeof fetch }).http = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as typeof fetch;
    down.rec.emit({ event: "utterance", path: down.clip });
    await down.settle(1);
    expect(down.spoken).toEqual(["Sorry, I couldn't reach the hub."]);
    expect(down.logs.some((l) => l.includes("ECONNREFUSED"))).toBe(true);
    expect(down.rec.commands).toEqual([{ cmd: "resume" }]);
  });

  it("a failed play doesn't leave the answer hanging", async () => {
    const s = setup([{ heard: "hi", answer: "Hello.", say: "Hello." }], { followUps: 0 });
    s.rec.child.stdin.on("data", (d) => String(d).includes('"play"') && setTimeout(() => s.rec.emit({ event: "error", error: "couldn't play" }), 5));
    s.rec.emit({ event: "utterance", path: s.clip });
    await s.settle(2);
    expect(s.rec.commands.at(-1)).toEqual({ cmd: "resume" });
    expect(s.logs).toContain("! wake word: couldn't play");
  });

  it("picks the hub from config and speaks through stdin, never the command line", async () => {
    const cfg = parseConfig({ server: { token: "t", port: 4400 }, sharedMemory: { hub: "http://100.104.185.17:4317" } });
    expect(wakeOptions(cfg, "/r")).toMatchObject({ hub: "http://100.104.185.17:4317", token: "t", model: "hey_jarvis", threshold: 0.5, followUps: 3, voice: "hub" });
    expect(wakeOptions(parseConfig({ server: { port: 4400 } }), "/r").hub).toBe("http://127.0.0.1:4400");
    expect(wakeOptions(parseConfig({ wake: { hub: "http://x:1" } }), "/r", { threshold: 0.3 })).toMatchObject({ hub: "http://x:1", threshold: 0.3 });

    const calls: { cmd: string; args: string[]; input: string }[] = [];
    const spawn = ((cmd: string, args: string[]) => {
      const stdin = new PassThrough();
      const child = Object.assign(new EventEmitter(), { stdin });
      let input = "";
      stdin.on("data", (d) => (input += d));
      stdin.on("finish", () => (calls.push({ cmd, args, input }), child.emit("close", 0)));
      return child;
    }) as never;
    await systemSay("It's 5 o'clock; don't forget.", spawn, "win32");
    await systemSay("hello", spawn, "darwin");
    await systemSay("hello", spawn, "linux");
    expect(calls[0].cmd).toBe("powershell");
    expect(calls[0].args.join(" ")).not.toContain("5 o'clock");
    expect(calls[0].input).toBe("It's 5 o'clock; don't forget.");
    expect(calls.map((c) => c.cmd)).toEqual(["powershell", "say", "espeak"]);
  });
});

describe("Hey Jarvis in the app (wake phrase)", async () => {
  const { matchWake } = await import("../mobile/src/lib/wakephrase.js");
  it("finds the wake phrase and what follows it", () => {
    expect(matchWake("hey Jarvis what's on today")).toEqual({ rest: "what's on today" });
    expect(matchWake("Okay, Jarvis.")).toEqual({ rest: "" });
    expect(matchWake("Jarvis, remind me at 6")).toEqual({ rest: "remind me at 6" });
    expect(matchWake("so I said hey jervis open my mail")).toEqual({ rest: "open my mail" });
    expect(matchWake("hi Jarvis")).toEqual({ rest: "" });
  });
  it("ignores the name in ordinary talk", () => {
    expect(matchWake("I told Jarvis already")).toBeNull();
    expect(matchWake("hey there")).toBeNull();
    expect(matchWake("they jarvis")).toBeNull();
    expect(matchWake("")).toBeNull();
  });
});
