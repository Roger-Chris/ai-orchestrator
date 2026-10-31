import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ActionLog } from "../src/actions/log.js";
import { ActionHub, ActionRunner, ApprovalDesk } from "../src/actions/desk.js";
import { openCommand, projectsDir, shellRisk } from "../src/actions/registry.js";
import { BuildDesk, type BuildRunner, buildTask, guessKind } from "../src/builds/desk.js";
import { createRepo, insideProjects } from "../src/builds/repo.js";
import { parseConfig } from "../src/config.js";
import { scopeProblem } from "../src/outside/mcp.js";
import { Store } from "../src/store/db.js";
import type { OutsideAgent, RunRecord } from "../src/types.js";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.reverse().forEach((f) => f())); // databases close before their folders go
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "orc-auth-"));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

function device() {
  const root = tmp();
  const config = parseConfig({ node: { name: "laptop", workRoot: root }, dataDir: join(root, "data"), actions: { roots: [root] } });
  const project = join(projectsDir(config), "todo");
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(project, "old.txt"), "keep me");
  const mine = join(root, "my-own-work.txt");
  writeFileSync(mine, "the owner's");
  const store = new Store(join(root, "o.db"));
  cleanup.push(() => store.db.close());
  const runner = new ActionRunner(config, {});
  return { root, config, project, mine, store, runner };
}

describe("what agents may remove", () => {
  it("moves a project's file to the trash, logs it, and brings it back", async () => {
    const { runner, project, config } = device();
    const file = join(project, "old.txt");
    const r = await runner.act({ action: "files.trash", args: { path: file, reason: "replaced" } });
    expect(r).toMatchObject({ status: "done", result: { ok: true } });
    expect(existsSync(file)).toBe(false);
    const log = readFileSync(join(config.dataDir, "trash", "log.jsonl"), "utf8");
    expect(log).toContain("replaced");
    const id = JSON.parse(log).id as string;
    expect(existsSync(join(config.dataDir, "trash", id, "old.txt"))).toBe(true);
    const listed = await runner.act({ action: "files.restore", args: {} });
    expect(listed.status === "done" && listed.result.output).toContain(id);
    await runner.act({ action: "files.restore", args: { id } });
    expect(readFileSync(file, "utf8")).toBe("keep me");
  });

  it("refuses anything outside the projects the agents created", async () => {
    const { runner, mine, project } = device();
    expect(await runner.act({ action: "files.trash", args: { path: mine } })).toMatchObject({ status: "refused" });
    expect(existsSync(mine)).toBe(true);
    // a project as a whole and its history stay
    expect(await runner.act({ action: "files.trash", args: { path: project } })).toMatchObject({ status: "refused" });
    expect(await runner.act({ action: "files.trash", args: { path: join(project, ".git") } })).toMatchObject({ status: "refused" });
  });

  it("is not fooled by a link inside a project that points out of it", async () => {
    const { runner, mine, project } = device();
    const link = join(project, "sneaky.txt");
    try {
      symlinkSync(mine, link);
    } catch {
      return; // Windows without the right to make links: nothing to test here
    }
    expect(await runner.act({ action: "files.trash", args: { path: link } })).toMatchObject({ status: "refused" });
    expect(existsSync(mine)).toBe(true);
  });

  it("restoring never replaces what is there now", async () => {
    const { runner, project, config } = device();
    const file = join(project, "old.txt");
    await runner.act({ action: "files.trash", args: { path: file } });
    writeFileSync(file, "new version");
    const id = JSON.parse(readFileSync(join(config.dataDir, "trash", "log.jsonl"), "utf8")).id;
    const r = await runner.act({ action: "files.restore", args: { id } });
    expect(r).toMatchObject({ status: "done", result: { ok: false } });
    expect(readFileSync(file, "utf8")).toBe("new version");
  });

  it("holds an outside agent limited to folders to those folders", () => {
    const a = { scopes: { devices: ["*"], folders: ["/projects/a"], risk: "safe", memoryWrite: false } } as unknown as OutsideAgent;
    expect(scopeProblem(a, "laptop", "files.trash", { path: "/projects/b/x" })).toMatch(/outside/);
    expect(scopeProblem(a, "laptop", "files.trash", { path: "/projects/a/x" })).toBeUndefined();
  });
});

