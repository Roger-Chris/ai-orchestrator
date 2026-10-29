import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadAgents } from "../src/agents/loader.js";
import { buildCapabilities } from "../src/brain/capabilities.js";
import { Orchestrator } from "../src/brain/orchestrator.js";
import { Router } from "../src/brain/router.js";
import { Cluster } from "../src/cluster/cluster.js";
import { parseConfig } from "../src/config.js";
import { ProviderPool } from "../src/providers/registry.js";
import { createApp } from "../src/server/app.js";
import { Store } from "../src/store/db.js";
import { Tts, type TtsOptions, fitLength, geminiAudio, parseWav, splitForLimit, ttsFromConfig, wavFromPcm } from "../src/voice/tts.js";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));

const FMT = { channels: 1, sampleRate: 24_000, bitsPerSample: 16 };

function opts(over: Partial<TtsOptions> = {}): TtsOptions {
  return {
    provider: "auto",
    order: ["openai", "gemini", "groq"],
    maxChars: 600,
    openai: { apiKey: "sk-test", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-tts", voice: "onyx" },
    gemini: { apiKey: "g-test", baseUrl: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-tts", voice: "Charon" },
    groq: { keys: ["gk1", "gk2"], baseUrl: "https://api.groq.com/openai/v1", model: "canopylabs/orpheus-v1-english", voice: "troy" },
    ...over,
  };
}

type Call = { url: string; headers: Record<string, string>; body: any };

/** Fake speech services: `status[host]` makes that one fail with the status. */
function services(status: Record<string, number> = {}) {
  const calls: Call[] = [];
  const http = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body));
    calls.push({ url: url.toString(), headers: init?.headers as Record<string, string>, body });
    const fail = status[url.host];
    if (fail) return new Response("nope", { status: fail });
    if (url.host === "api.openai.com") return new Response(new Uint8Array([0xff, 0xfb, 1, 2]), { headers: { "Content-Type": "audio/mpeg" } });
    if (url.host === "api.groq.com") return new Response(wavFromPcm([new Uint8Array(body.input.length * 2)], FMT) as BodyInit, { headers: { "Content-Type": "audio/wav" } });
    const pcm = Buffer.from(new Uint8Array(100)).toString("base64");
    return Response.json({ steps: [{ type: "user_input" }, { type: "model_output", content: [{ type: "audio", data: pcm }] }] });
  }) as typeof fetch;
  return { http, calls };
}

