import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { platform } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { git } from "../cluster/branchwork.js";
import { runProcess } from "../providers/base.js";
import type { Build } from "../types.js";

/**
 * Build previews (Jarvis B2). The hub fetches the build's last branch from the remote into its own
 * worktree (data/previews/<build>), so it works whichever device did the coding, then:
 * - web: `npm run build` (or a plain index.html) -> served at /p/<previewKey>/ for the phone's browser
 * - Android: `npm run build:apk` or `gradlew assembleDebug` -> the newest .apk at /p/<previewKey>/app.apk,
 *   built on the device with the Android SDK (`builds.androidNode`, e.g. the laptop) and copied back
 * Apps are looked for in the top folder and its subfolders, so a repo with the app in mobile/ works.
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
  /** Finished decks and videos from the repo's output/ folder. */
  files?: { name: string; url: string }[];
  filesRoot?: string;
  /** The start of AUDIT.md, when the build wrote one. */
  audit?: string;
  error?: string;
  log: string;
}

/** An Android build on the device that has the Android tools (config `builds.androidNode`). */
export interface ApkRequest {
  id: string;
  /** Clone URL of the build's repo (the hub's `git remote get-url`). */
  remoteUrl: string;
  branch: string;
  /** The app's folder inside the repo ("" for the top, "mobile" for a subfolder). */
  appDir: string;
  timeoutMs?: number;
}
export interface ApkResult {
  ok: boolean;
  /** On the device that built it. */
  apkFile?: string;
  error?: string;
  log: string;
}

export interface PreviewOptions {
  dataDir: string;
  remote: string;
  exec?: Exec;
  timeoutMs?: number;
  /**
   * Android builds elsewhere: the hub (Linux, no Android SDK) asks the laptop to build the APK and
   * copies it back. `node` is the device's name; `build` returns the APK as a file on the hub.
   */
  android?: { node: string; build: (req: ApkRequest) => Promise<ApkResult> };
}

const WIN = platform() === "win32";

/** npm and gradlew.bat are batch files on Windows, which Node only starts through cmd.exe. */
export function command(cmd: string, args: string[]): { command: string; args: string[] } {
  return WIN && /(^npm$|\.bat$|\.cmd$)/i.test(cmd) ? { command: "cmd.exe", args: ["/d", "/s", "/c", cmd, ...args] } : { command: cmd, args };
}

const SKIP = new Set(["node_modules", ".git", "dist", "build", "out", "android", "ios", ".expo", "web-build", "vendor", "target"]);
const PREFER = ["mobile", "app", "apps", "web", "frontend", "client", "site"];

/**
 * Where the apps are in a repo: the top folder first, then its subfolders (`mobile/`, `web/`…).
 * web: a `build` script or an index.html; android: a `build:apk` script, or a gradle wrapper.
 */
export function findApps(dir: string): { web?: string; android?: string } {
  const subs = (() => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name))
        .map((e) => e.name)
        .sort((a, b) => (PREFER.indexOf(a) + 1 || 99) - (PREFER.indexOf(b) + 1 || 99) || a.localeCompare(b));
    } catch {
      return [];
    }
  })();
  const dirs = [dir, ...subs.map((s) => join(dir, s))];
  const out: { web?: string; android?: string } = {};
  for (const d of dirs) {
    const scripts = readScripts(d);
    if (!out.android && (scripts?.["build:apk"] || [join(d, "android"), d].some((g) => existsSync(join(g, "gradlew")) || existsSync(join(g, "gradlew.bat"))))) out.android = d;
    if (!out.web && (scripts?.build || (!scripts?.["build:apk"] && existsSync(join(d, "index.html"))))) out.web = d;
  }
  return out;
}

type Step = (what: string, command: string, args: string[], cwd: string) => Promise<unknown>;

function stepper(exec: Exec, log: string[], timeoutMs: number): Step {
  return async (what, cmd, args, cwd) => {
    const c = command(cmd, args);
    const r = await exec({ command: c.command, args: c.args, cwd, timeoutMs, env: { CI: "1" } });
    const ok = r.code === 0 && !r.timedOut && !r.spawnError;
    log.push(`$ ${what}\n${(r.stdout + "\n" + (r.stderr || r.spawnError || (r.timedOut ? "timed out" : ""))).trim().slice(-1500)}`);
    if (!ok) throw new Error(`${what} failed: ${(r.stderr || r.spawnError || r.stdout || (r.timedOut ? "timed out" : "")).slice(-400)}`);
    return r;
  };
}

/** Builds the APK of the Android app in `appDir` (npm `build:apk`, else gradlew assembleDebug); returns the newest .apk. */
export async function buildApkIn(appDir: string, exec: Exec, timeoutMs: number, log: string[]): Promise<string> {
  const run = stepper(exec, log, timeoutMs);
  const scripts = readScripts(appDir);
  if (scripts?.["build:apk"]) {
    await run("npm install", "npm", existsSync(join(appDir, "package-lock.json")) ? ["ci"] : ["install"], appDir);
    await run("npm run build:apk", "npm", ["run", "build:apk"], appDir);
  } else {
    const g = [join(appDir, "android"), appDir].find((d) => existsSync(join(d, WIN ? "gradlew.bat" : "gradlew")));
    if (!g) throw new Error(`no gradle wrapper for this system in ${appDir}`);
    await run("gradlew assembleDebug", WIN ? join(g, "gradlew.bat") : join(g, "gradlew"), ["assembleDebug"], g);
  }
  const apk = newestApk(appDir);
  if (!apk) throw new Error("the Android build finished but left no .apk");
  return apk;
}