describe("who did what", () => {
  it("logs every call with who asked, including refusals, and hides tokens", async () => {
    const { runner, store, config, mine } = device();
    const desk = new ApprovalDesk(store.db, config, () => undefined);
    const log = new ActionLog(store);
    const hub = new ActionHub(runner, desk, async () => ({ status: "refused", node: "x", action: "x", error: "no" }), log);
    await hub.act(undefined, { action: "files.trash", args: { path: mine }, reason: "tidy" }, { who: "brain" });
    await hub.act(undefined, { action: "system.info", args: { note: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } }, { who: "agent:hermes" });
    const [second, first] = log.list();
    expect(first).toMatchObject({ who: "brain", action: "files.trash", status: "refused", reason: "tidy" });
    expect(second.who).toBe("agent:hermes");
    expect(second.args).not.toContain("ghp_abcdef");
    expect(log.list({ who: "brain" })).toHaveLength(1);
  });
});

describe("opening apps", () => {
  it("files and web addresses still ask (a program's bare name runs at once, so it is not run here)", async () => {
    const { runner, mine } = device();
    expect(await runner.act({ action: "apps.open", args: { target: "C:\\Windows\\evil.exe" } })).toMatchObject({ status: "needs_approval" });
    expect(await runner.act({ action: "apps.open", args: { target: "https://example.com" } })).toMatchObject({ status: "needs_approval" });
    expect(await runner.act({ action: "apps.open", args: { target: `${mine} & calc` } })).toMatchObject({ status: "needs_approval" });
  });

  it("finds Store apps on Windows and uses each system's launcher, with the name as one argument", () => {
    const win = openCommand("WhatsApp", true, "win32");
    expect(win.args.at(-1)).toBe("WhatsApp");
    expect(win.args.join(" ")).toContain("Get-StartApps");
    expect(openCommand("Safari", true, "darwin").args).toEqual(["-a", "Safari"]);
    expect(openCommand("firefox", true, "linux").command).toBe("gtk-launch");
    expect(openCommand("https://example.com", false, "linux").command).toBe("xdg-open");
  });
});

describe("emulators", () => {
  it("are refused on Linux and allowed to ask elsewhere", () => {
    const config = parseConfig({});
    for (const c of ["emulator -avd Pixel", "avdmanager create avd", "~/Android/Sdk/emulator/emulator @x", "qemu-system-x86_64 x"]) expect(shellRisk(c, config, "linux")).toBe("never");
    expect(shellRisk("emulator -avd Pixel", config, "win32")).toBe("ask");
    expect(buildTask({ name: "x", spec: "y", agent: "claude", reviewer: "codex" })).toMatch(/Never run an Android emulator/);
  });
});

function fakeRunner(): BuildRunner & { tasks: string[]; nodes: (string[] | undefined)[] } {
  const tasks: string[] = [];
  const nodes: (string[] | undefined)[] = [];
  return {
    tasks,
    nodes,
    submit(task, options) {
      tasks.push(task);
      nodes.push(options.nodes);
      return { id: `r${tasks.length}`, task, options, status: "running", steps: [], createdAt: 0 } as RunRecord;
    },
    wait: () => undefined,
    get: () => undefined,
    cancel: () => true,
    mergeBranch: async () => ({ ok: true }),
  };
}

