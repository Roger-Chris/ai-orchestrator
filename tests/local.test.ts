import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ModelRouter } from "../src/ai/route.js";
import { ToolRegistry } from "../src/ai/tools.js";
import { buildCapabilities } from "../src/brain/capabilities.js";
import { parseConfig } from "../src/config.js";
import type { Provider } from "../src/providers/base.js";
import { LocalProvider } from "../src/providers/local.js";
import { ProviderPool } from "../src/providers/registry.js";
import { Store } from "../src/store/db.js";
import type { ProviderId } from "../src/types.js";
import { Tts } from "../src/voice/tts.js";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));
afterEach(() => vi.unstubAllGlobals());

const tags = (names: string[] | null) => (async () => (names ? Response.json({ models: names.map((name) => ({ name })) }) : Promise.reject(new Error("ECONNREFUSED")))) as typeof fetch;

function fake(id: ProviderId, ready = true, cost?: number): Provider {
  return {
    id,
    detect: async () => ({ id, installed: ready, authenticated: ready }),
    run: async () => ({ ok: true, text: `${id} ok`, provider: id, durationMs: 4, usage: cost ? { costUsd: cost } : undefined }),
  };
}

function setup(raw: Record<string, unknown> = {}, local: Provider = fake("local")) {
  const dataDir = mkdtempSync(join(tmpdir(), "orc-local-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const config = parseConfig({ node: { name: "hub" }, dataDir, server: { token: "t" }, cluster: { enabled: false }, context: { graphify: "off" }, providers: { groq: { apiKeys: ["gk"] } }, ...raw });
  const store = new Store(dataDir);
  cleanup.unshift(() => store.close());
  const pool = new ProviderPool(config, store, { claude: fake("claude"), codex: fake("codex"), gemini: fake("gemini", false), perplexity: fake("perplexity", true, 0.03), groq: fake("groq"), local });
  const tools = new ToolRegistry({ config, pool, capabilities: buildCapabilities(), usage: () => store.usage(1), http: tags(["qwen3:8b", "gemma3:4b"]) });
  pool.capped = (id) => tools.capped(id);
  const models = new ModelRouter({ tools: () => tools.list(true), pool, store, node: "hub" });
  return { config, store, pool, tools, models, dataDir };
}

describe("local models (Ollama) as a provider", () => {
  it("is ready only when Ollama runs and has the model", async () => {
    expect(await new LocalProvider("http://127.0.0.1:11434", "qwen3:8b", tags(null)).detect()).toMatchObject({ installed: false, authenticated: false, detail: "Ollama is not running at http://127.0.0.1:11434" });
    expect(await new LocalProvider("http://x:11434", "qwen3:8b", tags(["llama3:8b"])).detect()).toMatchObject({ installed: true, authenticated: false, detail: "not pulled (ollama pull qwen3:8b)" });
    expect(await new LocalProvider("http://x:11434/", "qwen3", tags(["qwen3:latest"])).detect()).toMatchObject({ installed: true, authenticated: true, detail: "model qwen3 (Ollama)" });
  });

  it("talks to Ollama's OpenAI-compatible API", async () => {
    const seen: { url: string; body: any }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)) });
      const sse = ['data: {"choices":[{"delta":{"content":"hello "}}]}', 'data: {"choices":[{"delta":{"content":"there"}}]}', "data: [DONE]", ""].join("\n");
      return new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
    });
    const r = await new LocalProvider("http://box:11434/", "qwen3:8b").run({ prompt: "hi", system: "be brief" });
    expect(r).toMatchObject({ ok: true, text: "hello there", provider: "local" });
    expect(seen[0].url).toBe("http://box:11434/v1/chat/completions");
    expect(seen[0].body.model).toBe("qwen3:8b");
  });

  it("uses providers.local, else style.ollamaUrl / style.model", () => {
    const a = parseConfig({});
    expect(a.providers.local).toMatchObject({ enabled: true, maxConcurrent: 1 });
    expect(a.providers.local.model).toBeUndefined();
    const pool = new ProviderPool(parseConfig({ style: { ollamaUrl: "http://gpu:11434", model: "qwen3:14b" } }));
    expect(pool.providers.get("local")).toBeInstanceOf(LocalProvider);
  });

  it("is a last resort for the hub's jobs and scores low on hard work", async () => {
    const { models } = setup();
    expect((await models.routeFor("whatsapp_draft")).chain).toEqual(["claude", "codex", "groq", "local"]);
    expect((await models.routeFor("coding")).chain.at(-1)).not.toBe("claude");
    expect((await models.routeFor("coding")).chain[0]).toBe("claude");
  });
});