/**
 * The device side of a remote Android build: clone (or fetch) the repo into
 * data/apk-builds/<id>, check out the branch, build the app in `appDir`.
 */
export async function buildApkHere(req: ApkRequest, o: { dataDir: string; exec?: Exec; timeoutMs?: number }): Promise<ApkResult> {
  const exec = o.exec ?? runProcess;
  const log: string[] = [];
  const dir = resolve(o.dataDir, "apk-builds", req.id.replace(/[^\w.-]/g, "_"));
  const appDir = resolve(dir, req.appDir || ".");
  if (!appDir.startsWith(dir)) return { ok: false, error: "the app folder is outside the repo", log: "" };
  const g = async (what: string, args: string[], cwd?: string) => {
    const r = await git(args, cwd, exec, 10 * 60_000);
    log.push(`$ ${what}\n${(r.out + "\n" + r.err).trim().slice(-800)}`);
    if (!r.ok) throw new Error(`${what} failed: ${(r.err || r.out).slice(-400)}`);
  };
  try {
    if (!existsSync(join(dir, ".git"))) {
      mkdirSync(resolve(o.dataDir, "apk-builds"), { recursive: true });
      await g("git clone", ["clone", "--quiet", "--no-checkout", req.remoteUrl, dir]);
    }
    await g(`git fetch ${req.branch}`, ["fetch", "--quiet", req.remoteUrl, `+refs/heads/${req.branch}:refs/remotes/build/${req.branch}`], dir);
    await g("git checkout", ["checkout", "--quiet", "--detach", "--force", `refs/remotes/build/${req.branch}`], dir);
    const apkFile = await buildApkIn(appDir, exec, req.timeoutMs ?? o.timeoutMs ?? 30 * 60_000, log);
    return { ok: true, apkFile, log: log.join("\n\n").slice(-6000) };
  } catch (e) {
    return { ok: false, error: (e as Error).message, log: log.join("\n\n").slice(-6000) };
  }
}

export class PreviewMaker {
  constructor(private o: PreviewOptions) {}

  async make(b: Build): Promise<PreviewResult> {
    const exec = this.o.exec ?? runProcess;
    const log: string[] = [];
    const branch = b.branches.at(-1)?.name;
    if (!branch) return { status: "failed", error: "the build has no branch", log: "" };
    const dir = resolve(this.o.dataDir, "previews", b.id);
    const remote = this.o.remote;
    const timeoutMs = this.o.timeoutMs ?? 20 * 60_000;
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

      const apps = findApps(dir);
      const run = stepper(exec, log, timeoutMs);
      const out: PreviewResult = { status: "ready", log: "" };
      const problems: string[] = [];

      // Web (here on the hub)
      if (apps.web) {
        const scripts = readScripts(apps.web);
        try {
          if (scripts?.build) {
            await run("npm install", "npm", existsSync(join(apps.web, "package-lock.json")) ? ["ci"] : ["install"], apps.web);
            await run("npm run build", "npm", ["run", "build"], apps.web);
            out.webRoot = ["dist", "build", "out", "web-build"].map((d) => join(apps.web!, d)).find((d) => existsSync(join(d, "index.html")));
          } else out.webRoot = apps.web;
        } catch (e) {
          problems.push(`web: ${(e as Error).message}`);
        }
        if (out.webRoot) out.web = `/p/${b.previewKey}/`;
      }

      // Android: on the device with the Android tools when one is set, else here.
      if (apps.android) {
        try {
          const appDir = relative(dir, apps.android).split(sep).join("/");
          if (this.o.android) {
            const url = await step("git remote get-url", git(["remote", "get-url", remote], b.repo, exec));
            log.push(`Android build on ${this.o.android.node} (${appDir || "top folder"})`);
            const r = await this.o.android.build({ id: b.id, remoteUrl: url.out, branch, appDir, timeoutMs });
            if (r.log) log.push(r.log);
            if (!r.ok || !r.apkFile) throw new Error(r.error ?? "no APK came back");
            out.apkFile = r.apkFile;
          } else out.apkFile = await buildApkIn(apps.android, exec, timeoutMs, log);
          out.apk = `/p/${b.previewKey}/app.apk`;
        } catch (e) {
          problems.push(`Android: ${(e as Error).message}${this.o.android ? "" : " (set builds.androidNode to the device with the Android SDK, e.g. the laptop)"}`);
        }
      }

      const output = join(dir, "output");
      if (existsSync(output) && statSync(output).isDirectory()) {
        const names = readdirSync(output).filter((n) => statSync(join(output, n)).isFile());
        if (names.length) {
          out.filesRoot = output;
          out.files = names.map((name) => ({ name, url: `/p/${b.previewKey}/files/${encodeURIComponent(name)}` }));
        }
      }
      if (existsSync(join(dir, "AUDIT.md"))) out.audit = readFileSync(join(dir, "AUDIT.md"), "utf8").slice(0, 4000);

      out.log = log.join("\n\n").slice(-6000);
      if (!out.web && !out.apk && !out.files) {
        const error = problems.length ? problems.join("; ") : "nothing to preview: no `build` script with a dist/ or build/ folder, no index.html, no Android build (looked in the top folder and its subfolders)";
        return { status: "failed", error, log: out.log };
      }
      if (problems.length) out.error = problems.join("; "); // one part ready, the other not
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
