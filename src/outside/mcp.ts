import type { ActionHub } from "../actions/desk.js";
import type { MemoryReplica } from "../shared/replica.js";
import type { OutsideAgent } from "../types.js";
import type { OutsideAgents } from "./agents.js";

/**
 * MCP over HTTP for outside agents (Jarvis A1): JSON-RPC 2.0 on `POST /mcp` with the agent's own
 * token. Tools: the shared memory (read, and write when allowed), the devices it may use, and
 * `act` on them within its scopes. Calls that need the owner's Approve wait for it (risk ceiling
 * "ask") or are refused (ceiling "safe"). Approve/Deny are never offered here.
 */

export const MCP_PROTOCOL = "2025-06-18";

export interface McpDeps {
  agents: OutsideAgents;
  replica?: MemoryReplica;
  actions?: ActionHub;
  /** Online devices by name (this hub first). */
  devices: () => { name: string; online: boolean; platform?: string }[];
}

type Json = Record<string, any>;
interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Json;
}

/** Arguments that name a file or folder, per action. Anything else is checked by the action itself. */
const PATH_ARGS: Record<string, string[]> = {
  "files.list": ["path"], "files.find": ["path"], "files.read": ["path"], "files.write": ["path"],
  "files.copy": ["from", "to"], "files.move": ["from", "to"], "files.send": ["path"], "files.trash": ["path"], "ai.run": ["cwd"], "apps.open": ["target"],
};
/** Actions that can reach anything on the device, so they are refused for an agent held to folders. */
const UNBOUNDED = new Set(["shell.run", "gui.task", "repos.list", "repos.create", "repos.adopt", "repos.sync", "repos.files", "repos.read", "repos.write", "repos.check_delete", "repos.delete"]);

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** Why this call is outside the agent's scopes, or undefined when it is allowed to try. */
export function scopeProblem(agent: OutsideAgent, device: string, action: string, args: Json): string | undefined {
  const s = agent.scopes;
  // It acts inside the owner's signed-in store accounts, so it is only for the owner's own assistant.
  if (action === "shop.cart") return "shop.cart is only for the owner's own assistant";
  if (!s.devices.includes("*") && !s.devices.includes(device)) return `device ${device} is not in this agent's scopes`;
  if (action === "files.send" && !s.devices.includes("*") && !s.devices.includes(String(args.to ?? ""))) return `device ${args.to} is not in this agent's scopes`;
  if (!s.folders.length) return undefined;
  if (UNBOUNDED.has(action)) return `${action} can reach anything on the device, and this agent is limited to folders`;
  for (const key of PATH_ARGS[action] ?? []) {
    const v = args[key];
    if (action === "apps.open" && typeof v === "string" && /^https?:\/\//i.test(v)) continue;
    if (typeof v !== "string" || !v) return `${action} needs an absolute ${key} inside: ${s.folders.join(", ")}`;
    if (!/^([a-z]:)?[\\/]/i.test(v) || /(^|[\\/])\.\.([\\/]|$)/.test(v)) return `${key} must be an absolute path without ".." (inside ${s.folders.join(", ")})`;
    const p = norm(v);
    if (!s.folders.some((f) => p === norm(f) || p.startsWith(`${norm(f)}/`))) return `${v} is outside this agent's folders (${s.folders.join(", ")})`;
  }
  return undefined;
}

const TOOLS = (agent: OutsideAgent) => [
  { name: "memory_search", description: "Search the owner's shared memory (people, projects, facts, decisions, work done).", inputSchema: { type: "object", properties: { query: { type: "string" }, kind: { type: "string" }, limit: { type: "number" } }, required: ["query"] } },
  { name: "memory_about", description: "Everything the shared memory knows about one person, project, place or device.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  ...(agent.scopes.memoryWrite
    ? [{ name: "memory_remember", description: "Add a note, fact or decision to the shared memory.", inputSchema: { type: "object", properties: { text: { type: "string" }, kind: { type: "string", enum: ["note", "fact", "decision"] }, subject: { type: "string" } }, required: ["text"] } }]
    : []),
  ...(agent.scopes.devices.length
    ? [
        { name: "devices", description: "The owner's devices this agent may use, and whether they are online.", inputSchema: { type: "object", properties: {} } },
        {
          name: "act",
          description: `Run an action on a device (actions: files.list, files.find, files.read, files.write, files.copy, files.move, files.everywhere, files.send, system.info, apps.list, apps.open, apps.focus, ai.run, memory.search…). ${agent.scopes.risk === "ask" ? "Risky ones wait for the owner's Approve on the phone and return PENDING." : "Only safe actions are allowed; risky ones are refused."}${agent.scopes.folders.length ? ` File paths must be absolute and inside: ${agent.scopes.folders.join(", ")}.` : ""}`,
          inputSchema: { type: "object", properties: { device: { type: "string" }, action: { type: "string" }, args: { type: "object" }, reason: { type: "string" } }, required: ["device", "action", "reason"] },
        },
      ]
    : []),
];

const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

export async function handleMcp(agent: OutsideAgent, msg: RpcRequest, d: McpDeps): Promise<Json | undefined> {
  const reply = (result: Json) => ({ jsonrpc: "2.0", id: msg.id ?? null, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined && msg.method.startsWith("notifications/")) return undefined; // notifications get no answer
  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: msg.params?.protocolVersion ?? MCP_PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "orchestrator-outside", version: "0.1.0" }, instructions: `You are "${agent.name}", an outside agent with limited access to the owner's devices and memory. Every call is logged.` });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS(agent) });
    case "tools/call":
      return reply(await callTool(agent, String(msg.params?.name ?? ""), (msg.params?.arguments as Json) ?? {}, d));
    default:
      return error(-32601, `unknown method ${msg.method}`);
  }
}

