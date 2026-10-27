import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { runProcess } from "../providers/base.js";

type Exec = typeof runProcess;

interface GraphNode {
  id: string;
  label?: string;
  community?: number;
  community_name?: string;
  source_file?: string;
}
interface Graph {
  nodes: GraphNode[];
  links?: { source: string; target: string }[];
  built_at_commit?: string;
}

export interface WorkspaceMap {
  text: string;
  nodes: number;
  communities: number;
}

const MAX_FILES_PER_GROUP = 8;
const MAX_GROUPS = 14;

/**
 * A code map of the working folder for the planner, from Graphify's knowledge graph:
 * the code's communities (modules that belong together) with their files, and its
 * most connected abstractions. Lets the planner hand parallel steps disjoint files.
 * Builds or refreshes the graph offline (`graphify update`, no LLM) when it is stale.
 */
export async function workspaceMap(cwd: string, config: Config, exec: Exec = runProcess): Promise<WorkspaceMap | undefined> {
  if (config.context.graphify === "off") return undefined;
  // Only for code checkouts; graphing a random folder (e.g. the home dir) would be slow and useless.
  if (!existsSync(join(cwd, ".git"))) return undefined;
  const file = join(cwd, "graphify-out", "graph.json");

  const head = await exec({ command: "git", args: ["rev-parse", "HEAD"], cwd, timeoutMs: 15_000 });
  const commit = head.code === 0 ? head.stdout.trim() : undefined;
  let graph = readGraph(file);
  const stale = !graph || !commit || !graph.built_at_commit || !commit.startsWith(graph.built_at_commit.slice(0, 7));
  if (stale) {
    const r = await exec({
      command: config.context.graphifyCommand,
      args: ["update", cwd],
      cwd,
      env: { GRAPHIFY_BACKEND: "none" },
      timeoutMs: config.context.graphifyTimeoutSeconds * 1000,
    });
    if (!r.spawnError) graph = readGraph(file) ?? graph;
  }
  return graph?.nodes.length ? describeGraph(graph) : undefined;
}

function readGraph(file: string): Graph | undefined {
  try {
    const g = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(g?.nodes) ? g : undefined;
  } catch {
    return undefined;
  }
}

export function describeGraph(g: Graph): WorkspaceMap {
  const degree = new Map<string, number>();
  for (const l of g.links ?? []) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }

  const groups = new Map<string, { files: Set<string>; size: number }>();
  for (const n of g.nodes) {
    if (!n.source_file) continue;
    const key = n.community_name || `community ${n.community ?? "?"}`;
    const grp = groups.get(key) ?? { files: new Set<string>(), size: 0 };
    grp.files.add(n.source_file.replace(/\\/g, "/"));
    grp.size++;
    groups.set(key, grp);
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1].size - a[1].size);
  const lines = ranked.slice(0, MAX_GROUPS).map(([name, grp]) => {
    const files = [...grp.files].sort();
    const shown = files.slice(0, MAX_FILES_PER_GROUP).join(", ");
    return `- ${name} (${grp.size} symbols): ${shown}${files.length > MAX_FILES_PER_GROUP ? `, +${files.length - MAX_FILES_PER_GROUP} more` : ""}`;
  });
  const core = g.nodes
    .filter((n) => n.label)
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .slice(0, 8)
    .map((n) => `${n.label} (${n.source_file ?? "?"})`);

  const text = `Graphify code graph: ${g.nodes.length} symbols in ${groups.size} communities.
Communities (code that changes together) and their files:
${lines.join("\n")}${ranked.length > MAX_GROUPS ? `\n- …${ranked.length - MAX_GROUPS} smaller communities` : ""}
Most connected abstractions (changes here ripple widely): ${core.join("; ")}`;
  return { text, nodes: g.nodes.length, communities: groups.size };
}
