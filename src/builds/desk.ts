import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { PushPayload } from "../server/push.js";
import { namedUid, slug, type MemoryReplica } from "../shared/replica.js";
import type { Store } from "../store/db.js";
import type { Build, BuildBranch, ProviderId, RunOptions, RunRecord } from "../types.js";

/**
 * Building apps on command (Jarvis phase 2). A build is an Orchestrator run with branch work on:
 * the coding agent works on its own git branch, writes and runs tests, a second model reviews the
 * diff, and the branches are pushed. Nothing reaches the main branch until the owner taps Merge.
 *
 * B1: `start()` (brain tool `build` -> POST /api/builds). B2: previews (`./preview.ts`) and merge.
 * B3: every build is written to the shared memory as a `project` record for the app plus a `work`
 * record, so "continue the X app" finds it again from any device. B4: the app's Builds screen.
 */

export interface BuildRunner {
  submit(task: string, options: RunOptions): RunRecord;
  wait(id: string): Promise<RunRecord> | undefined;
  get(id: string): RunRecord | undefined;
  cancel(id: string): boolean;
  mergeBranch(runId: string, stepId: string): Promise<{ ok: boolean; error?: string }>;
}

export interface BuildInput {
  /** The app's name, e.g. "expense tracker". */
  name: string;
  /** What to build or change. */
  spec: string;
  /** The git folder on the hub's machine (a clone with a remote). Optional when continuing. */
  repo?: string;
  /** Device to build on (a node name); default any device that accepts branch work. */
  node?: string;
  /** Coding agent: claude (Claude Code) or codex (ChatGPT). */
  agent?: ProviderId;
  /** Second model that reviews the diff; default the other one of claude / codex. */
  reviewer?: ProviderId;
  /** Continue the last build of this app (same folder, device and agents, on top of its branch). */
  continue?: boolean;
}

export interface BuildDeskDeps {
  store: Store;
  runner: BuildRunner;
  replica?: MemoryReplica;
  notify?: (p: PushPayload) => void;
  /** Called when a build is ready, to make its preview (B2); absent: no automatic previews. */
  onReady?: (b: Build) => void;
  node: string;
  now?: () => number;
}

export class BuildError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

const otherAgent = (a?: ProviderId): ProviderId => (a === "codex" ? "claude" : "codex");

export class BuildDesk {
  constructor(private d: BuildDeskDeps) {
    d.store.db.exec(`
      CREATE TABLE IF NOT EXISTS builds (
        id TEXT PRIMARY KEY, app TEXT NOT NULL, record TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS builds_app ON builds(app, created_at DESC);
    `);
  }

  private now() {
    return (this.d.now ?? Date.now)();
  }

  private save(b: Build) {
    b.updatedAt = this.now();
    this.d.store.db
      .prepare("INSERT OR REPLACE INTO builds (id, app, record, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(b.id, slug(b.name), JSON.stringify(b), b.createdAt, b.updatedAt);
  }

  get(id: string): Build | undefined {
    const row = this.d.store.db.prepare("SELECT record FROM builds WHERE id = ?").get(id) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as Build) : undefined;
  }

  list(limit = 30): Build[] {
    return (this.d.store.db.prepare("SELECT record FROM builds ORDER BY created_at DESC LIMIT ?").all(limit) as { record: string }[]).map((r) => JSON.parse(r.record));
  }

