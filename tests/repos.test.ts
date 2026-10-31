import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findAction, riskOf, type ActionContext } from "../src/actions/registry.js";
import { parseConfig } from "../src/config.js";
import { scopeProblem } from "../src/outside/mcp.js";
import type { ProviderPool } from "../src/providers/registry.js";
import { repoPath, type ManagedRepo } from "../src/repos/actions.js";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A pushed repo with keep.md (mentioned by index.md) and old.md (mentioned by nothing), under orchestrator care. */
function setup(answer = '{"unique": []}', files: Record<string, string> = {}) {
  const base = mkdtempSync(join(tmpdir(), "orc-repos-"));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const remote = join(base, "remote.git");
  const dir = join(base, "work");
  git(base, "init", "--bare", "-b", "main", remote);
  git(base, "clone", remote, dir);
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "T");
  git(dir, "config", "commit.gpgsign", "false");
  const all = { "index.md": "see keep.md\n", "keep.md": "important\n", "old.md": "nothing here\n", ...files };
  for (const [f, text] of Object.entries(all)) writeFileSync(join(dir, f), text);
  git(dir, "add", ".");
  git(dir, "commit", "-m", "start");
  git(dir, "push", "-u", "origin", "main");

  const dataDir = join(base, "data");
  mkdirSync(join(dataDir, "repos"), { recursive: true });
  writeFileSync(join(dataDir, "repos", "registry.json"), JSON.stringify([{ name: "app", dir, createdAt: "now" }]));
  const config = parseConfig({ node: { name: "hub", workRoot: join(base, "work-root") }, dataDir, server: { token: "t" }, cluster: { enabled: false }, context: { graphify: "off" } });
  const reviews: string[] = [];
  const pool = {
    available: async () => ["claude"],
    run: async (_id: string, req: { prompt: string }) => (reviews.push(req.prompt), { ok: true, text: answer, provider: "claude", durationMs: 1 }),
  } as unknown as ProviderPool;
  const ctx: ActionContext = { config, pool };
  const act = (name: string, args: object) => findAction(name)!.run(findAction(name)!.args.parse(args), ctx);
  return { base, dir, remote, ctx, act, reviews, dataDir };
}

const del = (path: string) => ({ repo: "app", path, reason: "no longer used by anything" });

