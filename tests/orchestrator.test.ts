import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterAll, describe, expect, it } from "vitest";
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
import type { ProviderId, ProviderRequest, ProviderResult } from "../src/types.js";

const stores: Store[] = [];
const dirs: string[] = [];
afterAll(() => {
  stores.forEach((s) => s.close());
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

type Handler = (req: ProviderRequest) => Partial<ProviderResult> | Promise<Partial<ProviderResult>>;

function fake(id: ProviderId, handler: Handler, calls: string[]): Provider {
  return {
    id,
    detect: async () => ({ id, installed: true, authenticated: true }),
    run: async (req) => {
      calls.push(id);
      const r = await handler(req);
      if (r.text) req.onDelta?.(r.text);
      return { ok: true, text: "", provider: id, durationMs: 5, ...r };
    },
  };
}

function system(name: string, handlers: Partial<Record<ProviderId, Handler>>, peers: string[] = []) {
  const dataDir = mkdtempSync(join(tmpdir(), "orc-test-"));
  dirs.push(dataDir);
  const config = parseConfig({
    node: { name, workRoot: join(dataDir, "work") },
    dataDir,
    server: { token: "secret-token" },
    cluster: { enabled: true, tailscale: false, peers },
  });
  const calls: string[] = [];
  const overrides = Object.fromEntries(Object.entries(handlers).map(([id, h]) => [id, fake(id as ProviderId, h!, calls)]));
  const store = new Store(dataDir);
  stores.push(store);
  const pool = new ProviderPool(config, store, overrides);
  // Only the faked providers exist in tests.
  for (const id of [...pool.providers.keys()]) if (!handlers[id]) pool.providers.delete(id);
  const cluster = new Cluster(config, pool);
  const router = new Router(buildCapabilities(), { localBias: 0.5, learn: true }, store);
  const orchestrator = new Orchestrator(config, store, cluster, router, loadAgents(["agents"]));
  return { config, store, pool, cluster, router, orchestrator, calls };
}

const PLAN = {
  goal: "x",
  synthesize: true,
  steps: [
    { id: "research", title: "Research parts", agent: "researcher", prompt: "find parts", dependsOn: [] },
    { id: "code", title: "Write firmware", agent: "coder", prompt: "write code", dependsOn: ["research"] },
    { id: "review", title: "Review firmware", agent: "reviewer", prompt: "review", dependsOn: ["code"], differentFrom: ["code"] },
  ],
};

describe("orchestrator", () => {
  it("plans, routes each step to the right model, cross-reviews and synthesizes", async () => {
    const s = system("hub", {
      claude: (req) => ({
        text: req.prompt.includes("planning brain") ? JSON.stringify(PLAN) : req.prompt.includes("Merge their work") ? "FINAL" : "code-by-claude",
      }),
      codex: () => ({ text: "review-by-codex" }),
      gemini: () => ({ text: "gemini" }),
      perplexity: () => ({ text: "parts-from-perplexity" }),
    });
    const run = await s.orchestrator.runToCompletion("Build firmware for a sensor board and research the parts", { mode: "plan" });
    expect(run.status).toBe("done");
    const by = Object.fromEntries(run.steps.map((x) => [x.id, x]));
    expect(by.research.provider).toBe("perplexity");
    expect(by.code.provider).toBe("claude");
    expect(by.review.provider).not.toBe("claude"); // cross-model review
    expect(run.result).toBe("FINAL");
  });

  it("passes upstream output into dependent steps", async () => {
    let codePrompt = "";
    const s = system("hub2", {
      claude: (req) => {
        if (req.prompt.includes("planning brain")) return { text: JSON.stringify(PLAN) };
        if (req.prompt.startsWith("write code")) codePrompt = req.prompt;
        return { text: "ok" };
      },
      codex: () => ({ text: "ok" }),
      perplexity: () => ({ text: "PARTS-LIST-123" }),
    });
    await s.orchestrator.runToCompletion("t", { mode: "plan" });
    expect(codePrompt).toContain("PARTS-LIST-123");
  });

  it("falls back when a subscription hits its usage limit, and cools it down", async () => {
    const s = system("hub3", {
      codex: () => ({ ok: false, error: "You've hit your usage limit. Try again in 2 hours.", rateLimited: true, retryAt: Date.now() + 7_200_000 }),
      gemini: () => ({ text: "answer-from-gemini" }),
    });
    const run = await s.orchestrator.runToCompletion("prove the theorem", { agent: "reasoner" });
    expect(run.status).toBe("done");
    expect(run.result).toBe("answer-from-gemini");
    expect(run.steps[0].attempts.map((a) => a.provider)).toEqual(["codex", "gemini"]);
    expect(s.pool.cooldownUntil("codex")).toBeGreaterThan(Date.now());
    expect(await s.pool.available()).not.toContain("codex");
  });

  it("fails cleanly when nothing can run the step", async () => {
    const s = system("hub4", { perplexity: () => ({ text: "x" }) });
    const run = await s.orchestrator.runToCompletion("refactor my code", { agent: "coder", permission: "edit" });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/no available model/);
  });

  it("runs steps on another device over HTTP (the Tailscale path)", async () => {
    // "laptop" has Gemini logged in; the hub only has Perplexity.
    const laptop = system("laptop", { gemini: (req) => ({ text: `remote:${req.permission}` }) });
    const app = createApp({ ...laptop, publicDir: "public" });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const hub = system("hub5", { perplexity: () => ({ text: "x" }) }, [`http://127.0.0.1:${port}`]);
      await hub.cluster.refresh();
      expect(hub.cluster.list().map((p) => p.name)).toEqual(["laptop"]);
      const run = await hub.orchestrator.runToCompletion("summarize this whole long document", { agent: "long-context-analyst" });
      expect(run.status).toBe("done");
      expect(run.steps[0].node).toBe("laptop");
      expect(run.result).toBe("remote:read"); // remote steps are always read-only
      expect(laptop.calls).toEqual(["gemini"]);
    } finally {
      server.close();
    }
  });

  it("requires the shared token for non-loopback callers", async () => {
    const s = system("auth", { gemini: () => ({ text: "x" }) });
    const app = createApp({ ...s, publicDir: "public" });
    // app.request() has no socket, so it is treated as a remote caller.
    expect((await app.request("/node/info")).status).toBe(401);
    expect((await app.request("/node/info", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await app.request("/node/info", { headers: { Authorization: "Bearer secret-token" } })).status).toBe(200);
  });
});
