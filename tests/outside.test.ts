import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import { ActionHub, ActionRunner, ApprovalDesk } from "../src/actions/desk.js";
import { parseConfig } from "../src/config.js";
import { OutsideAgents } from "../src/outside/agents.js";
import { scopeProblem } from "../src/outside/mcp.js";
import { mountOutside } from "../src/server/outside.js";
import { MemoryReplica } from "../src/shared/replica.js";
import { Store } from "../src/store/db.js";
import type { OutsideAgent } from "../src/types.js";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "orc-out-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "work");
  mkdirSync(join(root, "cad"), { recursive: true });
  writeFileSync(join(root, "cad", "drone.step"), "STEP");
  writeFileSync(join(root, "diary.txt"), "private");
  const config = parseConfig({ node: { name: "hub" }, dataDir: join(dir, "data"), server: { token: "owner-token" }, cluster: { enabled: false }, actions: { roots: [root] } });
  const store = new Store(join(dir, "data"));
  cleanup.unshift(() => store.close());
  const replica = new MemoryReplica(join(dir, "m.db"), "hub");
  replica.put({ uid: "project:drone", kind: "project", title: "Drone", body: "eVTOL drone with coaxial rotors" });
  const outside = new OutsideAgents(store, replica);
  const desk = new ApprovalDesk(store.db, config, () => undefined);
  const actions = new ActionHub(new ActionRunner(config, { replica }), desk, async (node, req) => ({ status: "refused", node, action: req.action, error: "offline" }));
  const app = new Hono();
  mountOutside(app, { outside, replica, actions, devices: () => [{ name: "hub", online: true, platform: "linux" }, { name: "mac", online: false }] });
  let n = 0;
  const rpc = (token: string, method: string, params?: unknown) =>
    app.request("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) });
  const call = async (token: string, name: string, args: unknown) => (await (await rpc(token, "tools/call", { name, arguments: args })).json()).result;
  return { root, store, replica, outside, desk, app, rpc, call };
}

