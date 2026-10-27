import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { afterAll, describe, expect, it } from "vitest";
import { loadAgents } from "../src/agents/loader.js";
import { buildCapabilities } from "../src/brain/capabilities.js";
import { pickGoldfish } from "../src/brain/design.js";
import { Orchestrator, type OrchestratorExtras } from "../src/brain/orchestrator.js";
import { describeGraph, workspaceMap } from "../src/context/graphify.js";
import { Memory } from "../src/memory/memory.js";
import { Router } from "../src/brain/router.js";
import { Cluster } from "../src/cluster/cluster.js";
import { type Config, parseConfig } from "../src/config.js";
import type { Provider, SpawnOutcome } from "../src/providers/base.js";
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

function system(name: string, handlers: Partial<Record<ProviderId, Handler>>, peers: string[] = [], extras: (store: Store, config: Config) => OrchestratorExtras = () => ({})) {
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
  const orchestrator = new Orchestrator(config, store, cluster, router, loadAgents(["agents"]), extras(store, config));
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

describe("design mode (Elephant-Goldfish)", () => {
  const TASK = "Add offline sync to the notes app";
  const handlers = (prompts: Record<string, string[]>) => {
    const log = (id: string, p: string) => (prompts[id] ??= []).push(p);
    return {
      claude: (req: ProviderRequest) => {
        log("claude", req.prompt);
        if (req.prompt.includes("planning brain")) return { text: JSON.stringify({ goal: "g", synthesize: false, steps: [{ id: "s1", title: "Build it", agent: "coder", prompt: "build", dependsOn: [] }] }) };
        if (req.prompt.includes("ELEPHANT")) return { text: req.prompt.includes("REVISION") ? "# DESIGN v2" : "# DESIGN v1" };
        return { text: "BUILT" };
      },
      gemini: (req: ProviderRequest) => (log("gemini", req.prompt), { text: "1. [major] gap\nVERDICT: APPROVE WITH CHANGES" }),
      codex: (req: ProviderRequest) => (log("codex", req.prompt), { text: "1. [minor] nit\nVERDICT: APPROVE" }),
    };
  };

  it("drafts on Claude, reviews blind on Gemini and ChatGPT, revises, then builds only after approval", async () => {
    const prompts: Record<string, string[]> = {};
    const s = system("hub", handlers(prompts));
    const cwd = mkdtempSync(join(tmpdir(), "orc-design-"));
    dirs.push(cwd);
    const run = s.orchestrator.submit(TASK, { mode: "design", permission: "edit", cwd });
    const verdicts: string[][] = [];
    s.orchestrator.subscribe(run.id, (ev) => {
      if (ev.type !== "design.review_ready") return;
      const d = ev.data as { round: number; reviews: { verdict?: string }[] };
      verdicts.push(d.reviews.map((r) => r.verdict ?? ""));
      // Nothing is built while the design waits.
      expect(s.orchestrator.get(run.id)!.steps.some((x) => x.id.startsWith("impl-"))).toBe(false);
      s.orchestrator.decide(run.id, d.round === 1 ? { action: "revise", feedback: "use CRDTs" } : { action: "approve", notes: "fix the gap" });
    });
    const done = await s.orchestrator.wait(run.id)!;

    expect(done.status).toBe("done");
    const by = Object.fromEntries(done.steps.map((x) => [x.id, x]));
    expect(by["design-1"].provider).toBe("claude");
    expect(by["review-1-gemini"].provider).toBe("gemini");
    expect(by["review-1-codex"].provider).toBe("codex");
    expect(verdicts).toEqual([["APPROVE WITH CHANGES", "APPROVE"], ["APPROVE WITH CHANGES", "APPROVE"]]);
    // Goldfish see the document, never the request.
    for (const p of [...prompts.gemini, ...prompts.codex]) {
      expect(p).toContain("GOLDFISH");
      expect(p).not.toContain(TASK);
    }
    expect(prompts.gemini[1]).toContain("DESIGN v2");
    // The revision got the feedback and the reviews; the build got the approved design and notes.
    expect(prompts.claude.find((p) => p.includes("REVISION"))).toContain("use CRDTs");
    const planner = prompts.claude.find((p) => p.includes("planning brain"))!;
    expect(planner).toContain("# DESIGN v2");
    expect(planner).toContain("fix the gap");
    expect(by["impl-s1"].output).toBe("BUILT");
    expect(done.design?.savedTo).toBeTruthy();
    expect(readFileSync(done.design!.savedTo!, "utf8")).toContain("# DESIGN v2");
    expect(done.design!.savedTo).toContain(join("docs", "designs"));
  });

  it("can be cancelled while waiting for approval", async () => {
    const s = system("hub", handlers({}));
    const run = s.orchestrator.submit(TASK, { mode: "design" });
    s.orchestrator.subscribe(run.id, (ev) => ev.type === "design.review_ready" && s.orchestrator.cancel(run.id));
    const done = await s.orchestrator.wait(run.id)!;
    expect(done.status).toBe("cancelled");
    expect(done.steps.some((x) => x.id.startsWith("impl-"))).toBe(false);
    expect(s.orchestrator.decide(run.id, { action: "approve" })).toBe(false);
  });

  it("picks reviewers other than the author", () => {
    expect(pickGoldfish(["claude", "codex", "gemini", "perplexity"], "claude")).toEqual(["gemini", "codex"]);
    expect(pickGoldfish(["claude", "codex"], "claude")).toEqual(["codex"]);
    expect(pickGoldfish(["claude", "perplexity"], "claude")).toEqual(["claude"]);
  });
});

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

describe("access level", () => {
  it("the run's access is the ceiling: an agent's edit setting cannot raise a read-only run", async () => {
    const seen: string[] = [];
    const s = system("hub", { claude: (req) => (seen.push(req.permission ?? "?"), { text: "ok" }) });
    await s.orchestrator.runToCompletion("refactor this", { mode: "direct", agent: "coder" });
    await s.orchestrator.runToCompletion("refactor this", { mode: "direct", agent: "coder", permission: "full" });
    await s.orchestrator.runToCompletion("explain this", { mode: "direct", agent: "reviewer", permission: "edit" });
    expect(seen).toEqual(["read", "edit", "edit"]); // coder caps full at edit; reviewer has no own limit
  });
});

describe("memory and workspace map", () => {
  const PLAN1 = { goal: "g", synthesize: false, steps: [{ id: "a", title: "A", agent: "pcb-designer", prompt: "p", dependsOn: [] }] };

  it("recalls related past runs into the planner prompt", async () => {
    const planner: string[] = [];
    const s = system(
      "hub",
      {
        claude: (req) => {
          if (req.prompt.includes("planning brain")) planner.push(req.prompt);
          return { text: req.prompt.includes("planning brain") ? JSON.stringify(PLAN1) : "used an ESP32-S3 with a TP4056 charger" };
        },
      },
      [],
      (store, config) => ({ memory: new Memory(config, store) }),
    );
    await s.orchestrator.runToCompletion("Design an ESP32 sensor board PCB", { mode: "plan" });
    await s.orchestrator.runToCompletion("Make a 3D printed enclosure for the ESP32 sensor board", { mode: "plan" });
    expect(planner[0]).not.toContain("RELEVANT PAST RUNS (your memory)");
    expect(planner[1]).toContain("RELEVANT PAST RUNS (your memory)");
    expect(planner[1]).toContain("TP4056");
    expect(s.store.searchMemory("enclosure", 5).length).toBe(1);
  });

  it("mirrors runs to NotebookLM and asks it about new tasks", async () => {
    const calls: { args: string[]; stdin?: string }[] = [];
    const exec = async (o: { args: string[]; stdin?: string }): Promise<SpawnOutcome> => {
      calls.push({ args: o.args, stdin: o.stdin });
      const out = o.args[0] === "ask" ? JSON.stringify({ answer: "Last time you chose CRDTs." }) : "{}";
      return { code: 0, stdout: out, stderr: "", timedOut: false, aborted: false };
    };
    const s = system("hub", { claude: () => ({ text: "done" }) });
    const config = parseConfig({ memory: { notebooklm: { enabled: true, notebook: "nb123" } } });
    const mem = new Memory(config, s.store, exec as any);
    const run = await s.orchestrator.runToCompletion("Add offline sync", { mode: "direct" });
    await mem.remember(run);
    const add = calls.find((c) => c.args[0] === "source")!;
    expect(add.args).toEqual(expect.arrayContaining(["add", "--notebook", "nb123", "--type", "file"]));
    const recalled = await mem.recall("Add conflict resolution to offline sync");
    expect(recalled).toContain("Last time you chose CRDTs.");
    expect(calls.find((c) => c.args[0] === "ask")!.stdin).toContain("Add conflict resolution");
  });

  it("summarizes a Graphify graph into communities and files", () => {
    const map = describeGraph({
      nodes: [
        { id: "a", label: "Orchestrator", community: 0, community_name: "brain", source_file: "src/brain/orchestrator.ts" },
        { id: "b", label: "Router", community: 0, community_name: "brain", source_file: "src/brain/router.ts" },
        { id: "c", label: "Store", community: 1, community_name: "storage", source_file: "src\\store\\db.ts" },
      ],
      links: [{ source: "a", target: "b" }, { source: "a", target: "c" }],
    });
    expect(map.communities).toBe(2);
    expect(map.text).toContain("- brain (2 symbols): src/brain/orchestrator.ts, src/brain/router.ts");
    expect(map.text).toContain("src/store/db.ts");
    expect(map.text.split("\n").find((l) => l.startsWith("Most connected"))).toContain("Orchestrator");
  });

  it("rebuilds the code map only when the graph is older than HEAD", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "orc-graph-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, ".git"));
    mkdirSync(join(cwd, "graphify-out"));
    const graph = { built_at_commit: "abc1234", nodes: [{ id: "x", label: "X", source_file: "x.ts", community_name: "core" }], links: [] };
    writeFileSync(join(cwd, "graphify-out", "graph.json"), JSON.stringify(graph));
    const ran: string[] = [];
    const exec = (head: string) => async (o: { command: string; args: string[] }): Promise<SpawnOutcome> => {
      ran.push(o.command);
      return { code: 0, stdout: o.command === "git" ? `${head}\n` : "", stderr: "", timedOut: false, aborted: false };
    };
    const config = parseConfig({});
    expect((await workspaceMap(cwd, config, exec("abc1234ffff") as any))?.communities).toBe(1);
    expect(ran).toEqual(["git"]);
    ran.length = 0;
    await workspaceMap(cwd, config, exec("def5678aaaa") as any);
    expect(ran).toEqual(["git", "graphify"]);
    expect(await workspaceMap(mkdtempSync(join(tmpdir(), "orc-nogit-")), config, exec("x") as any)).toBeUndefined();
  });
});
