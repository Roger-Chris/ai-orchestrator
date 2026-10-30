import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ModelRouter, RouteError, sizeOf } from "../src/ai/route.js";
import { ToolRegistry } from "../src/ai/tools.js";
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

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));

type Behaviour = { ready?: boolean; fail?: string; limited?: boolean; gate?: Promise<void> };

function provider(id: ProviderId, b: Behaviour, calls: ProviderId[]): Provider {
  const ready = b.ready ?? true;
  return {
    id,
    detect: async () => ({ id, installed: ready, authenticated: ready, version: ready ? "1.0" : undefined, detail: ready ? undefined : "not logged in" }),
    run: async (req) => {
      calls.push(id);
      await b.gate;
      if (b.fail) return { ok: false, text: "", provider: id, durationMs: 3, error: b.fail, rateLimited: b.limited };
      return { ok: true, text: `${id}: ${req.prompt.slice(0, 20)}`, provider: id, durationMs: 5 };
    },
  };
}

function setup(behave: Partial<Record<ProviderId, Behaviour>> = {}, raw: Record<string, unknown> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "orc-route-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const config = parseConfig({ node: { name: "hub" }, dataDir, server: { token: "secret-token" }, cluster: { enabled: false }, context: { graphify: "off" }, providers: { groq: { apiKeys: ["gk"], maxConcurrent: 1 } }, ...raw });
  const store = new Store(dataDir);
  cleanup.unshift(() => store.close());
  const calls: ProviderId[] = [];
  const b = { claude: {}, codex: {}, gemini: { ready: false }, perplexity: { ready: false }, groq: {}, local: { ready: false }, ...behave } as Record<ProviderId, Behaviour>;
  const pool = new ProviderPool(config, store, Object.fromEntries((Object.keys(b) as ProviderId[]).map((id) => [id, provider(id, b[id], calls)])) as Record<ProviderId, Provider>);
  const http = (async () => Response.json({ models: [] })) as typeof fetch;
  const tools = new ToolRegistry({ config, pool, capabilities: buildCapabilities(config.routing.overrides), usage: () => store.usage(1), http });
  const models = new ModelRouter({ tools: () => tools.list(), pool, store, node: "hub", routes: config.tools.routes });
  return { config, store, pool, tools, models, calls };
}

