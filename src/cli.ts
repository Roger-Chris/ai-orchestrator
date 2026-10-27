#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { loadAgents } from "./agents/loader.js";
import { buildCapabilities } from "./brain/capabilities.js";
import { Orchestrator } from "./brain/orchestrator.js";
import { Router } from "./brain/router.js";
import { Cluster } from "./cluster/cluster.js";
import { workspaceMap } from "./context/graphify.js";
import { Memory } from "./memory/memory.js";
import { tailnetDevices, tailscaleIPv4 } from "./cluster/tailscale.js";
import { type Config, loadConfig } from "./config.js";
import { probeVersion } from "./providers/base.js";
import { ProviderPool } from "./providers/registry.js";
import { createApp } from "./server/app.js";
import { Store } from "./store/db.js";
import type { Permission, ProviderId, RunEvent, RunMode } from "./types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function buildSystem(config: Config) {
  const store = new Store(resolve(config.dataDir));
  const pool = new ProviderPool(config, store);
  const cluster = new Cluster(config, pool);
  const router = new Router(buildCapabilities(config.routing.overrides), { localBias: config.cluster.localBias, learn: config.brain.learnFromFeedback }, store);
  const agents = loadAgents([resolve(ROOT, "agents"), resolve(process.cwd(), "agents")]);
  const memory = new Memory(config, store);
  const orchestrator = new Orchestrator(config, store, cluster, router, agents, { memory, workspace: (cwd) => workspaceMap(cwd, config) });
  return { store, pool, cluster, router, orchestrator, agents, memory };
}

async function bindHosts(config: Config): Promise<string[]> {
  const h = config.server.host;
  if (h === "tailscale") {
    const ip = await tailscaleIPv4();
    if (!ip) console.warn("! server.host is 'tailscale' but Tailscale is not connected; serving on loopback only.");
    return ip ? ["127.0.0.1", ip] : ["127.0.0.1"];
  }
  const host = h === "auto" ? (config.server.token ? "0.0.0.0" : "127.0.0.1") : h;
  if (host !== "127.0.0.1" && host !== "localhost" && !config.server.token) {
    console.warn("! Refusing to expose the server without server.token (run `orc init`). Serving on loopback only.");
    return ["127.0.0.1"];
  }
  return [host];
}

async function cmdServe(config: Config) {
  const sys = buildSystem(config);
  sys.store.failStaleRuns();
  const app = createApp({ ...sys, config, publicDir: relative(process.cwd(), resolve(ROOT, "public")) || "." });
  const hosts = await bindHosts(config);
  for (const hostname of hosts) serve({ fetch: app.fetch, port: config.server.port, hostname });
  sys.cluster.start();

  const status = await sys.pool.status();
  console.log(`\n  AI Orchestrator · device "${config.node.name}"`);
  for (const host of hosts) console.log(`  → http://${host === "0.0.0.0" ? "localhost" : host}:${config.server.port}`);
  console.log(`  → OpenAI-compatible: http://localhost:${config.server.port}/v1  (model: orchestrator | auto | claude | codex | gemini | perplexity | agent:<name>)\n`);
  for (const s of status) console.log(`  ${s.installed && s.authenticated ? "✓" : "✗"} ${s.id.padEnd(10)} ${s.version ?? ""} ${s.detail ?? ""}`);
  console.log(`  ${sys.agents.size} agents loaded · cluster ${config.cluster.enabled ? `on (tailscale discovery ${config.cluster.tailscale ? "on" : "off"})` : "off"}\n`);
}

function printEvent(ev: RunEvent, verbose: boolean) {
  const d = ev.data as any;
  const tag = ev.stepId ? `[${ev.stepId}] ` : "";
  switch (ev.type) {
    case "run.classified":
      console.error(`· classified: ${d.kind} (${d.complexity})${d.alsoKinds.length ? ` + ${d.alsoKinds.join(", ")}` : ""}`);
      break;
    case "plan.created":
      console.error(`· plan: ${d.steps.length} step(s)`);
      for (const s of d.steps) console.error(`   ${s.id} ${s.agent ?? s.kind}: ${s.title}${s.dependsOn.length ? ` ← ${s.dependsOn.join(", ")}` : ""}`);
      break;
    case "step.started":
      console.error(`▶ ${tag}${d.title}`);
      break;
    case "step.progress":
      console.error(`  ${tag}${d.note}`);
      break;
    case "step.delta":
      if (verbose) process.stderr.write(d.text);
      break;
    case "step.completed":
      console.error(`✓ ${tag}${d.provider} @ ${d.node} in ${(d.durationMs / 1000).toFixed(1)}s`);
      break;
    case "step.failed":
      console.error(`✗ ${tag}${d.error}`);
      break;
    case "step.fallback":
      console.error(`↻ ${tag}falling back to ${d.to} @ ${d.node}`);
      break;
    case "design.approved":
      console.error(`· design approved${d.savedTo ? `, saved to ${d.savedTo}` : ""}; planning the build`);
      break;
    case "design.revising":
      console.error("· sending the design back for revision");
      break;
  }
}

