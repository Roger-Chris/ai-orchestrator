/**
 * Branch work: a coding step runs in its own git worktree of the project, on a
 * branch of its own, on whichever device the router picked. The device clones
 * (or fetches) the repo, branches from the run's base commit, lets the model
 * edit, runs the tests, commits and pushes. Your laptop then reviews and merges.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runProcess } from "../providers/base.js";
import type { ProviderPool } from "../providers/registry.js";
import type { BranchJob, BranchResult, ProviderResult } from "../types.js";

type Exec = typeof runProcess;

const MAX_DIFF_CHARS = 20_000;
const MAX_TEST_OUTPUT = 4000;

export interface BranchRunOptions {
  pool: Pick<ProviderPool, "run">;
  workRoot: string;
  /** Who did the work, for commits when the device has no git identity. */
  nodeName: string;
  testTimeoutMs: number;
  fixAttempts: number;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onProgress?: (note: string) => void;
  exec?: Exec;
}

export async function git(args: string[], cwd: string | undefined, exec: Exec = runProcess, timeoutMs = 300_000) {
  const r = await exec({ command: "git", args, cwd, timeoutMs, env: { GIT_TERMINAL_PROMPT: "0" } });
  return { ok: r.code === 0 && !r.spawnError, out: r.stdout.trim(), err: (r.stderr || r.spawnError || "").trim() };
}

async function must(args: string[], cwd: string | undefined, exec: Exec, timeoutMs?: number): Promise<string> {
  const r = await git(args, cwd, exec, timeoutMs);
  if (!r.ok) throw new Error(`git ${args.slice(0, 2).join(" ")} failed: ${r.err.slice(-600) || r.out.slice(-600)}`);
  return r.out;
}

/** A filesystem-safe folder name for a repo URL or branch. */
export function slug(s: string): string {
  return s.replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-80) || "repo";
}

/** Best guess at how to run a project's tests; undefined when there is nothing to run. */
export function detectTestCommand(dir: string): string | undefined {
  const has = (f: string) => existsSync(join(dir, f));
  if (has("package.json")) {
    try {
      const test = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))?.scripts?.test;
      if (typeof test !== "string" || /no test specified/.test(test)) return undefined;
    } catch {
      return undefined;
    }
    if (has("pnpm-lock.yaml")) return "pnpm install --frozen-lockfile && pnpm test";
    if (has("yarn.lock")) return "yarn install --frozen-lockfile && yarn test";
    return has("package-lock.json") ? "npm ci && npm test" : "npm install && npm test";
  }
  if (has("Cargo.toml")) return "cargo test";
  if (has("go.mod")) return "go test ./...";
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.py")) return "python -m pytest -q";
  return undefined;
}

function shellCommand(cmd: string): { command: string; args: string[] } {
  return process.platform === "win32" ? { command: "cmd.exe", args: ["/d", "/s", "/c", cmd] } : { command: "sh", args: ["-c", cmd] };
}

