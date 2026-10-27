import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterAll, describe, expect, it } from "vitest";
import { loadAgents } from "../src/agents/loader.js";
import { buildCapabilities } from "../src/brain/capabilities.js";
import { Orchestrator } from "../src/brain/orchestrator.js";
import { Router } from "../src/brain/router.js";
import { detectTestCommand, git, runBranchJob } from "../src/cluster/branchwork.js";
import { Cluster } from "../src/cluster/cluster.js";
import { parseConfig } from "../src/config.js";
import type { Provider } from "../src/providers/base.js";
import { ProviderPool } from "../src/providers/registry.js";
import { createApp } from "../src/server/app.js";
import { Store } from "../src/store/db.js";
import type { BranchJob, ProviderId, ProviderRequest, ProviderResult } from "../src/types.js";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));

function tmp(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function sh(args: string[], cwd?: string) {
  const r = await git(args, cwd);
  if (!r.ok) throw new Error(`git ${args.join(" ")}: ${r.err}`);
  return r.out;
}

/** A bare "GitHub" plus your working clone with one commit, pushed. */
async function makeRepo(files: Record<string, string> = {}) {
  const root = tmp("orc-git-");
  const origin = join(root, "origin.git");
  const hub = join(root, "hub");
  await sh(["init", "--bare", "-b", "main", origin]);
  await sh(["clone", origin, hub]);
  await sh(["config", "user.name", "Test"], hub);
  await sh(["config", "user.email", "test@example.com"], hub);
  writeFileSync(join(hub, "README.md"), "# app\n");
  // Tests pass only once feature.txt says "fixed" (or does not exist yet).
  writeFileSync(join(hub, "check.js"), "const fs=require('fs');process.exit(!fs.existsSync('feature.txt')||fs.readFileSync('feature.txt','utf8').includes('fixed')?0:1)\n");
  for (const [f, c] of Object.entries(files)) writeFileSync(join(hub, f), c);
  await sh(["add", "-A"], hub);
  await sh(["commit", "-q", "-m", "init"], hub);
  await sh(["push", "-q", "origin", "HEAD:main"], hub);
  return { root, origin, hub, head: await sh(["rev-parse", "HEAD"], hub) };
}

type Handler = (req: ProviderRequest) => Partial<ProviderResult> | Promise<Partial<ProviderResult>>;

function system(name: string, handlers: Partial<Record<ProviderId, Handler>>, raw: Record<string, unknown> = {}) {
  const dataDir = tmp("orc-data-");
  const config = parseConfig({
    node: { name, workRoot: join(dataDir, "work"), ...(raw.node as object) },
    dataDir,
    server: { token: "secret-token" },
    cluster: { enabled: true, tailscale: false, ...(raw.cluster as object) },
    branches: { testCommand: "node check.js" },
    context: { graphify: "off" },
  });
  const calls: string[] = [];
  const fakes = Object.fromEntries(
    Object.entries(handlers).map(([id, h]) => [
      id,
      {
        id,
        detect: async () => ({ id, installed: true, authenticated: true }),
        run: async (req: ProviderRequest) => {
          calls.push(id);
          return { ok: true, text: "", provider: id, durationMs: 5, ...(await h!(req)) };
        },
      } as Provider,
    ]),
  );
  const store = new Store(dataDir);
  cleanup.unshift(() => store.close());
  const pool = new ProviderPool(config, store, fakes);
  for (const id of [...pool.providers.keys()]) if (!handlers[id]) pool.providers.delete(id);
  const cluster = new Cluster(config, pool);
  const router = new Router(buildCapabilities(), { localBias: 0.5, learn: false }, store);
  const orchestrator = new Orchestrator(config, store, cluster, router, loadAgents(["agents"]));
  return { config, store, pool, cluster, router, orchestrator, calls };
}

const job = (repo: { origin: string; head: string }, over: Partial<BranchJob> = {}): BranchJob => ({
  repoUrl: repo.origin,
  base: repo.head,
  branch: "orc/test-s1",
  title: "Add the feature",
  provider: "claude",
  prompt: "add feature.txt",
  testCommand: "node check.js",
  ...over,
});

describe("branch jobs", { timeout: 60_000 }, () => {
  it("clones, edits on a branch, runs the tests, lets the model fix a failure, commits and pushes", async () => {
    const repo = await makeRepo();
    const prompts: string[] = [];
    const pool = {
      run: async (_p: ProviderId, req: ProviderRequest): Promise<ProviderResult> => {
        prompts.push(req.prompt);
        expect(req.permission).toBe("edit");
        writeFileSync(join(req.cwd!, "feature.txt"), prompts.length === 1 ? "broken\n" : "fixed\n");
        return { ok: true, text: `edit ${prompts.length}`, provider: "claude", durationMs: 1 };
      },
    };
    const notes: string[] = [];
    const r = await runBranchJob(job(repo, { files: ["feature.txt"] }), {
      pool,
      workRoot: tmp("orc-work-"),
      nodeName: "linux-box",
      testTimeoutMs: 60_000,
      fixAttempts: 1,
      onProgress: (n) => notes.push(n),
    });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.pushed).toBe(true);
    expect(r.changedFiles).toEqual(["feature.txt"]);
    expect(r.tests?.ok).toBe(true);
    expect(prompts).toHaveLength(2); // the edit, then the fix after the failing test run
    expect(prompts[0]).toContain("- feature.txt"); // owned files
    expect(prompts[1]).toContain("The tests fail");
    expect(notes).toContain("tests failed");
    const remote = await sh(["ls-remote", repo.origin, "refs/heads/orc/test-s1"]);
    expect(remote.split(/\s+/)[0]).toBe(r.commit);
    expect(r.diff).toContain("+fixed");
  });

  it("pushes nothing when the model changes nothing", async () => {
    const repo = await makeRepo();
    const r = await runBranchJob(job(repo), {
      pool: { run: async () => ({ ok: true, text: "nothing to do", provider: "claude", durationMs: 1 }) },
      workRoot: tmp("orc-work-"),
      nodeName: "mac",
      testTimeoutMs: 60_000,
      fixAttempts: 0,
    });
    expect(r.ok).toBe(true);
    expect(r.pushed).toBe(false);
    expect(await sh(["ls-remote", repo.origin, "refs/heads/orc/*"])).toBe("");
  });

  it("detects common test commands", () => {
    const d = tmp("orc-detect-");
    expect(detectTestCommand(d)).toBeUndefined();
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    expect(detectTestCommand(d)).toBe("npm install && npm test");
    writeFileSync(join(d, "package-lock.json"), "{}");
    expect(detectTestCommand(d)).toBe("npm ci && npm test");
    writeFileSync(join(d, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(detectTestCommand(d)).toBeUndefined();
  });
});

describe("branch work across devices", { timeout: 60_000 }, () => {
  it("a worker takes the coding step on its own branch; the laptop merges it", async () => {
    const repo = await makeRepo();
    const worker = system("linux-box", { claude: (req) => (writeFileSync(join(req.cwd!, "feature.txt"), "fixed by worker\n"), { text: "added feature.txt" }) }, { node: { acceptBranchWork: true } });
    const server = serve({ fetch: createApp({ ...worker, publicDir: "public" }).fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise((r) => server.once("listening", r));
    cleanup.unshift(() => server.close());
    const port = (server.address() as AddressInfo).port;

    // The laptop has no coding model logged in, so the step must go to the worker.
    const laptop = system("laptop", { perplexity: () => ({ text: "x" }) }, { cluster: { peers: [`http://127.0.0.1:${port}`] } });
    await laptop.cluster.refresh();
    expect(laptop.cluster.list()[0].branchWork).toBe(true);

    const run = await laptop.orchestrator.runToCompletion("Add the feature file", { mode: "direct", agent: "coder", permission: "edit", cwd: repo.hub, branches: true });
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("done");
    const step = run.steps[0];
    expect(step.node).toBe("linux-box");
    expect(step.branch?.name).toBe(`orc/${run.id}-s1`);
    expect(step.branch?.tests?.ok).toBe(true);
    expect(run.result).toContain("Branches to review and merge");
    // Your folder is untouched until you merge.
    expect(existsSync(join(repo.hub, "feature.txt"))).toBe(false);

    expect(await laptop.orchestrator.mergeBranch(run.id, "s1")).toEqual({ ok: true });
    expect(readFileSync(join(repo.hub, "feature.txt"), "utf8")).toContain("fixed by worker");
    expect(laptop.orchestrator.get(run.id)!.steps[0].branch?.merged).toBe(true);
  });

  it("a dependent step builds on the branch of the step before it", async () => {
    const repo = await makeRepo();
    const PLAN = {
      goal: "g",
      synthesize: false,
      steps: [
        { id: "api", title: "API", agent: "coder", prompt: "STEP ONE: write api.txt", dependsOn: [], files: ["api.txt"] },
        { id: "ui", title: "UI", agent: "coder", prompt: "STEP TWO: write ui.txt", dependsOn: ["api"], files: ["ui.txt"] },
      ],
    };
    let sawApi = false;
    const hub = system("laptop", {
      claude: (req) => {
        if (req.prompt.includes("planning brain")) return { text: JSON.stringify(PLAN) };
        if (req.prompt.includes("STEP ONE")) writeFileSync(join(req.cwd!, "api.txt"), "api\n");
        if (req.prompt.includes("STEP TWO")) {
          sawApi = existsSync(join(req.cwd!, "api.txt"));
          writeFileSync(join(req.cwd!, "ui.txt"), "ui\n");
        }
        return { text: "ok" };
      },
    });
    const run = await hub.orchestrator.runToCompletion("Build the API and the UI", { mode: "plan", permission: "edit", cwd: repo.hub, branches: true });
    expect(run.error).toBeUndefined();
    expect(sawApi).toBe(true);
    expect(run.steps.map((s) => s.branch?.changedFiles)).toEqual([["api.txt"], ["api.txt", "ui.txt"]]);
    for (const s of run.steps) expect(await hub.orchestrator.mergeBranch(run.id, s.id)).toEqual({ ok: true });
    expect(existsSync(join(repo.hub, "api.txt")) && existsSync(join(repo.hub, "ui.txt"))).toBe(true);
  });

  it("pushes your unpublished commit as a base branch so devices can fetch it", async () => {
    const repo = await makeRepo();
    writeFileSync(join(repo.hub, "local.txt"), "not pushed\n");
    await sh(["add", "-A"], repo.hub);
    await sh(["commit", "-q", "-m", "local only"], repo.hub);
    const hub = system("laptop", { claude: (req) => (writeFileSync(join(req.cwd!, "feature.txt"), "fixed\n"), { text: "ok" }) });
    const run = await hub.orchestrator.runToCompletion("Add the feature", { mode: "direct", agent: "coder", permission: "edit", cwd: repo.hub, branches: true });
    expect(run.status).toBe("done");
    expect(await sh(["ls-remote", repo.origin, `refs/heads/orc/${run.id}/base`])).not.toBe("");
    expect(run.steps[0].branch?.changedFiles).toEqual(["feature.txt"]);
  });

  it("refuses branch work without edit access or without a git remote", async () => {
    const repo = await makeRepo();
    const hub = system("laptop", { claude: () => ({ text: "ok" }) });
    const ro = await hub.orchestrator.runToCompletion("x", { mode: "direct", permission: "read", cwd: repo.hub, branches: true });
    expect(ro.error).toMatch(/Edit files or Full/);
    const plain = await hub.orchestrator.runToCompletion("x", { mode: "direct", permission: "edit", cwd: tmp("orc-plain-"), branches: true });
    expect(plain.error).toMatch(/remote/);
  });

  it("a device only takes branch jobs when it has opted in, and only on orc/ branches", async () => {
    const off = system("mac", { claude: () => ({ text: "ok" }) });
    const auth = { Authorization: "Bearer secret-token", "Content-Type": "application/json" };
    const body = JSON.stringify(job({ origin: "x", head: "abc1234" }));
    expect((await createApp({ ...off, publicDir: "public" }).request("/node/branch-job", { method: "POST", headers: auth, body })).status).toBe(403);
    const on = system("mac2", { claude: () => ({ text: "ok" }) }, { node: { acceptBranchWork: true } });
    const bad = JSON.stringify(job({ origin: "x", head: "abc1234" }, { branch: "main" }));
    expect((await createApp({ ...on, publicDir: "public" }).request("/node/branch-job", { method: "POST", headers: auth, body: bad })).status).toBe(400);
  });
});