  /** The newest build of an app on this hub, by name ("the expense tracker" finds "Expense Tracker"). */
  latest(name: string): Build | undefined {
    const s = slug(name.replace(/^the\s+|\s+app$/gi, ""));
    const row = this.d.store.db.prepare("SELECT record FROM builds WHERE app = ? OR app = ? ORDER BY created_at DESC LIMIT 1").get(s, slug(name)) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as Build) : undefined;
  }

  /** B1/B3: start a build, or continue the last one of that app. */
  start(input: BuildInput): Build {
    const name = input.name.trim();
    if (!name) throw new BuildError("the app needs a name");
    if (!input.spec.trim()) throw new BuildError("say what to build");
    let prev: Build | undefined;
    let repo = input.repo;
    let node = input.node;
    let agent = input.agent;
    let reviewer = input.reviewer;
    if (input.continue) {
      prev = this.latest(name);
      // Another device may have built it: its shared-memory record keeps the folder and agents.
      const mem = !prev ? this.d.replica?.get(namedUid("project", name))?.data : undefined;
      if (!prev && !mem?.repo) throw new BuildError(`no earlier build of ${name} to continue`, 404);
      repo ??= prev?.repo ?? (mem?.repo as string);
      node ??= prev?.node ?? (mem?.node as string | undefined);
      agent ??= prev?.agent ?? (mem?.agent as ProviderId | undefined);
      reviewer ??= prev?.reviewer ?? (mem?.reviewer as ProviderId | undefined);
      if (!prev && mem) prev = { name, spec: String(mem.spec ?? ""), branches: (mem.branches as BuildBranch[]) ?? [] } as unknown as Build;
    }
    if (!repo) throw new BuildError("which folder is the app in? (repo: a git clone with a remote)");
    const folder = resolve(repo);
    if (!existsSync(folder)) throw new BuildError(`folder not found on ${this.d.node}: ${folder}`);
    agent ??= "claude";
    reviewer ??= otherAgent(agent);
    if (reviewer === agent) reviewer = otherAgent(agent);

    const id = `b${randomBytes(4).toString("hex")}`;
    const task = buildTask({ name, spec: input.spec, agent, reviewer, prev });
    const run = this.d.runner.submit(task, { branches: true, permission: "edit", cwd: folder, nodes: node ? [node] : undefined, mode: "plan" });
    const b: Build = {
      id,
      name,
      spec: input.spec.trim(),
      repo: folder,
      node,
      agent,
      reviewer,
      status: "running",
      runId: run.id,
      branches: [],
      continuedFrom: prev?.id,
      previewKey: randomBytes(16).toString("hex"),
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.save(b);
    void this.d.runner.wait(run.id)?.then((r) => this.finish(b.id, r), (e) => this.fail(b.id, (e as Error).message));
    return b;
  }

  /** A finished run: collect its branches, tell the owner, write it to the shared memory. */
  finish(id: string, run: RunRecord): Build | undefined {
    const b = this.get(id);
    if (!b) return undefined;
    b.branches = run.steps
      .filter((s) => s.branch?.pushed)
      .map((s) => ({ step: s.id, title: s.title, name: s.branch!.name, node: s.branch!.node, commit: s.branch!.commit, tests: s.branch!.tests ? (s.branch!.tests.ok ? "passed" : "failed") : "none", files: s.branch!.changedFiles.length }));
    b.summary = run.result?.slice(0, 4000);
    // Steps that did not run (e.g. no second model free for the review) are said plainly, not hidden.
    b.notes = run.steps.filter((s) => s.status === "failed" || s.status === "skipped").map((s) => `${s.title}: ${s.status}${s.error ? ` (${s.error.slice(0, 300)})` : ""}`);
    if (run.status === "done" && b.branches.length) b.status = "ready";
    else if (run.status === "cancelled") b.status = "cancelled";
    else {
      b.status = "failed";
      b.error = run.error ?? (run.status === "done" ? "the run finished without pushing a branch (nothing changed)" : `run ${run.status}`);
    }
    this.save(b);
    this.remember(b);
    this.d.notify?.({
      title: b.status === "ready" ? `${b.name}: ready to review` : `${b.name}: build ${b.status}`,
      body:
        b.status === "ready"
          ? `${b.branches.length} branch(es), tests ${b.branches.map((x) => x.tests).join(", ")}.${b.notes.length ? ` Did not run: ${b.notes.length} step(s), see Builds.` : ""} Check the preview, then Merge.`
          : (b.error ?? ""),
      url: `/builds?id=${b.id}`,
      tag: `build-${b.id}`,
    });
    if (b.status === "ready") this.d.onReady?.(b);
    return b;
  }

  private fail(id: string, error: string) {
    const b = this.get(id);
    if (!b) return;
    b.status = "failed";
    b.error = error;
    this.save(b);
    this.remember(b);
  }

  cancel(id: string): Build {
    const b = this.must(id);
    if (b.status !== "running") throw new BuildError(`the build is ${b.status}`, 409);
    this.d.runner.cancel(b.runId);
    return b;
  }

  /**
   * B2: the owner tapped Merge. Each branch is merged into the branch checked out in the app's
   * folder (conflicts abort, nothing is left half-merged). Only the owner's own apps call this.
   */
  async merge(id: string): Promise<Build> {
    const b = this.must(id);
    if (b.status !== "ready") throw new BuildError(`only a ready build can be merged (this one is ${b.status})`, 409);
    const errors: string[] = [];
    for (const br of b.branches) {
      if (br.merged) continue;
      const r = await this.d.runner.mergeBranch(b.runId, br.step);
      if (r.ok) br.merged = true;
      else errors.push(`${br.name}: ${r.error}`);
    }
    if (errors.length) b.mergeError = errors.join("\n");
    else {
      b.status = "merged";
      b.mergeError = undefined;
    }
    this.save(b);
    this.remember(b);
    return b;
  }

  /** B2: a preview finished (web address and/or APK); kept on the build and pushed to the phone. */
  setPreview(id: string, preview: NonNullable<Build["preview"]>) {
    const b = this.must(id);
    b.preview = preview;
    this.save(b);
    if (preview.status === "ready")
      this.d.notify?.({ title: `${b.name}: preview ready`, body: [preview.web && "web preview", preview.apk && "Android APK"].filter(Boolean).join(" and ") || "preview", url: `/builds?id=${b.id}`, tag: `build-${b.id}` });
    return b;
  }

  byPreviewKey(key: string): Build | undefined {
    return this.list(200).find((b) => b.previewKey === key);
  }

  private must(id: string): Build {
    const b = this.get(id);
    if (!b) throw new BuildError(`no build ${id}`, 404);
    return b;
  }

  /** B3: one `project` record per app (the latest state) and one `work` record per build. */
  private remember(b: Build) {
    const r = this.d.replica;
    if (!r) return;
    try {
      const builds = (this.d.store.db.prepare("SELECT COUNT(*) AS n FROM builds WHERE app = ?").get(slug(b.name)) as { n: number }).n;
      r.put({
        uid: namedUid("project", b.name),
        kind: "project",
        title: b.name,
        body: `App built by the Orchestrator. Last build ${b.id}: ${b.status}. ${b.spec.slice(0, 400)}`,
        data: { app: true, repo: b.repo, node: b.node, agent: b.agent, reviewer: b.reviewer, spec: b.spec, lastBuild: b.id, status: b.status, branches: b.branches, builds, hub: this.d.node },
        tags: ["app", "build"],
        source: "orchestrator",
      });
      r.put({
        uid: `work:build-${b.id}`,
        kind: "work",
        title: `Build ${b.name}: ${b.status}`,
        body: `${b.spec.slice(0, 600)}\n\nBranches: ${b.branches.map((x) => `${x.name} (tests ${x.tests}${x.merged ? ", merged" : ""})`).join(", ") || "none"}${b.error ? `\nError: ${b.error}` : ""}`,
        data: { build: b.id, run: b.runId, status: b.status },
        subject: namedUid("project", b.name),
        tags: ["build"],
        source: "orchestrator",
      });
    } catch {
      /* memory is best-effort; the build itself is in the hub's table */
    }
  }
}

