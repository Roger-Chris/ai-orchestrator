import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ModelRouter } from "../src/ai/route.js";
import { ToolRegistry } from "../src/ai/tools.js";
import { buildCapabilities } from "../src/brain/capabilities.js";
import { Cluster, type PeerState } from "../src/cluster/cluster.js";
import { parseConfig } from "../src/config.js";
import type { Provider } from "../src/providers/base.js";
import { ProviderPool } from "../src/providers/registry.js";
import { Store } from "../src/store/db.js";
import type { ProviderId } from "../src/types.js";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));

const provider = (id: ProviderId, ready: boolean, calls: string[]): Provider => ({
  id,
  detect: async () => ({ id, installed: ready, authenticated: ready }),
  run: async () => (calls.push(`here:${id}`), { ok: true, text: `${id} here`, provider: id, durationMs: 1 }),
});

const laptop = (over: Partial<PeerState> = {}): PeerState => ({ name: "laptop", version: "1", url: "http://laptop:4317", via: "tailscale", online: true, providers: [{ id: "local", ready: true, load: 0 }], ...over });

function setup(localHere = false) {
  const dataDir = mkdtempSync(join(tmpdir(), "orc-borrow-"));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const config = parseConfig({ node: { name: "hub" }, dataDir, server: { token: "t" }, cluster: { tailscale: false }, context: { graphify: "off" } });
  const store = new Store(dataDir);
  cleanup.unshift(() => store.close());
  const calls: string[] = [];
  const ids: ProviderId[] = ["claude", "codex", "gemini", "perplexity", "groq", "manus", "hermes"];
  const pool = new ProviderPool(config, store, { ...Object.fromEntries(ids.map((id) => [id, provider(id, false, calls)])), local: provider("local", localHere, calls) });
  const cluster = new Cluster(config, pool);
  const run = cluster.run.bind(cluster);
  cluster.run = async (node, id, req) => (node === "hub" ? run(node, id, req) : (calls.push(`${node}:${id}`), { ok: true, text: `${id} on ${node}`, provider: id, durationMs: 1 }));
  const tools = new ToolRegistry({ config, pool, capabilities: buildCapabilities(config.routing.overrides), usage: () => store.usage(1), borrow: (id) => cluster.borrowFor(id), http: (async () => Response.json({ models: [] })) as typeof fetch });
  const models = new ModelRouter({ tools: () => tools.list(), pool, store, node: "hub", cluster });
  return { cluster, tools, models, calls, store };
}

describe("borrowing a peer's local model", () => {
  it("runs the hub's job on the laptop when this machine has no model", async () => {
    const { cluster, tools, models, calls, store } = setup();
    cluster.peers.set("laptop", laptop());
    expect((await tools.list()).find((t) => t.id === "local")).toMatchObject({ state: "ready", detail: "runs on laptop" });
    const r = await models.run("mail", { prompt: "read this" });
    expect(r.text).toBe("local on laptop");
    expect(calls).toEqual(["laptop:local"]);
    expect(store.usage(1).find((u: { provider: string }) => u.provider === "local")).toMatchObject({ node: "laptop" });
  });

  it("uses this machine's own model first", async () => {
    const { cluster, models, calls } = setup(true);
    cluster.peers.set("laptop", laptop());
    await models.run("mail", { prompt: "read this" });
    expect(calls).toEqual(["here:local"]);
  });

  it("leaves the tool out while the laptop is away", async () => {
    const { cluster, tools, models } = setup();
    cluster.peers.set("laptop", laptop({ online: false }));
    expect((await tools.list()).find((t) => t.id === "local")?.state).toBe("not_set_up");
    await expect(models.run("mail", { prompt: "read this" })).rejects.toThrow(/no model/);
  });

  it("never borrows a subscription tool", async () => {
    const { cluster } = setup();
    cluster.peers.set("laptop", laptop({ providers: [{ id: "claude", ready: true, load: 0 }] }));
    expect(await cluster.borrowFor("claude")).toBeUndefined();
  });

  it("marks a device offline when it leaves the tailnet", async () => {
    const { cluster } = setup();
    cluster.peers.set("laptop", laptop());
    await cluster.refresh();
    expect(cluster.peers.get("laptop")?.online).toBe(false);
    expect(await cluster.borrowFor("local")).toBeUndefined();
  });
});