export function branchPrompt(job: BranchJob, testCommand?: string): string {
  return `${job.prompt}

---
You are working in a git checkout of the project, on branch \`${job.branch}\`. Other agents are
working on other parts of the same change in parallel, on their own branches.
${job.files?.length ? `You own these files; change other files only if you truly must:\n${job.files.map((f) => `- ${f}`).join("\n")}\n` : ""}
- Make the change completely: code, plus tests for it where the project has tests.
- Keep the change focused on this step. Do not reformat unrelated code.
- Do not commit; the orchestrator commits and pushes your work when you finish.
${testCommand ? `- The orchestrator will run \`${testCommand}\` afterwards; make it pass.` : ""}
Finish with a short summary of what you changed and why.`;
}

/** Runs one branch job end to end on this device. Never throws: failures come back in the result. */
export async function runBranchJob(job: BranchJob, o: BranchRunOptions): Promise<BranchResult> {
  const exec = o.exec ?? runProcess;
  const started = Date.now();
  const progress = (n: string) => o.onProgress?.(n);
  const base: BranchResult = { ok: false, branch: job.branch, base: job.base, changedFiles: [], diffStat: "", diff: "", pushed: false, durationMs: 0 };
  const repos = resolve(o.workRoot, "repos");
  const mirror = join(repos, slug(job.repoUrl));
  const wt = resolve(o.workRoot, "jobs", slug(job.branch));
  let agent: ProviderResult | undefined;

  try {
    mkdirSync(repos, { recursive: true });
    mkdirSync(resolve(o.workRoot, "jobs"), { recursive: true });
    if (!existsSync(join(mirror, ".git"))) {
      progress(`cloning ${job.repoUrl}`);
      await must(["clone", "--no-checkout", job.repoUrl, mirror], undefined, exec, 900_000);
    }
    await must(["fetch", "origin", "--prune"], mirror, exec, 600_000);
    for (const ref of job.mergeBranches ?? []) await must(["fetch", "origin", `+refs/heads/${ref}:refs/remotes/origin/${ref}`], mirror, exec);

    if (existsSync(wt)) {
      await git(["worktree", "remove", "--force", wt], mirror, exec);
      rmSync(wt, { recursive: true, force: true });
    }
    await git(["worktree", "prune"], mirror, exec);
    await must(["worktree", "add", "--force", "-B", job.branch, wt, job.base], mirror, exec);
    for (const ref of job.mergeBranches ?? []) {
      progress(`building on ${ref}`);
      const m = await git(["merge", "--no-edit", `origin/${ref}`], wt, exec);
      if (!m.ok) {
        await git(["merge", "--abort"], wt, exec);
        throw new Error(`could not combine the branches it depends on (${ref}): ${m.err.slice(-400) || m.out.slice(-400)}`);
      }
    }

    let testCommand = job.testCommand === "auto" ? detectTestCommand(wt) : job.testCommand || undefined;
    progress(`editing in ${wt}`);
    agent = await o.pool.run(job.provider, {
      prompt: branchPrompt(job, testCommand),
      system: job.system,
      model: job.model,
      deep: job.deep,
      permission: "edit",
      cwd: wt,
      timeoutMs: job.timeoutMs,
      signal: o.signal,
      onDelta: o.onDelta,
      onProgress: o.onProgress,
    });
    if (!agent.ok) return { ...base, agent, error: agent.error ?? "the model failed", durationMs: Date.now() - started };

    // A new project only has its package.json (or pyproject…) after the agent's edit: look again.
    // (Found by an end-to-end build of a new app: no tests ran because detection came first.)
    if (!testCommand && job.testCommand === "auto") testCommand = detectTestCommand(wt);
    // Installing dependencies to test must never commit them: keep them out locally (.git/info/exclude).
    excludeDependencyFolders(wt);

    if (testCommand) {
      let tests = await runTests(testCommand, wt, o.testTimeoutMs, exec, progress);
      for (let i = 0; i < o.fixAttempts && !tests.ok && !o.signal?.aborted; i++) {
        progress("tests failed; asking the model to fix them");
        const fix = await o.pool.run(job.provider, {
          prompt: `The tests fail after your change. Fix the code (not the tests, unless they are wrong) so that \`${testCommand}\` passes.\n\nTest output (tail):\n${tests.output}`,
          system: job.system,
          model: job.model,
          permission: "edit",
          cwd: wt,
          timeoutMs: job.timeoutMs,
          signal: o.signal,
          onDelta: o.onDelta,
          onProgress: o.onProgress,
        });
        if (fix.ok) agent = { ...agent, text: `${agent.text}\n\n${fix.text}` };
        tests = await runTests(testCommand, wt, o.testTimeoutMs, exec, progress);
      }
      base.tests = tests;
    }

    await must(["add", "-A"], wt, exec);
    if ((await git(["status", "--porcelain"], wt, exec)).out) {
      const identity = (await git(["config", "user.email"], wt, exec)).out ? [] : ["-c", "user.name=AI Orchestrator", "-c", `user.email=orchestrator@${slug(o.nodeName)}.local`];
      await must([...identity, "commit", "-q", "-m", `${job.title}\n\nBy ${job.provider} on ${o.nodeName} (AI Orchestrator, ${job.branch}).`], wt, exec);
    }
    const commit = await must(["rev-parse", "HEAD"], wt, exec);
    const changedFiles = (await git(["diff", "--name-only", `${job.base}..HEAD`], wt, exec)).out.split("\n").filter(Boolean);
    if (!changedFiles.length) return { ...base, ok: true, agent, commit, durationMs: Date.now() - started };

    const diffStat = (await git(["diff", "--stat", `${job.base}..HEAD`], wt, exec)).out;
    const diff = (await git(["diff", `${job.base}..HEAD`], wt, exec)).out;
    progress(`pushing ${job.branch}`);
    // The orc/ namespace belongs to the orchestrator; a retry on another device replaces the branch.
    await must(["push", "--force", "origin", `HEAD:refs/heads/${job.branch}`], wt, exec, 600_000);
    return {
      ...base,
      ok: true,
      agent,
      commit,
      changedFiles,
      diffStat,
      diff: diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n…[diff truncated]` : diff,
      pushed: true,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    return { ...base, agent, error: (e as Error).message, durationMs: Date.now() - started };
  } finally {
    if (existsSync(wt)) {
      await git(["worktree", "remove", "--force", wt], mirror, exec);
      rmSync(wt, { recursive: true, force: true });
    }
  }
}

/** node_modules, virtualenvs and caches stay out of the branch even when the project has no .gitignore. */
export function excludeDependencyFolders(wt: string) {
  try {
    const gitDir = join(wt, ".git");
    // a worktree's .git is a file pointing at its real git dir
    const dir = existsSync(gitDir) && statSync(gitDir).isFile() ? readFileSync(gitDir, "utf8").replace(/^gitdir:\s*/, "").trim() : gitDir;
    // git reads info/exclude from the common git dir, not a worktree's own one
    const common = existsSync(join(dir, "commondir")) ? resolve(dir, readFileSync(join(dir, "commondir"), "utf8").trim()) : dir;
    const file = join(common, "info", "exclude");
    mkdirSync(join(common, "info"), { recursive: true });
    const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
    const want = ["node_modules/", ".venv/", "__pycache__/", ".pytest_cache/"].filter((p) => !cur.split("\n").includes(p));
    if (want.length) writeFileSync(file, `${cur.replace(/\n?$/, "\n")}${want.join("\n")}\n`);
  } catch {
    /* best effort: a project with a .gitignore is fine anyway */
  }
}

async function runTests(cmd: string, cwd: string, timeoutMs: number, exec: Exec, progress: (n: string) => void) {
  progress(`running tests: ${cmd}`);
  const sh = shellCommand(cmd);
  const r = await exec({ ...sh, cwd, timeoutMs, env: { CI: "1" } });
  const output = `${r.stdout}\n${r.stderr}`.trim();
  const ok = r.code === 0 && !r.timedOut;
  progress(ok ? "tests passed" : `tests failed${r.timedOut ? " (timed out)" : ""}`);
  return { command: cmd, ok, output: output.slice(-MAX_TEST_OUTPUT) };
}