/** The run's task: the spec plus how a build is done (branches, tests, a second model's review). */
export function buildTask(p: { name: string; spec: string; agent: ProviderId; reviewer: ProviderId; prev?: Pick<Build, "spec" | "branches"> & { id?: string } }): string {
  const lines = [`BUILD THE APP "${p.name}".`, "", "WHAT TO BUILD:", p.spec.trim(), ""];
  if (p.prev) {
    const last = p.prev.branches.at(-1);
    lines.push(
      "THIS CONTINUES AN EARLIER BUILD.",
      `Earlier spec: ${p.prev.spec.slice(0, 1500)}`,
      last ? `Its last branch: ${last.name}${last.merged ? " (merged)" : ` (not merged yet: start from it with \`git fetch\` and build on top of ${last.name})`}.` : "",
      "",
    );
  }
  lines.push(
    "HOW:",
    `- Do the coding with ${p.agent} on its own branch; keep the app runnable after each step.`,
    "- Write tests for what you build and run them; fix failures before finishing. If you may not run commands, still write the tests: the orchestrator installs the dependencies and runs them after your edit, and sends you the failures.",
    `- Then a review step with ${p.reviewer} (a different model, read-only): it reads the diff for bugs, security problems and missing tests; fix what it finds.`,
    "- Never touch the main branch, never delete files the owner made, never put keys or tokens in the code.",
    "- If it is a web app, make `npm run build` produce a static site (dist/ or build/) so a preview can be served. If it is an Android app, make a debug APK buildable (`./gradlew assembleDebug` or `npm run build:apk`).",
    "- Finish with a short summary: what was built, how to run it, what is left.",
  );
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}