/** Shows the draft and the goldfish reviews, then asks you to approve, revise or cancel. */
async function askDesign(orc: Orchestrator, id: string) {
  const run = orc.get(id)!;
  const d = run.design!;
  const step = (sid: string) => run.steps.find((s) => s.id === sid);
  console.log(`\n===== DESIGN (round ${d.round}) =====\n\n${step(d.draftStepId)?.output ?? ""}`);
  for (const sid of d.reviewStepIds) {
    const s = step(sid);
    console.log(`\n===== GOLDFISH REVIEW · ${s?.provider ?? "?"} =====\n\n${s?.output ?? `review failed: ${s?.error}`}`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
  const answer = (await ask("\n[a]pprove and build, [r]evise, [c]ancel? ")).trim().toLowerCase();
  if (answer.startsWith("a")) {
    const notes = (await ask("Which findings to address, or other notes (Enter for none): ")).trim();
    orc.decide(id, { action: "approve", notes: notes || undefined });
  } else if (answer.startsWith("r")) {
    const feedback = (await ask("What should change? ")).trim();
    orc.decide(id, { action: "revise", feedback: feedback || "Address the review findings you agree with." });
  } else orc.cancel(id);
  rl.close();
}

async function cmdRun(config: Config, task: string, v: Record<string, unknown>) {
  if (!task) throw new Error('usage: orc run "<task>" [--mode auto|direct|plan|design] [--provider p] [--agent name] [--cwd dir] [--permission read|edit|full]');
  const sys = buildSystem(config);
  if (config.cluster.enabled) await sys.cluster.refresh();
  const run = sys.orchestrator.submit(task, {
    mode: v.mode as RunMode | undefined,
    provider: v.provider as ProviderId | undefined,
    agent: v.agent as string | undefined,
    cwd: v.cwd as string | undefined,
    permission: v.permission as Permission | undefined,
  });
  sys.orchestrator.subscribe(run.id, (ev) => {
    printEvent(ev, !!v.verbose);
    if (ev.type === "design.review_ready") void askDesign(sys.orchestrator, run.id);
  });
  const done = await sys.orchestrator.wait(run.id)!;
  if (done.status === "done") console.log(`\n${done.result}`);
  else console.error(`\nrun ${done.status}: ${done.error}`);
  sys.store.close();
  process.exitCode = done.status === "done" ? 0 : 1;
}

async function cmdDoctor(config: Config, live: boolean) {
  const sys = buildSystem(config);
  for (const s of await sys.pool.status(true)) {
    console.log(`${s.installed && s.authenticated ? "✓" : "✗"} ${s.id.padEnd(10)} ${s.command ?? ""} ${s.version ?? ""}`);
    if (s.detail) console.log(`    ${s.detail}`);
    if (live && s.installed && s.authenticated) {
      const r = await sys.pool.run(s.id, { prompt: "Reply with exactly: OK", permission: "read", timeoutMs: 180_000 });
      console.log(`    live test: ${r.ok ? `OK (${(r.durationMs / 1000).toFixed(1)}s${r.model ? `, ${r.model}` : ""})` : `FAILED: ${r.error?.slice(0, 300)}`}`);
    }
  }
  const devices = await tailnetDevices();
  console.log(devices.length ? `\nTailscale: ${devices.length} device(s) on your tailnet` : "\nTailscale: not running or logged out (multi-device discovery disabled)");
  for (const d of devices) console.log(`  ${d.self ? "*" : " "} ${d.hostName.padEnd(20)} ${d.ips[0] ?? ""} ${d.online ? "online" : "offline"} ${d.os ?? ""}`);
  const graphify = await probeVersion(config.context.graphifyCommand);
  console.log(`\n${graphify ? "✓" : "✗"} graphify   ${graphify ?? "not installed (optional: uv tool install graphifyy). Gives the planner a code map."}`);
  console.log(`· memory     local${config.memory.enabled ? "" : " (disabled)"} · NotebookLM: ${await sys.memory.notebookStatus()}`);
  if (!live) console.log("\nRun `orc doctor --live` to send a tiny test prompt to each logged-in model.");
  sys.store.close();
}

async function cmdNodes(config: Config) {
  const sys = buildSystem(config);
  await sys.cluster.refresh();
  const self = await sys.cluster.localInfo();
  const line = (n: { name: string; providers: { id: string; ready: boolean }[] }, extra = "") =>
    console.log(`${n.name.padEnd(20)} ${n.providers.map((p) => `${p.ready ? "✓" : "✗"}${p.id}`).join("  ")} ${extra}`);
  line(self, "(this device)");
  for (const p of sys.cluster.list()) line(p, `${p.url} ${p.online ? "" : `OFFLINE ${p.error ?? ""}`}`);
  if (!sys.cluster.list().length) console.log("\nNo peers found. Start `orc serve` on your other devices (same ORC_TOKEN, Tailscale connected).");
  sys.store.close();
}

function cmdInit() {
  const cfg = resolve(process.cwd(), "orchestrator.config.yaml");
  if (!existsSync(cfg)) {
    copyFileSync(resolve(ROOT, "orchestrator.config.example.yaml"), cfg);
    console.log(`created ${cfg}`);
  } else console.log(`kept existing ${cfg}`);
  const envPath = resolve(process.cwd(), ".env");
  const env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  if (!/^ORC_TOKEN=/m.test(env)) {
    writeFileSync(envPath, `${env}${env && !env.endsWith("\n") ? "\n" : ""}ORC_TOKEN=${randomBytes(32).toString("hex")}\n# PERPLEXITY_API_KEY=pplx-...\n`);
    console.log(`wrote a new ORC_TOKEN to ${envPath}; copy the SAME token to every device`);
  }
}

/** Minimal MCP (stdio) server that forwards to the running orchestrator, so Claude Code, Codex or Gemini can delegate to it. */
async function cmdMcp(config: Config) {
  const base = `http://127.0.0.1:${config.server.port}`;
  const headers = { "Content-Type": "application/json" };
  const tools = [
    {
      name: "orchestrate",
      description:
        "Hand a task to the multi-model orchestrator. It plans, routes sub-tasks to the best model (Claude, ChatGPT/Codex, Gemini, Perplexity) across your devices, and returns the merged result.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string" },
          mode: { type: "string", enum: ["auto", "direct", "plan"] },
          provider: { type: "string", enum: ["claude", "codex", "gemini", "perplexity"] },
          agent: { type: "string", description: "Specialist agent name, e.g. researcher, pcb-designer, cad-modeler" },
        },
        required: ["task"],
      },
    },
    { name: "list_agents", description: "List the orchestrator's specialist agents.", inputSchema: { type: "object", properties: {} } },
  ];
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === undefined) continue; // notifications need no reply
    try {
      if (msg.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ai-orchestrator", version: "0.1.0" } },
        });
      } else if (msg.method === "tools/list") {
        send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
      } else if (msg.method === "tools/call") {
        const { name, arguments: args } = msg.params;
        let text: string;
        if (name === "list_agents") {
          const agents = (await (await fetch(`${base}/api/agents`)).json()) as { name: string; kind: string; description: string }[];
          text = agents.map((a) => `${a.name} (${a.kind}): ${a.description}`).join("\n");
        } else {
          const res = await fetch(`${base}/api/runs`, { method: "POST", headers, body: JSON.stringify(args) });
          const run = (await res.json()) as { id: string };
          let rec: any;
          do {
            await new Promise((r) => setTimeout(r, 2000));
            rec = await (await fetch(`${base}/api/runs/${run.id}`)).json();
          } while (!["done", "failed", "cancelled"].includes(rec.status));
          text = rec.status === "done" ? rec.result : `Run ${rec.status}: ${rec.error}`;
        }
        send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
      } else if (msg.method === "ping") {
        send({ jsonrpc: "2.0", id: msg.id, result: {} });
      } else {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } });
      }
    } catch (e) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { isError: true, content: [{ type: "text", text: `orchestrator not reachable at ${base}; is \`orc serve\` running? (${(e as Error).message})` }] },
      });
    }
  }
}

async function main() {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c" },
      port: { type: "string", short: "p" },
      mode: { type: "string" },
      provider: { type: "string" },
      agent: { type: "string" },
      cwd: { type: "string" },
      permission: { type: "string" },
      verbose: { type: "boolean", short: "v" },
      live: { type: "boolean" },
    },
  });
  const [cmd = "serve", ...rest] = positionals;
  if (cmd === "init") return cmdInit();
  const { config } = loadConfig(v.config);
  if (v.port) config.server.port = Number(v.port);

  switch (cmd) {
    case "serve":
      return cmdServe(config);
    case "run":
      return cmdRun(config, rest.join(" "), v);
    case "doctor":
    case "providers":
      return cmdDoctor(config, !!v.live);
    case "nodes":
      return cmdNodes(config);
    case "agents":
      for (const a of buildSystem(config).agents.values()) console.log(`${a.name.padEnd(22)} ${a.kind.padEnd(14)} ${a.description}`);
      return;
    case "mcp":
      return cmdMcp(config);
    default:
      console.log(`usage: orc <serve|run "task"|doctor [--live]|nodes|agents|init|mcp>`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