describe("outside agents (phase 4)", () => {
  it("A1: tokens are shown once, stored hashed, and only open /mcp", async () => {
    const s = setup();
    const { agent, token } = s.outside.create("Research bot", { devices: [], folders: [], risk: "safe", memoryWrite: false });
    expect(token).toMatch(/^oa_[0-9a-f]{48}$/);
    expect(JSON.stringify(s.store.db.prepare("SELECT * FROM outside_agents").all())).not.toContain(token);
    expect(s.outside.verify(token)?.id).toBe(agent.id);
    expect(s.outside.verify("oa_wrong")).toBeUndefined();
    expect((await s.rpc("owner-token", "tools/list")).status).toBe(401); // the owner's token is not an agent token
    const init = await (await s.rpc(token, "initialize", { protocolVersion: "2025-06-18" })).json();
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
    const notified = await s.app.request("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(notified.status).toBe(202);
    const tools = (await (await s.rpc(token, "tools/list")).json()).result.tools.map((t: any) => t.name);
    expect(tools).toEqual(["memory_search", "memory_about"]); // no devices, no memory writes
    expect((await s.call(token, "memory_search", { query: "drone" })).content[0].text).toContain("[project] Drone");
    expect(await s.call(token, "memory_remember", { text: "x" })).toMatchObject({ isError: true });
    s.outside.revoke(agent.id);
    expect((await s.rpc(token, "tools/list")).status).toBe(401);
  });

  it("A1: scopes hold devices, folders and the risk ceiling", async () => {
    const s = setup();
    const { token } = s.outside.create("CAD helper", { devices: ["hub"], folders: [join(s.root, "cad")], risk: "safe", memoryWrite: true });
    const read = await s.call(token, "act", { device: "hub", action: "files.read", args: { path: join(s.root, "cad", "drone.step") }, reason: "read the model" });
    expect(read.content[0].text).toBe("OK on hub:\nSTEP");
    expect((await s.call(token, "act", { device: "hub", action: "files.read", args: { path: join(s.root, "diary.txt") }, reason: "x" })).content[0].text).toContain("outside this agent's folders");
    expect((await s.call(token, "act", { device: "hub", action: "files.read", args: { path: `${join(s.root, "cad")}/../diary.txt` }, reason: "x" })).content[0].text).toContain('without ".."');
    expect((await s.call(token, "act", { device: "hub", action: "files.read", args: { path: "diary.txt" }, reason: "x" })).content[0].text).toContain("absolute path");
    expect((await s.call(token, "act", { device: "mac", action: "system.info", args: {}, reason: "x" })).content[0].text).toContain("device mac is not in this agent's scopes");
    expect((await s.call(token, "act", { device: "hub", action: "shell.run", args: { command: "ls" }, reason: "x" })).content[0].text).toContain("limited to folders");
    // a write would need the owner's Approve: a safe-only agent is refused and no approval is made
    const write = await s.call(token, "act", { device: "hub", action: "files.write", args: { path: join(s.root, "cad", "notes.md"), content: "hi" }, reason: "x" });
    expect(write.content[0].text).toContain("REFUSED: this needs the owner's approval");
    expect(s.desk.list()).toEqual([]);
    expect((await s.call(token, "memory_remember", { text: "Drone frame is carbon", kind: "fact", subject: "Drone" })).content[0].text).toMatch(/^Saved as fact:/);
  });

  it("A1: an ask-level agent's risky call waits for the owner, marked as the agent's", async () => {
    const s = setup();
    const { token } = s.outside.create("Builder", { devices: ["*"], folders: [], risk: "ask", memoryWrite: false });
    const r = await s.call(token, "act", { device: "hub", action: "files.write", args: { path: "plan.md", content: "hi" }, reason: "write the plan" });
    expect(r.content[0].text).toContain("PENDING: waiting for the owner's Approve");
    expect(s.desk.list()[0]).toMatchObject({ action: "files.write", reason: "[outside agent Builder] write the plan", by: "agent:Builder" });
    expect((await s.call(token, "devices", {})).content[0].text).toBe("hub: online (linux)\nmac: offline");
  });

  it("scopeProblem", () => {
    const a = { scopes: { devices: ["omen"], folders: ["C:\\dev\\cad"], risk: "safe", memoryWrite: false } } as OutsideAgent;
    expect(scopeProblem(a, "omen", "files.list", { path: "c:/DEV/cad/parts" })).toBeUndefined();
    expect(scopeProblem(a, "omen", "files.list", { path: "C:/dev/cadx" })).toContain("outside");
    expect(scopeProblem(a, "omen", "apps.open", { target: "https://example.com" })).toBeUndefined();
    expect(scopeProblem(a, "omen", "files.send", { path: "C:/dev/cad/a", to: "mac" })).toContain("device mac");
  });

  it("A2: every call is audited, here and in the shared memory, and the kill switch stops them all", async () => {
    const s = setup();
    const { agent, token } = s.outside.create("Research bot", { devices: [], folders: [], risk: "safe", memoryWrite: false });
    await s.call(token, "memory_search", { query: "drone" });
    await s.call(token, "act", { device: "hub", action: "system.info" });
    const log = s.outside.auditLog();
    expect(log.map((e) => [e.tool, e.outcome])).toEqual([["act", "refused"], ["memory_search", "ok"]]);
    const day = new Date().toISOString().slice(0, 10);
    const mem = s.replica.get(`work:outside-${agent.id}-${day}`)!;
    expect(mem.title).toBe(`Outside agent Research bot on ${day}`);
    expect(mem.body.split("\n")).toHaveLength(2);
    expect(s.outside.get(agent.id)?.calls).toBe(2);

    const owner = (path: string, init?: RequestInit) => s.app.request(path, init);
    expect((await (await owner("/api/outside-agents/paused", { method: "PUT", body: JSON.stringify({ paused: true }) })).json()).paused).toBe(true);
    expect(await s.call(token, "memory_search", { query: "drone" })).toMatchObject({ isError: true, content: [{ text: "Outside agents are paused by the owner right now." }] });
    await owner("/api/outside-agents/paused", { method: "PUT", body: JSON.stringify({ paused: false }) });
    expect((await s.call(token, "memory_search", { query: "drone" })).isError).toBeUndefined();

    const created = await (await owner("/api/outside-agents", { method: "POST", body: JSON.stringify({ name: "Codex cloud", scopes: { devices: ["omen"], risk: "ask" } }) })).json();
    expect(created.token).toMatch(/^oa_/);
    expect(created.agent.scopes).toEqual({ devices: ["omen"], folders: [], risk: "ask", memoryWrite: false });
    const list = await (await owner("/api/outside-agents")).json();
    expect(list.agents.map((a: any) => a.name)).toEqual(["Codex cloud", "Research bot"]);
    expect(JSON.stringify(list)).not.toContain(created.token);
    expect((await owner(`/api/outside-agents/${created.agent.id}/revoke`, { method: "POST" })).status).toBe(200);
    expect((await (await owner("/api/outside-agents/audit?limit=2")).json())).toHaveLength(2);
  });
});