describe("text to speech", () => {
  it("uses the first configured service, with its voice and model", async () => {
    const s = services();
    const tts = new Tts(opts(), s.http);
    const r = await tts.speak("Hello Kishaun.");
    expect(r).toMatchObject({ provider: "openai", voice: "onyx", mime: "audio/mpeg" });
    expect(s.calls[0].url).toBe("https://api.openai.com/v1/audio/speech");
    expect(s.calls[0].headers.Authorization).toBe("Bearer sk-test");
    expect(s.calls[0].body).toMatchObject({ model: "gpt-4o-mini-tts", voice: "onyx", input: "Hello Kishaun.", response_format: "mp3" });
  });

  it("reports each request for the tool registry's usage", async () => {
    const used: [string, boolean][] = [];
    const s = services({ "api.openai.com": 500 });
    await new Tts(opts(), s.http, Date.now, (p, ok) => used.push([p, ok])).speak("Hi.");
    expect(used).toEqual([["openai", false], ["gemini", true]]);
  });

  it("asks OpenAI for WAV when the player can't decode mp3 (the laptop's wake word listener)", async () => {
    const s = services();
    const r = await new Tts(opts(), s.http).speak("Hi.", { format: "wav" });
    expect(r.mime).toBe("audio/wav");
    expect(s.calls[0].body.response_format).toBe("wav");
  });

  it("honours the asked service and voice, and repeats a line from the cache", async () => {
    const s = services();
    const tts = new Tts(opts(), s.http);
    const r = await tts.speak("Your build passed.", { provider: "gemini", voice: "Kore" });
    expect(r).toMatchObject({ provider: "gemini", voice: "Kore", mime: "audio/wav" });
    expect(s.calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(s.calls[0].headers["x-goog-api-key"]).toBe("g-test");
    expect(s.calls[0].body.generation_config).toEqual({ speech_config: [{ voice: "Kore" }] });
    // raw PCM is wrapped in a 24 kHz mono WAV
    expect(parseWav(r.audio)).toMatchObject({ format: FMT });
    expect(parseWav(r.audio)!.data.length).toBe(100);
    await tts.speak("Your build passed.", { provider: "gemini", voice: "Kore" });
    expect(s.calls).toHaveLength(1);
  });

  it("falls back to the next service and rests the failing one", async () => {
    let t = 1_000;
    const s = services({ "api.openai.com": 401 });
    const tts = new Tts(opts(), s.http, () => t);
    const r = await tts.speak("One.");
    expect(r.provider).toBe("gemini");
    expect(tts.status().providers.find((p) => p.id === "openai")).toMatchObject({ ready: false, restingUntil: 1_000 + 3_600_000 });
    expect(tts.status().default).toEqual({ provider: "gemini", voice: "Charon" });
    await tts.speak("Two.");
    expect(s.calls.map((c) => new URL(c.url).host)).toEqual(["api.openai.com", "generativelanguage.googleapis.com", "generativelanguage.googleapis.com"]);
    // all resting: no call at all, the phone speaks
    const only = new Tts(opts({ provider: "openai" }), s.http, () => t);
    await expect(only.speak("x")).rejects.toMatchObject({ status: 502 });
    const n = s.calls.length;
    await expect(only.speak("y")).rejects.toMatchObject({ status: 503 });
    expect(s.calls.length).toBe(n);
    s.calls.splice(3);
    t += 3_600_001; // rested long enough: tried first again
    await tts.speak("Three.");
    expect(new URL(s.calls[3].url).host).toBe("api.openai.com");
  });

  it("splits long lines for Groq's 200 characters and joins the WAVs", async () => {
    const s = services();
    const tts = new Tts(opts({ provider: "groq" }), s.http);
    const text = `${"This sentence is about forty characters. ".repeat(6)}And a short end.`;
    const r = await tts.speak(text);
    expect(r.provider).toBe("groq");
    expect(s.calls.length).toBe(2);
    expect(s.calls.every((c) => c.body.input.length <= 200 && c.body.model === "canopylabs/orpheus-v1-english" && c.body.voice === "troy")).toBe(true);
    const total = s.calls.reduce((n, c) => n + c.body.input.length * 2, 0);
    expect(parseWav(r.audio)!.data.length).toBe(total);
    // keys rotate across pieces
    expect(s.calls.map((c) => c.headers.Authorization)).toEqual(["Bearer gk1", "Bearer gk2"]);
  });

  it("says why when nothing can speak, so the phone takes over", async () => {
    const none = new Tts(opts({ openai: { ...opts().openai, apiKey: undefined }, gemini: { ...opts().gemini, apiKey: undefined }, groq: { ...opts().groq, keys: [] } }));
    await expect(none.speak("hi")).rejects.toMatchObject({ status: 409 });
    expect(none.status()).toMatchObject({ enabled: false, default: null });
    const off = new Tts(opts({ provider: "off" }));
    await expect(off.speak("hi")).rejects.toMatchObject({ status: 409 });
    const s = services({ "api.openai.com": 500, "generativelanguage.googleapis.com": 429, "api.groq.com": 403 });
    await expect(new Tts(opts(), s.http).speak("hi")).rejects.toMatchObject({ status: 502, message: expect.stringContaining("Gemini: HTTP 429") });
  });

  it("text helpers: sentence cuts, piece limits, WAV parsing, Gemini answer shapes", () => {
    expect(fitLength("One two. Three four five six.", 12)).toBe("One two.");
    expect(fitLength("One two. Three four five six.", 20)).toBe("One two. Three four");
    expect(fitLength("short", 20)).toBe("short");
    expect(splitForLimit("A. B. C.", 4)).toEqual(["A.", "B.", "C."]);
    expect(splitForLimit("x".repeat(9), 4)).toEqual(["xxxx", "xxxx", "x"]);
    expect(splitForLimit("one two three four", 9)).toEqual(["one two", "three", "four"]);
    expect(parseWav(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(geminiAudio({ candidates: [{ content: { parts: [{ inlineData: { data: "QUJD" } }] } }] })).toBe("QUJD");
    expect(geminiAudio({})).toBeUndefined();
  });

  it("reads keys from the environment through parseConfig", () => {
    const prev = { o: process.env.OPENAI_API_KEY, g: process.env.GEMINI_API_KEY };
    process.env.OPENAI_API_KEY = "sk-env";
    process.env.GEMINI_API_KEY = "";
    try {
      const cfg = parseConfig({ providers: { groq: { apiKeys: ["k"] } } });
      expect(cfg.tts.openai.apiKey).toBe("sk-env");
      expect(cfg.tts.gemini.apiKey).toBeUndefined();
      expect(ttsFromConfig(cfg).candidates()).toEqual(["openai", "groq"]);
    } finally {
      process.env.OPENAI_API_KEY = prev.o;
      process.env.GEMINI_API_KEY = prev.g;
      if (prev.o === undefined) delete process.env.OPENAI_API_KEY;
      if (prev.g === undefined) delete process.env.GEMINI_API_KEY;
    }
  });
});

function hub(tts?: Tts) {
  const dataDir = mkdtempSync(join(tmpdir(), "orc-tts-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const config = parseConfig({ node: { name: "hub" }, dataDir, server: { token: "secret-token" }, cluster: { enabled: false }, context: { graphify: "off" } });
  const store = new Store(dataDir);
  cleanup.unshift(() => store.close());
  const pool = new ProviderPool(config, store, {});
  for (const id of [...pool.providers.keys()]) pool.providers.delete(id);
  const cluster = new Cluster(config, pool);
  const router = new Router(buildCapabilities(), { localBias: 0.5, learn: false }, store);
  const orchestrator = new Orchestrator(config, store, cluster, router, loadAgents(["agents"]), {});
  return createApp({ config, store, pool, cluster, router, orchestrator, publicDir: dataDir, tts });
}

describe("/api/tts", () => {
  const auth = { Authorization: "Bearer secret-token", "Content-Type": "application/json" };

  it("returns audio by POST and by GET, and lists services and voices", async () => {
    const s = services();
    const app = hub(new Tts(opts(), s.http));
    const post = await app.request("/api/tts", { method: "POST", headers: auth, body: JSON.stringify({ text: "Hello.", provider: "groq", voice: "diana" }) });
    expect(post.status).toBe(200);
    expect(post.headers.get("content-type")).toBe("audio/wav");
    expect(post.headers.get("x-tts-provider")).toBe("groq");
    expect(post.headers.get("x-tts-voice")).toBe("diana");
    expect(parseWav(new Uint8Array(await post.arrayBuffer()))).toBeTruthy();
    const get = await app.request(`/api/tts/audio?text=${encodeURIComponent("Hi there.")}`, { headers: auth });
    expect(get.headers.get("content-type")).toBe("audio/mpeg");
    expect([...new Uint8Array(await get.arrayBuffer())]).toEqual([0xff, 0xfb, 1, 2]);
    const status = await (await app.request("/api/tts", { headers: auth })).json();
    expect(status.enabled).toBe(true);
    expect(status.default).toEqual({ provider: "openai", voice: "onyx" });
    expect(status.providers.map((p: { id: string }) => p.id)).toEqual(["openai", "gemini", "groq"]);
    expect(status.providers[2].voices.length).toBeGreaterThan(3);
    expect(JSON.stringify(status)).not.toContain("sk-test"); // keys never leave the hub
  });

  it("tells the phone to speak itself when the hub can't, and needs the token", async () => {
    const app = hub();
    const r = await app.request("/api/tts", { method: "POST", headers: auth, body: JSON.stringify({ text: "Hello." }) });
    expect(r.status).toBe(409);
    expect((await r.json()).fallback).toBe("phone");
    expect((await (await app.request("/api/tts", { headers: auth })).json()).enabled).toBe(false);
    expect((await app.request("/api/tts", { method: "POST", headers: auth, body: JSON.stringify({}) })).status).toBe(400);
    const failing = hub(new Tts(opts({ provider: "openai" }), services({ "api.openai.com": 500 }).http));
    const f = await failing.request("/api/tts", { method: "POST", headers: auth, body: JSON.stringify({ text: "Hello." }) });
    expect(f.status).toBe(502);
    expect((await f.json()).fallback).toBe("phone");
    // the hub only trusts loopback without a token; app.request has no peer address, so expect 401
    expect((await app.request("/api/tts", { headers: { "Content-Type": "application/json" } })).status).toBe(401);
  });
});
