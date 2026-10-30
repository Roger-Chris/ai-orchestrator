import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import { BuildDesk, type BuildRunner, buildTask } from "../src/builds/desk.js";
import { newestApk, PreviewMaker } from "../src/builds/preview.js";
import { mountBuilds, previewer } from "../src/server/builds.js";
import { MemoryReplica } from "../src/shared/replica.js";
import { Store } from "../src/store/db.js";
import type { PushPayload } from "../src/server/push.js";
import type { RunOptions, RunRecord } from "../src/types.js";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));
const tmp = (p = "orc-build-") => {
  const d = mkdtempSync(join(tmpdir(), p));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

/** A runner that records runs and lets the test finish them. */
function fakeRunner() {
  const runs: { task: string; options: RunOptions; resolve: (r: RunRecord) => void; record: RunRecord }[] = [];
  const merges: string[] = [];
  const runner: BuildRunner = {
    submit(task, options) {
      const record: RunRecord = { id: `r${runs.length + 1}`, task, options, status: "running", steps: [], createdAt: Date.now() };
      let resolve!: (r: RunRecord) => void;
      const done = new Promise<RunRecord>((r) => (resolve = r));
      runs.push({ task, options, resolve, record });
      (record as any)._done = done;
      return record;
    },
    wait: (id) => (runs.find((r) => r.record.id === id)?.record as any)?._done,
    get: (id) => runs.find((r) => r.record.id === id)?.record,
    cancel: () => true,
    mergeBranch: async (runId, step) => {
      merges.push(`${runId}/${step}`);
      return step === "conflict" ? { ok: false, error: "merge stopped (nothing changed): conflict" } : { ok: true };
    },
  };
  return { runner, runs, merges };
}

const branchStep = (id: string, name: string, ok = true) => ({
  id,
  title: `code ${id}`,
  kind: "coding",
  status: "done",
  attempts: [],
  branch: { name, base: "main", node: "omen", commit: "abc", changedFiles: ["a.ts", "b.ts"], diffStat: "", diff: "", tests: { command: "npm test", ok, output: "" }, pushed: true },
});

function setup() {
  const dir = tmp();
  const repo = join(dir, "app");
  mkdirSync(repo);
  const store = new Store(join(dir, "data"));
  cleanup.unshift(() => store.close());
  const replica = new MemoryReplica(join(dir, "m.db"), "hub");
  const pushes: PushPayload[] = [];
  const ready: string[] = [];
  const f = fakeRunner();
  const desk = new BuildDesk({ store, runner: f.runner, replica, notify: (p) => pushes.push(p), onReady: (b) => ready.push(b.id), node: "hub" });
  return { dir, repo, store, replica, pushes, ready, desk, ...f };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

describe("builds (phase 2)", () => {
  it("B1: starts a branch run with tests and a second model's review", () => {
    const s = setup();
    const b = s.desk.start({ name: "Expense Tracker", spec: "Track my expenses with a web page", repo: s.repo });
    expect(b).toMatchObject({ name: "Expense Tracker", status: "running", agent: "claude", reviewer: "codex", runId: "r1" });
    expect(b.previewKey).toMatch(/^[0-9a-f]{32}$/);
    expect(s.runs[0].options).toEqual({ branches: true, permission: "edit", cwd: s.repo, nodes: undefined, mode: "plan" });
    expect(s.runs[0].task).toContain('BUILD THE APP "Expense Tracker"');
    expect(s.runs[0].task).toContain("review step with codex");
    expect(s.runs[0].task).toContain("Write tests");
    expect(s.desk.start({ name: "x", spec: "y", repo: s.repo, agent: "codex", reviewer: "codex", node: "mac" })).toMatchObject({ agent: "codex", reviewer: "claude", node: "mac" });
    expect(s.runs[1].options.nodes).toEqual(["mac"]);
    expect(() => s.desk.start({ name: "x", spec: "y", repo: join(s.dir, "nope") })).toThrow(/folder not found/);
    expect(() => s.desk.start({ name: "x", spec: "y" })).toThrow(/which folder/);
  });

  it("a finished run makes the build ready, tells the phone and writes the shared memory (B3)", async () => {
    const s = setup();
    const b = s.desk.start({ name: "Expense Tracker", spec: "Track expenses", repo: s.repo });
    s.runs[0].resolve({ ...s.runs[0].record, status: "done", result: "Built it.", steps: [branchStep("s1", "orc/r1-s1") as any, { id: "rev", title: "review", status: "done" } as any] });
    await settle();
    const got = s.desk.get(b.id)!;
    expect(got).toMatchObject({ status: "ready", summary: "Built it.", branches: [{ step: "s1", name: "orc/r1-s1", tests: "passed", files: 2 }] });
    expect(s.pushes[0]).toMatchObject({ title: "Expense Tracker: ready to review", url: `/builds?id=${b.id}` });
    expect(s.ready).toEqual([b.id]);
    const project = s.replica.get("project:expense-tracker")!;
    expect(project).toMatchObject({ kind: "project", title: "Expense Tracker" });
    expect(project.data).toMatchObject({ repo: s.repo, agent: "claude", lastBuild: b.id, status: "ready", builds: 1 });
    expect(s.replica.get(`work:build-${b.id}`)?.subject).toBe("project:expense-tracker");
  });

  it("a run without a branch fails the build", async () => {
    const s = setup();
    const b = s.desk.start({ name: "a", spec: "b", repo: s.repo });
    s.runs[0].resolve({ ...s.runs[0].record, status: "done", steps: [] });
    await settle();
    expect(s.desk.get(b.id)).toMatchObject({ status: "failed", error: "the run finished without pushing a branch (nothing changed)" });
    expect(s.ready).toEqual([]);
  });

  it("B3: continue the X app reuses its folder and agents and starts from its branch", async () => {
    const s = setup();
    const first = s.desk.start({ name: "Expense Tracker", spec: "Track expenses", repo: s.repo, agent: "codex", node: "omen" });
    s.runs[0].resolve({ ...s.runs[0].record, status: "done", steps: [branchStep("s1", "orc/r1-s1") as any] });
    await settle();
    const next = s.desk.start({ name: "the expense tracker app", spec: "Add a monthly chart", continue: true });
    expect(next).toMatchObject({ name: "the expense tracker app", repo: s.repo, agent: "codex", reviewer: "claude", node: "omen", continuedFrom: first.id });
    expect(s.runs[1].task).toContain("THIS CONTINUES AN EARLIER BUILD");
    expect(s.runs[1].task).toContain("build on top of orc/r1-s1");
    expect(() => s.desk.start({ name: "never built", spec: "x", continue: true })).toThrow(/no earlier build/);
  });

  it("B3: continues from the shared memory when another hub built it", () => {
    const s = setup();
    s.replica.put({ uid: "project:garden-log", kind: "project", title: "Garden Log", data: { repo: s.repo, agent: "claude", reviewer: "gemini", spec: "log plants", branches: [{ name: "orc/x", merged: true }] } });
    const b = s.desk.start({ name: "Garden Log", spec: "photos", continue: true });
    expect(b).toMatchObject({ repo: s.repo, reviewer: "gemini" });
    expect(s.runs[0].task).toContain("orc/x (merged)");
  });

  it("B2: merge is all-or-reported, and only for a ready build", async () => {
    const s = setup();
    const b = s.desk.start({ name: "a", spec: "b", repo: s.repo });
    await expect(s.desk.merge(b.id)).rejects.toThrow(/only a ready build/);
    s.runs[0].resolve({ ...s.runs[0].record, status: "done", steps: [branchStep("s1", "orc/1") as any, branchStep("conflict", "orc/2") as any] });
    await settle();
    let m = await s.desk.merge(b.id);
    expect(m.status).toBe("ready");
    expect(m.mergeError).toContain("orc/2: merge stopped");
    expect(m.branches[0].merged).toBe(true);
    // the second branch fixed by hand: merging again only tries what is left
    (s.runner as any).mergeBranch = async () => ({ ok: true });
    m = await s.desk.merge(b.id);
    expect(m.status).toBe("merged");
    expect(s.merges).toEqual(["r1/s1", "r1/conflict"]);
  });

  it("the task text", () => {
    const t = buildTask({ name: "X", spec: "do it", agent: "claude", reviewer: "codex" });
    expect(t).toContain("Never touch the main branch");
    expect(t).toContain("npm run build");
  });
});

describe("previews (B2)", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString();

  function repoWithBranch(files: Record<string, string>) {
    const dir = tmp("orc-prev-");
    const origin = join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", origin);
    const work = join(dir, "work");
    git(dir, "clone", "-q", origin, work);
    writeFileSync(join(work, "README.md"), "app");
    git(work, "add", ".");
    git(work, "commit", "-qm", "init");
    git(work, "push", "-q", "origin", "HEAD:main");
    git(work, "checkout", "-qb", "orc/b1");
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(join(work, f, ".."), { recursive: true });
      writeFileSync(join(work, f), text);
    }
    git(work, "add", ".");
    git(work, "commit", "-qm", "app");
    git(work, "push", "-q", "origin", "orc/b1");
    git(work, "checkout", "-q", "-");
    return { dir, work };
  }

  it("serves a static site from the build's branch, by key, with no way out of the folder", async () => {
    const { dir, work } = repoWithBranch({ "index.html": "<h1>Expenses</h1>", "app.js": "console.log(1)" });
    const store = new Store(join(dir, "data"));
    cleanup.unshift(() => store.close());
    const f = fakeRunner();
    const desk = new BuildDesk({ store, runner: f.runner, node: "hub" });
    const b = desk.start({ name: "site", spec: "x", repo: work });
    f.runs[0].resolve({ ...f.runs[0].record, status: "done", steps: [branchStep("s1", "orc/b1") as any] });
    await settle();
    const make = previewer(desk, new PreviewMaker({ dataDir: join(dir, "data"), remote: "origin" }));
    await make(desk.get(b.id)!);
    const got = desk.get(b.id)!;
    expect(got.preview).toMatchObject({ status: "ready", web: `/p/${b.previewKey}/` });
    expect(got.preview?.apk).toBeUndefined();

    const app = new Hono();
    mountBuilds(app, { builds: desk });
    expect(await (await app.request(`/p/${b.previewKey}/`)).text()).toBe("<h1>Expenses</h1>");
    const js = await app.request(`/p/${b.previewKey}/app.js`);
    expect(js.headers.get("content-type")).toBe("text/javascript");
    expect(await (await app.request(`/p/${b.previewKey}/some/route`)).text()).toBe("<h1>Expenses</h1>"); // single-page fallback
    expect((await app.request(`/p/${b.previewKey}/..%2F..%2Fdata%2Forchestrator.db`)).status).toBe(404);
    expect((await app.request("/p/wrongkey/")).status).toBe(404);
    const listed = await (await app.request("/api/builds")).json();
    expect(listed[0].preview.webRoot).toBeUndefined(); // hub paths stay on the hub
  });

  it("finds an APK and says when there is nothing to preview", async () => {
    const { dir, work } = repoWithBranch({ "src/main.ts": "x" });
    const r = await new PreviewMaker({ dataDir: join(dir, "data"), remote: "origin" }).make({ id: "b9", repo: work, previewKey: "k", branches: [{ name: "orc/b1" }] } as any);
    expect(r).toMatchObject({ status: "failed" });
    expect(r.error).toContain("nothing to preview");
    const apkDir = join(dir, "data", "previews", "b9", "android", "app", "build", "outputs", "apk", "debug");
    mkdirSync(apkDir, { recursive: true });
    writeFileSync(join(apkDir, "app-debug.apk"), "PK");
    expect(newestApk(join(dir, "data", "previews", "b9"))).toBe(join(apkDir, "app-debug.apk"));
  });

  it("HTTP: start, list, merge", async () => {
    const s = setup();
    const app = new Hono();
    mountBuilds(app, { builds: s.desk });
    const post = (path: string, body?: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const res = await post("/api/builds", { name: "Todo", spec: "a todo list", repo: s.repo });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect((await post("/api/builds", { name: "Todo", spec: "x", agent: "groq", repo: s.repo })).status).toBe(400);
    expect((await post(`/api/builds/${b.id}/merge`)).status).toBe(409);
    expect((await post("/api/builds/nope/merge")).status).toBe(404);
    expect((await (await app.request(`/api/builds/${b.id}`)).json()).name).toBe("Todo");
  });
});