describe("repos the orchestrator looks after", () => {
  it("writes a file, commits and pushes it", async () => {
    const { act, dir, remote } = setup();
    const r = await act("repos.write", { repo: "app", path: "notes/a.md", content: "hello\n", message: "Add a" });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(dir, "notes/a.md"), "utf8")).toBe("hello\n");
    expect(git(remote, "show", "main:notes/a.md")).toBe("hello");
  });

  it("won't write over uncommitted work", async () => {
    const { act, dir } = setup();
    writeFileSync(join(dir, "keep.md"), "my edit\n");
    await expect(act("repos.write", { repo: "app", path: "b.md", content: "x", message: "b" })).rejects.toThrow(/uncommitted/);
    expect(existsSync(join(dir, "b.md"))).toBe(false);
  });

  it("refuses repos it doesn't look after, escapes, .git and secrets", async () => {
    const { act, dir, base } = setup();
    await expect(act("repos.read", { repo: "other", path: "a" })).rejects.toThrow(/not a repo/);
    const repo: ManagedRepo = { name: "app", dir, createdAt: "" };
    expect(() => repoPath(repo, "../x")).toThrow();
    expect(() => repoPath(repo, join(base, "x"))).toThrow();
    expect(() => repoPath(repo, ".git/config")).toThrow(/off limits/);
    expect(() => repoPath(repo, "app/.env")).toThrow(/secret/);
    try {
      symlinkSync(base, join(dir, "out"));
    } catch {
      return; // Windows without the right to make links
    }
    expect(() => repoPath(repo, "out/new.md")).toThrow(/outside/);
  });

  it("deletes a verified file: gone from GitHub, with a copy and a report kept", async () => {
    const { act, dir, remote, dataDir } = setup();
    const r = await act("repos.delete", del("old.md"));
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, "old.md"))).toBe(false);
    expect(git(remote, "ls-tree", "--name-only", "main")).not.toContain("old.md");
    const folder = join(dataDir, "repos", "deleted", "app");
    const kept = join(folder, readdirSync(folder)[0]);
    expect(readFileSync(join(kept, "old.md"), "utf8")).toBe("nothing here\n");
    expect(JSON.parse(readFileSync(join(kept, "report.json"), "utf8"))).toMatchObject({ safe: true, path: "old.md" });
  });

  it("the check changes nothing", async () => {
    const { act, dir } = setup();
    const r = await act("repos.check_delete", del("old.md"));
    expect(r.ok).toBe(true);
    expect(existsSync(join(dir, "old.md"))).toBe(true);
  });

  const refused = async (s: ReturnType<typeof setup>, path: string, gate: string) => {
    const r = await s.act("repos.delete", del(path));
    expect(r.ok).toBe(false);
    expect(r.output).toContain("Not deleted");
    const gates = (r.data as { gates: { gate: string; passed: boolean }[] }).gates;
    expect(gates.find((g) => !g.passed)?.gate).toBe(gate);
    expect(existsSync(join(s.dir, path))).toBe(true);
  };

  it("keeps a file another one mentions", async () => {
    const s = setup();
    await refused(s, "keep.md", "references");
    expect(s.reviews).toEqual([]);
  });

  it("keeps a file that was never committed", async () => {
    const s = setup();
    writeFileSync(join(s.dir, "new.md"), "only here\n");
    const r = await s.act("repos.check_delete", del("new.md"));
    expect(r.ok).toBe(false);
    expect((r.data as { gates: { gate: string; detail: string }[] }).gates[0]).toMatchObject({ gate: "clean", detail: expect.stringContaining("not committed") });
  });

  it("keeps a commit that isn't on GitHub", async () => {
    const s = setup();
    writeFileSync(join(s.dir, "local.md"), "unpushed\n");
    git(s.dir, "add", ".");
    git(s.dir, "commit", "-m", "not pushed");
    const r = await s.act("repos.check_delete", del("local.md"));
    expect((r.data as { gates: { gate: string; passed: boolean }[] }).gates.at(-1)).toMatchObject({ gate: "on_github", passed: false });
  });

  it("keeps what the reviewer says only this file holds", async () => {
    await refused(setup('{"unique": ["the server password rotation date"]}'), "old.md", "review");
  });

  it("fails closed when the review can't be read, or no model is ready", async () => {
    await refused(setup("looks fine to me"), "old.md", "review");
    const s = setup();
    s.ctx.pool = { available: async () => [] } as unknown as ProviderPool;
    await refused(s, "old.md", "review");
  });

  it("keeps binaries, which can't be reviewed", async () => {
    await refused(setup(undefined, { "pic.bin": "a\0b" }), "pic.bin", "review");
  });

  it("keeps a file the tests need", async () => {
    const s = setup(undefined, {
      "package.json": JSON.stringify({ scripts: { test: `node -e "process.exit(require('fs').readdirSync('.').some((f)=>f.startsWith('ne'))?0:1)"` } }),
      "need.txt": "needed\n",
    });
    await refused(s, "need.txt", "tests");
    expect(git(s.dir, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("delete and write ask the owner; reading and checking don't", () => {
    const { ctx } = setup();
    const risk = (name: string, args: object) => riskOf(findAction(name)!, args, ctx);
    expect(risk("repos.delete", del("a"))).toBe("ask");
    expect(risk("repos.write", {})).toBe("ask");
    expect(risk("repos.create", {})).toBe("ask");
    expect(risk("repos.read", {})).toBe("safe");
    expect(risk("repos.check_delete", {})).toBe("safe");
  });

  it("an outside agent held to folders can't use repos", () => {
    const agent = { scopes: { devices: ["*"], folders: ["/home/a"], risk: "ask", memoryWrite: false } } as Parameters<typeof scopeProblem>[0];
    for (const a of ["repos.read", "repos.write", "repos.delete", "repos.list"]) expect(scopeProblem(agent, "hub", a, {})).toMatch(/limited to folders/);
  });
});
