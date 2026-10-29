import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ToolRegistry, strengthsOf } from "../src/ai/tools.js";
import { loadAgents } from "../src/agents/loader.js";
import { buildCapabilities } from "../src/brain/capabilities.js";
import { Orchestrator } from "../src/brain/orchestrator.js";
import { Router } from "../src/brain/router.js";
import { Cluster } from "../src/cluster/cluster.js";
import { parseConfig } from "../src/config.js";
import type { Provider } from "../src/providers/base.js";
import { ProviderPool } from "../src/providers/registry.js";
import { createApp } from "../src/server/app.js";
import { Store } from "../src/store/db.js";
import type { ProviderId } from "../src/types.js";
import { Tts } from "../src/voice/tts.js";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));

const NOW = Date.UTC(2026, 9, 29, 15, 0, 0);

function provider(id: ProviderId, ready: boolean, gate?: Promise<void>): Provider {
  return {
    id,
    detect: async () => ({ id, installed: ready, authenticated: ready, version: ready ? "1.0" : undefined, detail: ready ? undefined : "not logged in" }),
    run: async () => {
      await gate;
      return { ok: true, text: "ok", provider: id, durationMs: 5 };
    },
  };
}

function setup(raw: Record<string, unknown> = {}, ollama: string[] | null = ["qwen3:8b", "llava:7b"]) {
  const dataDir = mkdtempSync(join(tmpdir(), "orc-tools-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const config = parseConfig({ node: { name: "hub" }, dataDir, server: { token: "secret-token" }, cluster: { enabled: false }, context: { graphify: "off" }, providers: { groq: { apiKeys: ["gk"], maxConcurrent: 1 } }, ...raw });
  const store = new Store(dataDir);
  cleanup.unshift(() => store.close());
  const pool = new ProviderPool(config, store, { claude: provider("claude", true), codex: provider("codex", true), gemini: provider("gemini", false), perplexity: provider("perplexity", false), groq: provider("groq", true) });
  const http = (async () => (ollama ? Response.json({ models: ollama.map((name) => ({ name })) }) : Promise.reject(new Error("ECONNREFUSED")))) as typeof fetch;
  const tts = new Tts({ provider: "auto", order: ["openai", "gemini", "groq"], maxChars: 600, openai: { baseUrl: "x", model: "m", voice: "onyx" }, gemini: { baseUrl: "x", model: "m", voice: "Charon" }, groq: { keys: ["gk"], baseUrl: "x", model: "m", voice: "troy" } });
  const registry = new ToolRegistry({ config, pool, capabilities: buildCapabilities(config.routing.overrides), usage: () => store.usage(1), tts, http, now: () => NOW });
  return { config, store, pool, registry };
}

const day = new Date(NOW).toISOString().slice(0, 10);

describe("tool registry", () => {
  it("lists every tool with its cost class, strengths and live state", async () => {
    const { registry } = setup();
    const tools = await registry.list();
    const by = Object.fromEntries(tools.map((t) => [t.id, t]));
    expect(Object.keys(by)).toEqual(["claude", "codex", "gemini", "perplexity", "groq", "whisper:groq", "tts:openai", "tts:gemini", "tts:groq", "ollama:qwen3:8b", "ollama:gemma3:4b"]);
    expect(by.claude).toMatchObject({ kind: "agent", cost: "subscription", agentic: true, state: "ready", limits: { maxConcurrent: 2 } });
    expect(by.claude.strengths.slice(0, 3)).toEqual(["system_design", "coding", "debugging"]);
    expect(by.groq).toMatchObject({ kind: "chat", cost: "free", agentic: false, state: "ready" });
    expect(by.groq.strengths).toEqual(["quick"]);
    expect(by.perplexity).toMatchObject({ cost: "paid", state: "not_set_up", detail: "not logged in", strengths: ["research"] });
    expect(by["whisper:groq"]).toMatchObject({ kind: "transcribe", cost: "free", state: "ready", detail: "whisper-large-v3-turbo" });
    expect(by["tts:openai"]).toMatchObject({ kind: "speech", cost: "paid", state: "not_set_up" });
    expect(by["tts:groq"]).toMatchObject({ state: "ready", detail: "voice troy" });
    expect(by["ollama:qwen3:8b"]).toMatchObject({ kind: "chat", cost: "local", state: "ready" });
    expect(by["ollama:gemma3:4b"]).toMatchObject({ kind: "vision", state: "not_set_up", detail: "not pulled (ollama pull gemma3:4b)" });
  });

  it("shows cooling, busy and today's usage", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup();
    s.pool.providers.set("groq", provider("groq", true, gate));
    s.pool.coolDown("codex", Date.now() + 3_600_000, "usage limit");
    const running = s.pool.run("groq", { prompt: "hi", permission: "read" });
    s.store.recordUsage("claude", "hub", true, 1000);
    s.store.recordUsage("claude", "laptop", false, 3000);
    s.store.recordUsage("tts:groq", "hub", true, 400);
    // the usage table keys days by the real clock, so this registry uses it too
    const live = new ToolRegistry({ config: s.config, pool: s.pool, capabilities: buildCapabilities(), usage: () => s.store.usage(1), tts: undefined });
    const by = Object.fromEntries((await live.list()).map((t) => [t.id, t]));
    expect(by.codex.state).toBe("cooling");
    expect(by.codex.until).toBeGreaterThan(Date.now());
    expect(by.groq).toMatchObject({ state: "busy", load: 1 });
    expect(by.claude.usageToday).toEqual({ calls: 2, failed: 1, avgMs: 2000 });
    expect(by["tts:groq"]).toMatchObject({ state: "off", usageToday: { calls: 1, failed: 0, avgMs: 400 } }); // no Tts given: off
    release();
    await running;
  });

  it("counts usage for the registry's day only", () => {
    const rows = [
      { day, provider: "claude", node: "hub", calls: 3, ok: 3, failed: 0, duration_ms: 300 },
      { day: "2026-10-28", provider: "claude", node: "hub", calls: 9, ok: 9, failed: 0, duration_ms: 900 },
      { day, provider: "claude", node: "laptop", calls: 1, ok: 0, failed: 1, duration_ms: 100 },
    ];
    const s = setup();
    const r = new ToolRegistry({ config: s.config, pool: s.pool, capabilities: buildCapabilities(), usage: () => rows, now: () => NOW });
    expect(r.usageToday().get("claude")).toEqual({ calls: 4, failed: 1, avgMs: 100 });
  });

  it("applies config overrides: cost, daily cap, turned off", async () => {
    const s = setup({ tools: { overrides: { perplexity: { cost: "subscription" }, claude: { perDay: 2 }, "tts:groq": { enabled: false } } } });
    const rows = [{ day, provider: "claude", node: "hub", calls: 2, ok: 2, failed: 0, duration_ms: 10 }];
    const r = new ToolRegistry({ config: s.config, pool: s.pool, capabilities: buildCapabilities(), usage: () => rows, now: () => NOW });
    const by = Object.fromEntries((await r.list()).map((t) => [t.id, t]));
    expect(by.perplexity.cost).toBe("subscription");
    expect(by.claude).toMatchObject({ state: "limit", until: Date.UTC(2026, 9, 30), limits: { perDay: 2 } });
    expect(by["tts:groq"].state).toBe("off");
  });

  it("says when Ollama isn't running", async () => {
    const { registry } = setup({}, null);
    const t = (await registry.list()).find((x) => x.id === "ollama:qwen3:8b")!;
    expect(t).toMatchObject({ state: "not_set_up", detail: "Ollama is not running here" });
  });

  it("strengths are the kinds scored 8.5 or more, best first", () => {
    expect(strengthsOf({ coding: 9, quick: 8.5, writing: 7, research: 10 })).toEqual(["research", "coding", "quick"]);
  });

  it("GET /api/tools", async () => {
    const s = setup();
    const store = s.store;
    const cluster = new Cluster(s.config, s.pool);
    const router = new Router(buildCapabilities(), { localBias: 0.5, learn: false }, store);
    const orchestrator = new Orchestrator(s.config, store, cluster, router, loadAgents(["agents"]), {});
    const app = createApp({ config: s.config, store, pool: s.pool, cluster, router, orchestrator, publicDir: ".", tools: s.registry });
    const r = await (await app.request("/api/tools?fresh=1", { headers: { Authorization: "Bearer secret-token" } })).json();
    expect(r.tools.length).toBe(11);
    expect(JSON.stringify(r)).not.toContain("gk"); // keys never leave the hub
    const none = createApp({ config: s.config, store, pool: s.pool, cluster, router, orchestrator, publicDir: "." });
    expect((await none.request("/api/tools", { headers: { Authorization: "Bearer secret-token" } })).status).toBe(404);
  });
});