describe("spend caps per paid tool", () => {
  it("records what a call cost and adds the column to an old database", () => {
    const dir = mkdtempSync(join(tmpdir(), "orc-old-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const old = new DatabaseSync(join(dir, "orchestrator.db"));
    old.exec("CREATE TABLE usage (day TEXT NOT NULL, provider TEXT NOT NULL, node TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0, failed INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, provider, node))");
    old.close();
    const store = new Store(dir);
    store.recordUsage("perplexity", "hub", true, 100, 0.012);
    store.recordUsage("perplexity", "hub", true, 100, 0.02);
    store.recordUsage("perplexity", "hub", false, 100, Number.NaN);
    const row = (store.usage(1) as { provider: string; calls: number; cost_usd: number }[]).find((r) => r.provider === "perplexity")!;
    expect(row.calls).toBe(3);
    expect(row.cost_usd).toBeCloseTo(0.032);
    store.close();
  });

  it("a tool over its spend cap is skipped until tomorrow, everywhere", async () => {
    const s = setup({ tools: { overrides: { perplexity: { spendPerDay: 0.05 } } } });
    // the router records each call with what the service said it cost ($0.03 each here)
    expect((await s.models.run("research", { prompt: "q" })).provider).toBe("perplexity");
    expect((await s.models.run("research", { prompt: "q" })).provider).toBe("perplexity"); // $0.06 now
    const by = Object.fromEntries((await s.tools.list()).map((t) => [t.id, t]));
    expect(by.perplexity).toMatchObject({ state: "limit", limits: { spendPerDay: 0.05 }, usageToday: { calls: 2, spentUsd: 0.06 } });
    expect(by.perplexity.detail).toBe("spend cap of $0.05 a day reached ($0.06 today)");
    const r = await s.pool.run("perplexity", { prompt: "q" });
    expect(r).toMatchObject({ ok: false, error: "perplexity: spend cap of $0.05 a day reached ($0.06 today)" });
    expect(await s.pool.available()).not.toContain("perplexity");
    expect((await s.models.routeFor("research")).chain).not.toContain("perplexity");
    expect((await s.models.run("research", { prompt: "q" })).provider).not.toBe("perplexity");
  });

  it("estimates with costPerCall when the service doesn't report, and caps the speech services too", async () => {
    const s = setup({ tools: { overrides: { "tts:openai": { costPerCall: 0.02, spendPerDay: 0.03 }, groq: { perDay: 1 } } } });
    s.store.recordUsage("tts:openai", "hub", true, 300);
    expect(s.tools.capped("tts:openai")).toBeUndefined();
    s.store.recordUsage("tts:openai", "hub", true, 300);
    expect(s.tools.usageToday().get("tts:openai")?.spentUsd).toBe(0.04);
    expect(s.tools.capped("tts:openai")).toBe("spend cap of $0.03 a day reached ($0.04 today)");

    const calls: string[] = [];
    const http = (async (url: string) => {
      calls.push(String(url));
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "audio/mpeg" } });
    }) as unknown as typeof fetch;
    const tts = new Tts({ provider: "auto", order: ["openai"], maxChars: 600, openai: { apiKey: "k", baseUrl: "http://openai", model: "m", voice: "onyx" }, gemini: { baseUrl: "x", model: "m", voice: "Charon" }, groq: { keys: [], baseUrl: "x", model: "m", voice: "troy" } }, http);
    tts.capped = (id) => s.tools.capped(`tts:${id}`);
    await expect(tts.speak("hello")).rejects.toThrow(/speech services at their cap today \(OpenAI.*spend cap/);
    expect(calls).toEqual([]);

    // a daily call cap stops the pool too
    expect((await s.models.run("quick", { prompt: "a" }, { size: "small" })).provider).toBe("groq");
    expect((await s.models.run("quick", { prompt: "b" }, { size: "small" })).provider).not.toBe("groq");
    expect((await s.pool.run("groq", { prompt: "c" })).error).toBe("groq: daily cap of 1 reached");
  });
});
