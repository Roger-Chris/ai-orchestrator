import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { PushPayload } from "../server/push.js";
import { namedUid, slug, type MemoryReplica } from "../shared/replica.js";
import type { Store } from "../store/db.js";
import type { Build, BuildBranch, ProviderId, ProviderResult, RunOptions, RunRecord } from "../types.js";
import { insideProjects } from "./repo.js";

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
  /** An app, a deck or a video. Worked out from the words when left out. */
  kind?: BuildKind;
  /** Who is asking, when it is not the owner ("brain"): such a caller may only use projects the agents created. */
  by?: string;
}

export type BuildKind = NonNullable<Build["kind"]>;

/** What "create a ppt / a video / an app" is asking for. */
export function guessKind(text: string): BuildKind {
  if (/\b(ppt|pptx|powerpoint|slides?|deck|presentation)\b/i.test(text)) return "slides";
  if (/\b(video|mp4|reel|animation)\b/i.test(text)) return "video";
  return "app";
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
  /** The folder of projects the agents created: their authority. Empty: no limit is checked. */
  projectsDir?: string;
  /** Other folders agents may work in: repos the owner handed over (repos.adopt). */
  isOwned?: (folder: string) => boolean;
  /** Rules and audits for every build, put into the task. */
  guidelines?: () => string;
  /** A new private repo for a project; returns its folder (`./repo.ts`). */
  createRepo?: (name: string, spec: string) => Promise<string>;
  /** The best free coding agent and a different reviewer right now. */
  pickAgents?: () => Promise<{ agent?: ProviderId; reviewer?: ProviderId }>;
  /** The device for this kind of work; undefined lets the router choose. */
  pickNode?: (kind: BuildKind, spec: string) => string | undefined;
  /** A cloud agent that makes decks and videos without a repo (your free Manus credits). */
  direct?: (prompt: string) => Promise<ProviderResult>;
}