describe("model router", () => {
  it("sizes prompts", () => {
    expect(sizeOf("hi")).toBe("small");
    expect(sizeOf("x".repeat(5000))).toBe("medium");
    expect(sizeOf("x".repeat(30_000))).toBe("large");
  });

  it("follows each job's order and leaves out what can't work", async () => {
    const { models } = setup();
    const r = await models.routeFor("whatsapp_draft", "small");
    expect(r.chain).toEqual(["claude", "codex", "groq"]);
    // Perplexity (paid, web search) is never a fallback for the hub's own jobs
    expect(r.skipped).toEqual([
      { id: "gemini", why: "not set up" },
      { id: "local", why: "not set up" },
    ]);
    expect((await models.routeFor("mail")).chain).toEqual(["groq", "claude", "codex"]);
    expect((await models.routeFor("call")).chain).toEqual(["claude", "codex", "groq"]);
    expect((await models.routeFor("brain")).chain).toEqual(["codex", "claude", "groq"]);
  });

  it("skips a cooling tool and puts a busy one after the ready ones", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup({ groq: { gate } });
    s.pool.coolDown("claude", Date.now() + 3_600_000, "usage limit");
    const busy = s.pool.run("groq", { prompt: "x", permission: "read" });
    const r = await s.models.routeFor("mail");
    expect(r.chain).toEqual(["codex", "groq"]);
    expect(r.skipped[0].id).toBe("claude");
    expect(r.skipped[0].why).toMatch(/^cooling until \d\d:\d\d UTC$/);
    release();
    await busy;
  });

  it("an override goes first; strict means only that one", async () => {
    const { models } = setup();
    expect((await models.routeFor("mail", "medium", { override: "codex" })).chain).toEqual(["codex", "groq", "claude"]);
    expect((await models.routeFor("mail", "medium", { override: "codex", strict: true })).chain).toEqual(["codex"]);
    expect((await models.routeFor("mail", "medium", { override: "gemini", strict: true })).chain).toEqual([]);
    expect((await models.routeFor("mail", "medium", { override: "auto", strict: false })).chain[0]).toBe("groq");
  });

  it("a long prompt sends Groq to the end", async () => {
    const { models } = setup();
    const r = await models.routeFor("mail", "large");
    expect(r.chain).toEqual(["claude", "codex", "groq"]);
    expect(r.reason).toContain("Groq last");
  });

  it("orders a kind of work by score, cheaper first when close for a small job", async () => {
    const { models } = setup();
    expect((await models.routeFor("coding")).chain).toEqual(["claude", "codex", "groq"]);
    expect((await models.routeFor("writing", "medium")).chain).toEqual(["claude", "codex", "groq"]);
    // writing: codex 8 vs groq 7 is close, and Groq is free
    expect((await models.routeFor("writing", "small")).chain).toEqual(["claude", "groq", "codex"]);
    expect((await models.routeFor("quick", "small")).chain[0]).toBe("groq");
  });

  it("uses your order from config tools.routes, with the rest as last resorts", async () => {
    const { models } = setup({}, { tools: { routes: { whatsapp_draft: ["groq", "codex"] } } });
    const r = await models.routeFor("whatsapp_draft");
    expect(r.chain).toEqual(["groq", "codex", "claude"]);
    expect(r.reason).toContain("your order");
  });

  it("a daily cap set in tools.overrides takes a tool out", async () => {
    const s = setup({}, { tools: { overrides: { claude: { perDay: 1 } } } });
    s.store.recordUsage("claude", "hub", true, 10);
    const r = await s.models.routeFor("call");
    expect(r.chain).toEqual(["codex", "groq"]);
    expect(r.skipped).toContainEqual({ id: "claude", why: "daily cap of 1 reached" });
  });

  it("run() falls back on failure and records each try", async () => {
    const s = setup({ codex: { fail: "usage limit", limited: true } });
    const r = await s.models.run("brain", { prompt: "plan my day" });
    expect(r.provider).toBe("claude");
    expect(r.failed).toEqual([{ id: "codex", error: "usage limit" }]);
    expect(s.calls).toEqual(["codex", "claude"]);
    const usage = s.store.usage(1) as { provider: string; calls: number; failed: number }[];
    expect(usage.find((u) => u.provider === "codex")).toMatchObject({ calls: 1, failed: 1 });
    expect(usage.find((u) => u.provider === "claude")).toMatchObject({ calls: 1, failed: 0 });
  });

  it("run() says why when nothing can take the job", async () => {
    const s = setup({ claude: { ready: false }, codex: { ready: false }, groq: { ready: false } });
    await expect(s.models.run("call", { prompt: "x" })).rejects.toThrow(/no model can take this call job right now \(claude not set up/);
    const t = setup({ claude: { fail: "boom" }, codex: { fail: "limit", limited: true }, groq: { fail: "429", limited: true } });
    const e = await t.models.run("call", { prompt: "x" }).catch((x) => x);
    expect(e).toBeInstanceOf(RouteError);
    expect(e.rateLimited).toBe(false);
    expect(e.message).toContain("last: groq: 429");
  });

  it("raw:auto and GET /api/tools/route on the hub", async () => {
    const s = setup({ codex: { fail: "usage limit", limited: true } });
    const cluster = new Cluster(s.config, s.pool);
    const router = new Router(buildCapabilities(), { localBias: 0.5, learn: false }, s.store);
    const orchestrator = new Orchestrator(s.config, s.store, cluster, router, loadAgents(["agents"]), {});
    const app = createApp({ config: s.config, store: s.store, pool: s.pool, cluster, router, orchestrator, publicDir: ".", tools: s.tools, models: s.models });
    const auth = { Authorization: "Bearer secret-token", "Content-Type": "application/json" };
    const res = await app.request("/v1/chat/completions", { method: "POST", headers: auth, body: JSON.stringify({ model: "raw:auto", messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hello there" }] }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.model).toBe("raw:claude");
    expect(body.choices[0].message.content).toContain("claude");
    expect(orchestrator.active()).toEqual([]); // a plain call, not a run

    const route = await (await app.request("/api/tools/route?kind=mail&size=large", { headers: auth })).json();
    // codex hit its limit above, so the pool cooled it down and the router leaves it out
    expect(route).toMatchObject({ kind: "mail", size: "large", chain: ["claude", "groq"] });
    expect(route.skipped.map((x: { id: string }) => x.id)).toContain("codex");
    expect((await app.request("/api/tools/route?kind=nonsense", { headers: auth })).status).toBe(400);

    const models = await (await app.request("/v1/models", { headers: auth })).json();
    expect(models.data.map((m: { id: string }) => m.id)).toContain("raw:auto");

    const none = setup({ claude: { ready: false }, codex: { ready: false }, groq: { ready: false } });
    const app2 = createApp({ config: none.config, store: none.store, pool: none.pool, cluster, router, orchestrator, publicDir: ".", tools: none.tools, models: none.models });
    const r2 = await app2.request("/v1/chat/completions", { method: "POST", headers: auth, body: JSON.stringify({ model: "raw:auto", messages: [{ role: "user", content: "hi" }] }) });
    expect(r2.status).toBe(429);
  });
});
