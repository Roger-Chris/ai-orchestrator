import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import { ActionRunner } from "../src/actions/desk.js";
import { parseConfig } from "../src/config.js";
import { FileClient, receiveFile } from "../src/files/client.js";
import { FileIndex, scanRoots } from "../src/files/index.js";
import { mountFiles } from "../src/server/files.js";
import { MemoryReplica } from "../src/shared/replica.js";
import { Store } from "../src/store/db.js";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "orc-dev-"));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const write = (p: string, text = "x") => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};

function setup(raw: Record<string, unknown> = {}) {
  const dir = tmp();
  const root = join(dir, "work");
  mkdirSync(root);
  const config = parseConfig({ node: { name: "hub" }, dataDir: join(dir, "data"), server: { token: "t" }, cluster: { enabled: false }, actions: { roots: [root] }, ...raw });
  return { dir, root, config };
}

describe("desktop actions (D1)", () => {
  it("are listed with their risks", () => {
    const { config } = setup();
    const list = Object.fromEntries(new ActionRunner(config, {}).list().map((a) => [a.name, a.risk]));
    expect(list).toMatchObject({ "apps.focus": "safe", "apps.close": "ask", "screen.shot": "ask", "gui.task": "ask", "files.everywhere": "safe", "files.index": "safe", "files.send": "ask" });
  });

  it("closing and screenshots wait for approval; bad program names are refused", async () => {
    const { config } = setup();
    const r = new ActionRunner(config, {});
    expect(await r.act({ action: "apps.close", args: { app: "notepad" } })).toMatchObject({ status: "needs_approval", summary: "Close notepad (it may ask to save)" });
    expect(await r.act({ action: "screen.shot", args: {} })).toMatchObject({ status: "needs_approval" });
    expect(await r.act({ action: "apps.focus", args: { app: "x; rm -rf /" } })).toMatchObject({ status: "refused" });
  });

  it("gui.task runs the owner's computer-use agent with the goal as one argument", async () => {
    const { config } = setup({ actions: { roots: [tmp()], safe: ["gui.task"], computerUse: { command: process.execPath, args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "{goal}"] } } });
    const res = await new ActionRunner(config, {}).act({ action: "gui.task", args: { goal: "export the board as PDF; then quit", app: "KiCad" } });
    expect(res).toMatchObject({ status: "done", result: { ok: true } });
    expect(JSON.parse((res as any).result.output)).toEqual(["In KiCad: export the board as PDF; then quit"]);
    const none = setup({ actions: { safe: ["gui.task"] } });
    expect(await new ActionRunner(none.config, {}).act({ action: "gui.task", args: { goal: "do it" } })).toMatchObject({ result: { ok: false, output: expect.stringContaining("No computer-use agent") } });
  });
});