async function callTool(agent: OutsideAgent, name: string, args: Json, d: McpDeps) {
  const audit = (summary: string, outcome: "ok" | "pending" | "refused" | "error", detail?: string) => d.agents.audit(agent, name, summary, outcome, detail);
  if (d.agents.paused) {
    audit(name, "refused", "paused by the owner");
    return text("Outside agents are paused by the owner right now.", true);
  }
  if (!TOOLS(agent).some((t) => t.name === name)) {
    audit(name, "refused", "not allowed");
    return text(`Tool ${name} is not available to this agent.`, true);
  }
  try {
    switch (name) {
      case "memory_search": {
        if (!d.replica) return text("The shared memory is off on this hub.", true);
        const hits = d.replica.search(String(args.query ?? ""), { kind: args.kind ? String(args.kind) : undefined, limit: Math.min(30, Number(args.limit ?? 10)) });
        audit(`search "${String(args.query).slice(0, 80)}"`, "ok", `${hits.length} hits`);
        return text(hits.map((h) => `[${h.kind}] ${h.title}${h.body ? `: ${h.body.slice(0, 300)}` : ""} (${h.uid})`).join("\n") || "Nothing found.");
      }
      case "memory_about": {
        if (!d.replica) return text("The shared memory is off on this hub.", true);
        const r = d.replica.about(String(args.name ?? ""));
        audit(`about ${String(args.name).slice(0, 80)}`, r ? "ok" : "error");
        return r ? text(JSON.stringify(r, null, 1).slice(0, 12_000)) : text(`Nothing known about ${args.name}.`, true);
      }
      case "memory_remember": {
        if (!d.replica) return text("The shared memory is off on this hub.", true);
        const kind = ["note", "fact", "decision"].includes(String(args.kind)) ? String(args.kind) : "note";
        const t = String(args.text ?? "").trim();
        if (!t) return text("Nothing to remember.", true);
        const subject = args.subject ? d.replica.resolve(String(args.subject))?.uid : undefined;
        const rec = d.replica.put({ kind, title: t.slice(0, 120), body: t, subject, source: `outside:${agent.name}`, tags: ["outside-agent"] });
        audit(`remember ${kind}: ${t.slice(0, 120)}`, "ok", rec.uid);
        return text(`Saved as ${rec.uid}.`);
      }
      case "devices": {
        const list = d.devices().filter((x) => agent.scopes.devices.includes("*") || agent.scopes.devices.includes(x.name));
        audit("list devices", "ok");
        return text(list.map((x) => `${x.name}: ${x.online ? "online" : "offline"}${x.platform ? ` (${x.platform})` : ""}`).join("\n") || "No devices in this agent's scopes.");
      }
      case "act": {
        if (!d.actions) return text("Device actions are off on this hub.", true);
        const device = String(args.device ?? "");
        const action = String(args.action ?? "");
        const a = (args.args as Json) ?? {};
        const summary = `${action} on ${device}: ${JSON.stringify(a).slice(0, 200)}`;
        const why = scopeProblem(agent, device, action, a);
        if (why) {
          audit(summary, "refused", why);
          return text(`REFUSED: ${why}.`, true);
        }
        const reason = `[outside agent ${agent.name}] ${String(args.reason ?? "").slice(0, 400)}`;
        const res = await d.actions.act(device, { action, args: a, reason }, { noApprovals: agent.scopes.risk === "safe", by: `agent:${agent.name}` });
        if (res.status === "done") {
          let out = res.result.output;
          // files.everywhere searches every device: keep only what this agent may see
          if (action === "files.everywhere" && Array.isArray(res.result.data)) {
            const hits = (res.result.data as { node: string; path: string }[]).filter((h) => !scopeProblem(agent, h.node, "files.read", { path: h.path }));
            out = hits.map((h) => `${h.node}: ${h.path}`).join("\n") || "Nothing in this agent's scopes matches.";
          }
          audit(summary, res.result.ok ? "ok" : "error", out.slice(0, 500));
          return text(`${res.result.ok ? "OK" : "FAILED"} on ${device}:\n${out}`, !res.result.ok);
        }
        if (res.status === "pending") {
          audit(summary, "pending", res.approval.id);
          return text(`PENDING: waiting for the owner's Approve on the phone (${res.approval.summary}). It has not run.`);
        }
        const err = res.status === "refused" ? res.error : "the device asked for approval";
        audit(summary, "refused", err);
        return text(`REFUSED: ${err}`, true);
      }
    }
  } catch (e) {
    audit(name, "error", (e as Error).message);
    return text(`Error: ${(e as Error).message}`, true);
  }
  return text(`Tool ${name} is not available.`, true);
}
