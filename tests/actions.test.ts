import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import { ActionRunner, argsHash } from "../src/actions/desk.js";
import { redact, shellRisk } from "../src/actions/registry.js";
import { buildActions } from "../src/actions/setup.js";
import { parseConfig } from "../src/config.js";
import { mountActions } from "../src/server/actions.js";
import { Store } from "../src/store/db.js";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));

function tmp() {
  const d = mkdtempSync(join(tmpdir(), "orc-act-"));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function device(name: string, extra: Record<string, unknown> = {}) {
  const root = tmp();
  const config = parseConfig({ node: { name }, server: { token: "t" }, actions: { roots: [root] }, ...extra });
  const store = new Store(tmp());
  return { root, config, store };
}

describe("action risks", () => {
  it("safe-listed commands run; anything chained or unknown asks; password tools are refused", () => {
    const { config } = device("omen");
    expect(shellRisk("git status", config)).toBe("safe");
    expect(shellRisk("git log --oneline -5", config)).toBe("safe");
    expect(shellRisk("git status; rm -rf /", config)).toBe("ask");
    expect(shellRisk("git log | sh", config)).toBe("ask");
    expect(shellRisk("git statusx", config)).toBe("ask");
    expect(shellRisk("npm install", config)).toBe("ask");
    expect(shellRisk("sudo apt install x", config)).toBe("never");
  });

  it("tokens never leave the device in action output", () => {
    const out = redact("origin https://Roger-Chris:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/x.git and key AIzaSyA1234567890abcdefghijklmnopqrstuv");
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("AIza");
    expect(out).toContain("https://***@github.com/x.git");
  });
});

describe("running actions on a device", () => {
  it("reads and finds files inside the allowed folders only, never secrets", async () => {
    const { root, config } = device("omen");
    mkdirSync(join(root, "evtol"));
    writeFileSync(join(root, "evtol", "thrust_test.csv"), "rpm,thrust\n1000,2.1\n");
    writeFileSync(join(root, "evtol", ".env"), "KEY=secret");
    const r = new ActionRunner(config, {});
    const read = await r.act({ action: "files.read", args: { path: "evtol/thrust_test.csv" } });
    expect(read).toMatchObject({ status: "done", result: { ok: true } });
    expect((read as any).result.output).toContain("1000,2.1");
    const found = await r.act({ action: "files.find", args: { name: "thrust" } });
    expect((found as any).result.output).toContain("thrust_test.csv");
    const listed = await r.act({ action: "files.list", args: { path: "evtol" } });
    expect((listed as any).result.output).not.toContain(".env");
    const secret = await r.act({ action: "files.read", args: { path: "evtol/.env" } });
    expect((secret as any).result).toMatchObject({ ok: false });
    expect((secret as any).result.output).toMatch(/secret/);
    const outside = await r.act({ action: "files.read", args: { path: join(tmp(), "x.txt") } });
    expect((outside as any).result.ok).toBe(false);
    const escape = await r.act({ action: "files.list", args: { path: ".." } });
    expect((escape as any).result.output).toMatch(/outside the folders/);
  });

  it("a safe-listed command really runs, in an allowed folder", async () => {
    const { root, config } = device("omen");
    const r = (await new ActionRunner(config, {}).act({ action: "shell.run", args: { command: "pwd" } })) as any;
    expect(r).toMatchObject({ status: "done", result: { ok: true } });
    expect(r.result.output.trim().toLowerCase()).toContain(root.split(/[\\/]/).pop()!.toLowerCase());
  });

  it("changes need an approval; unknown actions and bad arguments are refused", async () => {
    const { root, config } = device("omen");
    const r = new ActionRunner(config, {});
    expect(await r.act({ action: "files.write", args: { path: "a.txt", content: "x" } })).toMatchObject({ status: "needs_approval", summary: "Write 1 characters to a.txt" });
    expect(existsSync(join(root, "a.txt"))).toBe(false);
    expect(await r.act({ action: "files.delete", args: { path: "a.txt" } })).toMatchObject({ status: "refused" });
    expect(await r.act({ action: "files.read", args: {} })).toMatchObject({ status: "refused" });
    // a made-up approval id does not work
    expect(await r.act({ action: "files.write", args: { path: "a.txt", content: "x" }, approval: "nope" })).toMatchObject({ status: "refused" });
  });

  it("the owner's config can make an action safe or forbid it", async () => {
    const { config } = device("omen", {});
    config.actions.safe = ["files.write"];
    config.actions.never = ["shell.run"];
    const r = new ActionRunner(config, {});
    expect(await r.act({ action: "files.write", args: { path: "b.txt", content: "y" } })).toMatchObject({ status: "done" });
    expect(await r.act({ action: "shell.run", args: { command: "git status" } })).toMatchObject({ status: "refused" });
  });

  it("read-only AI questions run at once; letting an AI tool change files asks", async () => {
    const { config } = device("omen");
    const calls: any[] = [];
    const pool = { run: async (id: string, req: any) => (calls.push({ id, req }), { ok: true, text: "the answer", durationMs: 5 }) } as any;
    const r = new ActionRunner(config, { pool });
    const res = await r.act({ action: "ai.run", args: { tool: "antigravity", task: "summarise the README" } });
    expect(res).toMatchObject({ status: "done", result: { ok: true, output: "the answer" } });
    expect(calls[0]).toMatchObject({ id: "gemini", req: { permission: "read" } });
    expect(await r.act({ action: "ai.run", args: { tool: "claude", task: "fix the bug", write: true } })).toMatchObject({ status: "needs_approval" });
  });
});

describe("approvals", () => {
  it("approve runs exactly that call once, keeps the old file, and records the result", async () => {
    const { root, config, store } = device("hub");
    writeFileSync(join(root, "notes.md"), "old notes");
    const hub = buildActions(config, { store });
    const pending = await hub.act(undefined, { action: "files.write", args: { path: "notes.md", content: "new notes" }, reason: "update the plan" });
    expect(pending.status).toBe("pending");
    const id = (pending as any).approval.id;
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("old notes"); // nothing happens before Approve
    expect(hub.desk.list("pending").map((a) => a.id)).toEqual([id]);

    const done = await hub.decide(id, true);
    expect(done.status).toBe("done");
    expect(done.result?.output).toMatch(/old version kept as notes\.md\.bak-/);
    expect(readFileSync(join(root, "notes.md"), "utf8")).toBe("new notes");
    const bak = readdirSync(root).find((f) => f.startsWith("notes.md.bak-"))!;
    expect(readFileSync(join(root, bak), "utf8")).toBe("old notes");

    // the same approval cannot run anything again
    expect(await hub.runner.act({ action: "files.write", args: { path: "notes.md", content: "again" }, approval: id })).toMatchObject({ status: "refused" });
    await expect(hub.decide(id, true)).rejects.toThrow(/already/);
  });

  it("an approval only covers the exact arguments, and deny runs nothing", async () => {
    const { root, config, store } = device("hub");
    const hub = buildActions(config, { store });
    const p = (await hub.act(undefined, { action: "files.write", args: { path: "a.txt", content: "approved text" } })) as any;
    hub.desk.decide(p.approval.id, true);
    // someone tries to reuse it for different content
    expect(await hub.runner.act({ action: "files.write", args: { path: "a.txt", content: "other text" }, approval: p.approval.id })).toMatchObject({ status: "refused" });

    const q = (await hub.act(undefined, { action: "files.write", args: { path: "b.txt", content: "x" } })) as any;
    expect((await hub.decide(q.approval.id, false)).status).toBe("denied");
    expect(existsSync(join(root, "b.txt"))).toBe(false);
  });

  it("approvals expire", async () => {
    const { config, store } = device("hub");
    const hub = buildActions(config, { store });
    const p = hub.desk.request({ node: "hub", action: "files.write", args: {}, summary: "x" }, Date.now() - 31 * 60_000);
    expect(hub.desk.get(p.id)!.status).toBe("expired");
    expect(() => hub.desk.decide(p.id, true)).toThrow(/expired/);
  });

  it("the Linux hub asks; the laptop runs it after checking the approval with the hub", async () => {
    // Two devices: the hub keeps approvals; the laptop runs the action and checks with the hub.
    const hubDev = device("linux-hub");
    const laptop = device("omen", { sharedMemory: { hub: "http://hub:4317" } });
    const apps: Record<string, Hono> = {};
    const fetchFn: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const app = url.host.startsWith("hub") ? apps.hub : apps.omen;
      return app.request(url.pathname + url.search, init as RequestInit);
    };
    const cluster = { list: () => [{ name: "omen", url: "http://omen:4317", online: true }] } as any;
    const hub = buildActions(hubDev.config, { store: hubDev.store, cluster, fetchFn });
    const lap = buildActions(laptop.config, { store: laptop.store, fetchFn });
    apps.hub = new Hono();
    mountActions(apps.hub, { actions: hub });
    apps.omen = new Hono();
    mountActions(apps.omen, { actions: lap });

    // over HTTP, the way the brain will call it
    const res = await apps.hub.request("/api/act", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node: "omen", action: "files.write", args: { path: "plan.md", content: "# plan" }, reason: "save the plan" }),
    });
    const pending = (await res.json()) as any;
    expect(pending).toMatchObject({ status: "pending", node: "omen" });
    expect(existsSync(join(laptop.root, "plan.md"))).toBe(false);

    const approved = await (await apps.hub.request(`/api/approvals/${pending.approval.id}/approve`, { method: "POST" })).json();
    expect(approved).toMatchObject({ status: "done", result: { ok: true } });
    expect(readFileSync(join(laptop.root, "plan.md"), "utf8")).toBe("# plan");

    // a safe action on the laptop goes straight through
    const list = await (await apps.hub.request("/api/act", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ node: "omen", action: "files.list", args: {} }) })).json();
    expect(list).toMatchObject({ status: "done", node: "omen" });
    // and an unknown device is refused, not hung
    const ghost = await (await apps.hub.request("/api/act", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ node: "mac", action: "files.list" }) })).json();
    expect(ghost).toMatchObject({ status: "refused" });
  });

  it("the approval hash ignores key order", () => {
    expect(argsHash("a", { x: 1, y: { b: 2, a: 1 } })).toBe(argsHash("a", { y: { a: 1, b: 2 }, x: 1 }));
    expect(argsHash("a", { x: 1 })).not.toBe(argsHash("a", { x: 2 }));
  });
});