describe("files across devices (D2)", () => {
  it("scans names, sizes and dates, skipping tool folders and secrets", () => {
    const { root } = setup();
    write(join(root, "evtol", "zzthrust_test.csv"), "a,b");
    write(join(root, "evtol", ".env"), "KEY=1");
    write(join(root, "app", "node_modules", "x", "index.js"));
    write(join(root, "keys", "id_rsa"));
    write(join(root, ".hidden", "a.txt"));
    const { files, truncated } = scanRoots([root]);
    expect(files.map((f) => f.path.slice(root.length + 1).replace(/\\/g, "/")).sort()).toEqual(["evtol/zzthrust_test.csv"]);
    expect(files[0].size).toBe(3);
    expect(truncated).toBe(false);
    write(join(root, "b.txt"));
    expect(scanRoots([root], 1).truncated).toBe(true);
  });

  it("the hub keeps every device's list, searches it and notes it in the shared memory", async () => {
    const { dir, root, config } = setup();
    write(join(root, "evtol", "zzthrust_test.csv"));
    const store = new Store(join(dir, "data"));
    cleanup.unshift(() => store.close());
    const index = new FileIndex(store.db);
    const replica = new MemoryReplica(join(dir, "m.db"), "hub");

    cleanup.unshift(() => replica.close());
    const files = new FileClient({ config, index, replica });
    expect(await files.reindex()).toMatchObject({ files: 1, roots: [root] });
    index.replace("omen", ["D:/evtol"], [
      { path: "D:/evtol/Thrust Test 2.xlsx", size: 2048, mtime: 2 },
      { path: "D:/evtol/notes.md", size: 10, mtime: 1 },
      { path: "D:/evtol/.env", size: 10, mtime: 1 },
    ]);
    expect((await files.search("thrust")).map((h) => h.node).sort()).toEqual(["hub", "omen"]);
    expect(await files.search("evtol thrust", { node: "omen" })).toEqual([{ node: "omen", path: "D:/evtol/Thrust Test 2.xlsx", name: "Thrust Test 2.xlsx", size: 2048, mtime: 2 }]);
    expect((await files.search("evtol", { ext: ".md" })).map((h) => h.name)).toEqual(["notes.md"]);
    expect(await files.search("env")).toEqual([]); // secrets are never indexed
    expect(await files.search("100%_")).toEqual([]);
    expect(index.nodes().map((n) => [n.node, n.files])).toEqual([["hub", 1], ["omen", 2]]);
    expect(replica.get("device:hub")?.data.fileIndex).toMatchObject({ files: 1, roots: [root] });
    // a fresh list replaces the old one
    index.replace("omen", ["D:/evtol"], []);
    expect(await files.search("thrust", { node: "omen" })).toEqual([]);
  });

  it("another device sends its list to the hub and asks the hub when searching", async () => {
    const { root, config } = setup({ sharedMemory: { hub: "http://hub:4317/" } });
    write(join(root, "plan.md"));
    const calls: { url: string; body?: any; auth?: string }[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: (init?.headers as any)?.Authorization });
      return Response.json(url.includes("search") ? [{ node: "omen", path: "x" }] : { ok: true });
    }) as typeof fetch;
    const files = new FileClient({ config, fetchFn });
    await files.reindex();
    expect(calls[0].url).toBe("http://hub:4317/node/files/index");
    expect(calls[0].auth).toBe("Bearer t");
    expect(calls[0].body).toMatchObject({ node: "hub", roots: [root], files: [{ path: join(root, "plan.md") }] });
    expect(await files.search("x", { node: "omen" })).toEqual([{ node: "omen", path: "x" }]);
    expect(calls[1].url).toBe("http://hub:4317/api/files/search?q=x&node=omen&limit=30");
  });

  it("a received file never replaces one, and stays inside the folders", () => {
    const { root, config } = setup();
    const a = receiveFile(config, "inbox/photo.png", Buffer.from("1"));
    const b = receiveFile(config, "inbox/photo.png", Buffer.from("2"));
    expect(a).toBe(join(root, "inbox", "photo.png"));
    expect(b).toBe(join(root, "inbox", "photo (2).png"));
    expect(readFileSync(a, "utf8")).toBe("1");
    expect(() => receiveFile(config, "../escape.txt", Buffer.from("x"))).toThrow(/bad path/);
    expect(() => receiveFile(config, "inbox/.env", Buffer.from("x"))).toThrow(/secret/);
  });

  it("files.send asks first, then copies to the other device", async () => {
    const { root, config } = setup({ actions: { roots: [], safe: ["files.send"] } });
    const cfg = { ...config, actions: { ...config.actions, roots: [root] } };
    write(join(root, "report.pdf"), "PDF");
    const sent: { node: string; path: string; bytes: string }[] = [];
    const runner = new ActionRunner(cfg, { extra: { sendFile: async (node, path, bytes) => (sent.push({ node, path, bytes: bytes.toString() }), `/mac/work/${path}`) } });
    const res = await runner.act({ action: "files.send", args: { path: "report.pdf", to: "mac", folder: "inbox/" } });
    expect(res).toMatchObject({ status: "done", result: { ok: true, output: "Copied report.pdf to mac: /mac/work/inbox/report.pdf" } });
    expect(sent).toEqual([{ node: "mac", path: "inbox/report.pdf", bytes: "PDF" }]);
    const strict = new ActionRunner(setup().config, {});
    expect(await strict.act({ action: "files.send", args: { path: "report.pdf", to: "mac" } })).toMatchObject({ status: "needs_approval" });
  });

  it("HTTP: a device's list, a received file, search", async () => {
    const { dir, root, config } = setup();
    const store = new Store(join(dir, "data"));
    cleanup.unshift(() => store.close());
    const fileIndex = new FileIndex(store.db);
    const files = new FileClient({ config, index: fileIndex });
    const app = new Hono();
    mountFiles(app, { config, fileIndex, files });
    const post = (path: string, body: BodyInit, type = "application/json") => app.request(path, { method: "POST", headers: { "Content-Type": type }, body });
    expect((await post("/node/files/index", JSON.stringify({ node: "mac", roots: ["/Users/r"], files: [{ path: "/Users/r/cad/drone.step", size: 5, mtime: 1 }] }))).status).toBe(200);
    expect(await (await app.request("/api/files/search?q=drone")).json()).toMatchObject([{ node: "mac", name: "drone.step" }]);
    const got = await (await post("/node/files/receive?path=inbox%2Fa.txt", "hello", "application/octet-stream")).json();
    expect(got.path).toBe(join(root, "inbox", "a.txt"));
    expect((await post("/node/files/receive?path=..%2Fx", "x", "application/octet-stream")).status).toBe(400);
    const elsewhere = new Hono();
    mountFiles(elsewhere, { config });
    expect((await elsewhere.request("/node/files/index", { method: "POST", body: "{}" })).status).toBe(404);
  });
});