export class BuildError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 = 400,
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

  /**
   * "Create a ppt / a video / an app": works out what is wanted, makes a private repo when there is
   * none, chooses the agents and the device, then starts it. Decks and videos go to the free cloud
   * agent when there is one, and to a coding agent in a repo when there is not or when it fails.
   */
  async make(input: BuildInput, noCloud = false): Promise<Build> {
    const kind = input.kind ?? guessKind(`${input.name} ${input.spec}`);
    let next: BuildInput = { ...input, kind };
    if (!next.repo && !next.continue) {
      if (kind !== "app" && this.d.direct && !next.agent && !noCloud) return this.direct(next);
      if (!this.d.createRepo) throw new BuildError("which folder is the app in? (repo: a git clone with a remote)");
      next = { ...next, repo: await this.d.createRepo(next.name, next.spec) };
    }
    if (!next.continue) {
      const picked = next.agent ? undefined : await this.d.pickAgents?.().catch(() => undefined);
      next = { ...next, node: next.node ?? this.d.pickNode?.(kind, next.spec), agent: next.agent ?? picked?.agent, reviewer: next.reviewer ?? picked?.reviewer };
    }
    return this.start(next);
  }

  /** A deck or video from the cloud agent: no repo and nothing to merge; the answer has the file links. */
  private direct(input: BuildInput): Build {
    const id = `b${randomBytes(4).toString("hex")}`;
    const at = this.now();
    const b: Build = { id, name: input.name.trim(), spec: input.spec.trim(), repo: "", kind: input.kind, by: input.by, agent: "manus", reviewer: "manus", status: "running", runId: `direct-${id}`, branches: [], previewKey: randomBytes(16).toString("hex"), createdAt: at, updatedAt: at };
    if (!b.name) throw new BuildError("it needs a name");
    if (!b.spec) throw new BuildError("say what to make");
    this.save(b);
    const prompt = `Make this ${input.kind === "video" ? "video" : "presentation (PowerPoint .pptx)"}: "${b.name}".\n\n${b.spec}\n\n${this.d.guidelines?.() ?? ""}`;
    void this.d.direct!(prompt).then(
      (r) => this.directDone(id, input, r.ok ? r.text : undefined, r.error),
      (e) => this.directDone(id, input, undefined, (e as Error).message),
    );
    return b;
  }

  private async directDone(id: string, input: BuildInput, text?: string, error?: string) {
    const b = this.get(id);
    if (!b || b.status !== "running") return;
    if (text) {
      b.status = "done";
      b.summary = text.slice(0, 4000);
      this.save(b);
      this.remember(b);
      this.d.notify?.({ title: `${b.name}: ready`, body: "Made with your free Manus credits. The file links are on the Builds screen.", url: `/builds?id=${b.id}`, tag: `build-${b.id}` });
      return;
    }
    b.status = "failed";
    try {
      const next = await this.make(input, true);
      b.error = `The cloud agent could not make it (${error ?? "no answer"}), so build ${next.id} is doing it in a repo instead.`;
    } catch (e) {
      b.error = `The cloud agent could not make it (${error ?? "no answer"}), and no coding agent could start: ${(e as Error).message}`;
      this.d.notify?.({ title: `${b.name}: build failed`, body: b.error, url: `/builds?id=${b.id}`, tag: `build-${b.id}` });
    }
    this.save(b);
    this.remember(b);
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
    // Agents work only in projects they created. A repo of yours needs you to start the build.
    if (input.by && this.d.projectsDir && !insideProjects(folder, this.d.projectsDir) && !this.d.isOwned?.(folder)) throw new BuildError(`${input.by} may only build in projects the agents created (in ${this.d.projectsDir}), not ${folder}. Leave out the repo to make a new one, or start it from the Builds screen.`, 403);
    agent ??= "claude";
    reviewer ??= otherAgent(agent);
    if (reviewer === agent) reviewer = otherAgent(agent);

    const id = `b${randomBytes(4).toString("hex")}`;
    const kind = input.kind ?? prev?.kind ?? "app";
    const task = buildTask({ name, spec: input.spec, agent, reviewer, prev, kind, guidelines: this.d.guidelines?.() });
    const run = this.d.runner.submit(task, { branches: true, permission: "edit", cwd: folder, nodes: node ? [node] : undefined, mode: "plan" });
    const b: Build = {
      id,
      name,
      spec: input.spec.trim(),
      repo: folder,
      kind,
      by: input.by,
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
    if (b.runId.startsWith("direct-")) {
      b.status = "cancelled"; // the cloud task carries on in Manus; its answer is ignored here
      this.save(b);
      return b;
    }
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
      this.d.notify?.({ title: `${b.name}: preview ready`, body: `${[preview.web && "web preview", preview.apk && "Android APK", preview.files?.length && `${preview.files.length} file(s)`].filter(Boolean).join(" and ") || "preview"}. ${preview.audit ? "Audit report attached." : "No audit report was written."}`, url: `/builds?id=${b.id}`, tag: `build-${b.id}` });
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
export function buildTask(p: { name: string; spec: string; agent: ProviderId; reviewer: ProviderId; prev?: Pick<Build, "spec" | "branches"> & { id?: string }; kind?: BuildKind; guidelines?: string }): string {
  const kind = p.kind ?? "app";
  const what = kind === "slides" ? "PRESENTATION" : kind === "video" ? "VIDEO" : "APP";
  const lines = [`BUILD THE ${what} "${p.name}".`, "", "WHAT TO BUILD:", p.spec.trim(), ""];
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
    "- Work only in this repo. Never read, change or delete other repos or folders, on this device or on GitHub.",
    "- Never run an Android emulator or AVD on a Linux machine: the Linux hub cannot take it. Use unit and component tests there.",
    kind === "app"
      ? "- If it is a web app, make `npm run build` produce a static site (dist/ or build/) so a preview can be served. If it is an Android app, make a debug APK buildable (`./gradlew assembleDebug` or `npm run build:apk`)."
      : `- Keep the script that makes it in the repo, and put the finished ${kind === "slides" ? ".pptx (and a .pdf copy)" : ".mp4"} in an output/ folder at the top of the repo, committed, so it can be downloaded from the phone.`,
    "- Do every audit in the guidelines below and write the results to AUDIT.md at the top of the repo. Never mark something passed that did not run; write \"not run\" and why.",
    "- Finish with a short summary: what was built, how to run it, what is left.",
  );
  if (p.guidelines?.trim()) lines.push("", "GUIDELINES:", p.guidelines.trim().slice(0, 8000));
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}