describe("making things on request", () => {
  function desk(o: Partial<ConstructorParameters<typeof BuildDesk>[0]> = {}) {
    const root = tmp();
    const projects = join(root, "projects");
    const store = new Store(join(root, "o.db"));
    cleanup.push(() => store.db.close());
    const runner = fakeRunner();
    const made: string[] = [];
    const d = new BuildDesk({
      store,
      runner,
      node: "hub",
      projectsDir: projects,
      guidelines: () => "RULE: run the audits",
      createRepo: async (name) => {
        const dir = join(projects, name);
        mkdirSync(dir, { recursive: true });
        made.push(name);
        return dir;
      },
      pickAgents: async () => ({ agent: "codex", reviewer: "claude" }),
      pickNode: (kind) => (kind === "app" ? undefined : "laptop"),
      ...o,
    });
    return { d, runner, made, root, projects };
  }

  it("works out what is wanted", () => {
    expect(guessKind("create a ppt about batteries")).toBe("slides");
    expect(guessKind("make a video of the demo")).toBe("video");
    expect(guessKind("build a todo app")).toBe("app");
  });

  it("makes a repo, picks the agents and device, and puts the guidelines in the task", async () => {
    const { d, runner, made } = desk();
    const b = await d.make({ name: "Battery Deck", spec: "ten slides", by: "brain" });
    expect(made).toEqual(["Battery Deck"]);
    expect(b).toMatchObject({ kind: "slides", agent: "codex", reviewer: "claude", node: "laptop", by: "brain" });
    expect(runner.tasks[0]).toContain("BUILD THE PRESENTATION");
    expect(runner.tasks[0]).toContain("output/");
    expect(runner.tasks[0]).toContain("RULE: run the audits");
    expect(runner.tasks[0]).toContain("AUDIT.md");
    expect(runner.tasks[0]).toContain("Work only in this repo");
  });

  it("stops the brain from building in a repo it did not create, but not you", async () => {
    const { d, root } = desk();
    const yours = join(root, "your-repo");
    mkdirSync(yours);
    await expect(d.make({ name: "x", spec: "y", repo: yours, by: "brain" })).rejects.toMatchObject({ status: 403 });
    await expect(d.make({ name: "x", spec: "y", repo: yours })).resolves.toMatchObject({ repo: yours });
  });

  it("uses the free cloud agent for decks, and falls back to a repo when it fails", async () => {
    const ok = desk({ direct: async () => ({ ok: true, text: "Slides: https://files/x.pptx", provider: "manus", durationMs: 1 }) });
    const b = await ok.d.make({ name: "Deck", spec: "ten slides" });
    expect(ok.made).toEqual([]);
    await new Promise((r) => setTimeout(r, 5));
    expect(ok.d.get(b.id)).toMatchObject({ status: "done", summary: "Slides: https://files/x.pptx" });

    const bad = desk({ direct: async () => ({ ok: false, text: "", provider: "manus", durationMs: 1, error: "no credits" }) });
    const c = await bad.d.make({ name: "Deck", spec: "ten slides" });
    await new Promise((r) => setTimeout(r, 5));
    expect(bad.d.get(c.id)!.status).toBe("failed");
    expect(bad.d.get(c.id)!.error).toContain("no credits");
    expect(bad.made).toEqual(["Deck"]);
    // apps never go to the cloud agent
    await bad.d.make({ name: "Todo", spec: "a todo app" });
    expect(bad.made).toEqual(["Deck", "Todo"]);
  });

  it("creates a real private repo and reuses it", async () => {
    const dir = tmp();
    const gh: string[][] = [];
    const real = await import("../src/providers/base.js");
    const exec: typeof real.runProcess = async (o) => {
      if (o.command === "gh") {
        gh.push(o.args);
        execFileSync("git", ["remote", "add", "origin", "https://example.invalid/x.git"], { cwd: o.cwd });
        return { code: 0, stdout: "", stderr: "", timedOut: false } as Awaited<ReturnType<typeof real.runProcess>>;
      }
      return real.runProcess({ ...o, env: { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    };
    const f = await createRepo("My Great App", "a thing", { dir, remote: "origin", exec });
    expect(insideProjects(f, dir)).toBe(true);
    expect(gh[0].slice(0, 3)).toEqual(["repo", "create", "my-great-app"]);
    expect(gh[0]).toContain("--private");
    expect(readFileSync(join(f, "README.md"), "utf8")).toContain("a thing");
    await createRepo("My Great App", "a thing", { dir, remote: "origin", exec });
    expect(gh).toHaveLength(1);
    expect(insideProjects(join(dir, "..", "other"), dir)).toBe(false);
    expect(insideProjects(dir, dir)).toBe(false);
  });
});
