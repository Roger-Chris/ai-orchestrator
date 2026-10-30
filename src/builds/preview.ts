import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { platform } from "node:os";
import { join, resolve } from "node:path";
import { git } from "../cluster/branchwork.js";
import { runProcess } from "../providers/base.js";
import type { Build } from "../types.js";

/**
 * Build previews (Jarvis B2). The hub fetches the build's last branch from the remote into its own
 * worktree (data/previews/<build>), so it works whichever device did the coding, then:
 * - web: `npm run build` (or a plain index.html) -> served at /p/<previewKey>/ for the phone's browser
 * - Android: `npm run build:apk` or `gradlew assembleDebug` -> the newest .apk at /p/<previewKey>/app.apk
 * Nothing is deployed anywhere; the owner looks, then taps Merge.
 */

type Exec = typeof runProcess;

export interface PreviewResult {
  status: "ready" | "failed";
  web?: string;
  apk?: string;
  /** Where the files are on the hub (not shown in the app). */
  webRoot?: string;
  apkFile?: string;
  error?: string;
  log: string;
}

export interface PreviewOptions {
  dataDir: string;
  remote: string;
  exec?: Exec;
  timeoutMs?: number;
}

const WIN = platform() === "win32";

export class PreviewMaker {
  constructor(private o: PreviewOptions) {}

  async make(b: Build): Promise<PreviewResult> {
    const exec = this.o.exec ?? runProcess;
    const log: string[] = [];
    const branch = b.branches.at(-1)?.name;
    if (!branch) return { status: "failed", error: "the build has no branch", log: "" };
    const dir = resolve(this.o.dataDir, "previews", b.id);
    const remote = this.o.remote;
    const step = async (what: string, r: Promise<{ ok: boolean; out: string; err: string }>) => {
      const x = await r;
      log.push(`$ ${what}\n${(x.out + "\n" + x.err).trim().slice(-1500)}`);
      if (!x.ok) throw new Error(`${what} failed: ${(x.err || x.out).slice(-400)}`);
      return x;
    };
    try {
      await step(`git fetch ${branch}`, git(["fetch", remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], b.repo, exec));
      if (existsSync(join(dir, ".git"))) await step("git checkout", git(["checkout", "--detach", "--force", `${remote}/${branch}`], dir, exec));
      else {
        mkdirSync(resolve(this.o.dataDir, "previews"), { recursive: true });
        await step("git worktree add", git(["worktree", "add", "--force", "--detach", dir, `${remote}/${branch}`], b.repo, exec));
      }

      const scripts = readScripts(dir);
      const run = async (what: string, command: string, args: string[], cwd = dir) => {
        const r = await exec({ command, args, cwd, timeoutMs: this.o.timeoutMs ?? 20 * 60_000, env: { CI: "1" } });
        const ok = r.code === 0 && !r.timedOut && !r.spawnError;
        return step(what, Promise.resolve({ ok, out: r.stdout, err: r.stderr || r.spawnError || (r.timedOut ? "timed out" : "") }));
      };
      const npm = WIN ? "npm.cmd" : "npm";
      if (scripts && (scripts.build || scripts["build:apk"])) {
        await run("npm install", npm, existsSync(join(dir, "package-lock.json")) ? ["ci"] : ["install"]);
      }

      const out: PreviewResult = { status: "ready", log: "" };
      // Web
      if (scripts?.build) {
        await run("npm run build", npm, ["run", "build"]);
        const root = ["dist", "build", "out", "web-build"].map((d) => join(dir, d)).find((d) => existsSync(join(d, "index.html")));
        if (root) out.webRoot = root;
      } else if (existsSync(join(dir, "index.html"))) out.webRoot = dir;
      if (out.webRoot) out.web = `/p/${b.previewKey}/`;

      // Android
      const gradleDir = [join(dir, "android"), dir].find((d) => existsSync(join(d, WIN ? "gradlew.bat" : "gradlew")));
      if (scripts?.["build:apk"]) await run("npm run build:apk", npm, ["run", "build:apk"]);
      else if (gradleDir) await run("gradlew assembleDebug", WIN ? join(gradleDir, "gradlew.bat") : join(gradleDir, "gradlew"), ["assembleDebug"], gradleDir);
      if (scripts?.["build:apk"] || gradleDir) {
        const apk = newestApk(dir);
        if (apk) (out.apkFile = apk), (out.apk = `/p/${b.previewKey}/app.apk`);
      }

      if (!out.web && !out.apk) return { status: "failed", error: "nothing to preview: no `build` script with a dist/ or build/ folder, no index.html, no Android build", log: log.join("\n\n").slice(-6000) };
      out.log = log.join("\n\n").slice(-6000);
      return out;
    } catch (e) {
      return { status: "failed", error: (e as Error).message, log: log.join("\n\n").slice(-6000) };
    }
  }
}

function readScripts(dir: string): Record<string, string> | undefined {
  try {
    return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return undefined;
  }
}

/** The newest .apk in the worktree (debug outputs live a few folders down), skipping node_modules. */
export function newestApk(dir: string, depth = 8): string | undefined {
  let best: { file: string; at: number } | undefined;
  const walk = (d: string, left: number) => {
    if (left < 0) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e === "node_modules" || e === ".git") continue;
      const p = join(d, e);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(p, left - 1);
      else if (e.endsWith(".apk") && (!best || s.mtimeMs > best.at)) best = { file: p, at: s.mtimeMs };
    }
  };
  walk(dir, depth);
  return best?.file;
}
