import { z } from "zod";
import { type Agent, agentCatalog } from "../agents/loader.js";
import { type Classification, type Plan, type PlanStep, PROVIDER_IDS, type ProviderId, TASK_KINDS, type TaskKind } from "../types.js";
import { type CapabilityMatrix, describeCapabilities } from "./capabilities.js";

const StepSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  agent: z.string().optional(),
  kind: z.string().optional(),
  prompt: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  differentFrom: z.array(z.string()).optional(),
  provider: z.string().optional(),
  needsWorkspace: z.boolean().optional(),
  files: z.array(z.string()).optional(),
});
const PlanSchema = z.object({
  goal: z.string().default(""),
  synthesize: z.boolean().default(true),
  steps: z.array(StepSchema).min(1),
});

export function buildPlannerPrompt(
  task: string,
  c: Classification,
  agents: Map<string, Agent>,
  caps: CapabilityMatrix,
  maxSteps: number,
  available: ProviderId[],
  context?: string,
): string {
  return `You are the planning brain of a multi-model AI orchestrator. Break the TASK into a small
plan of steps, each done by one specialist agent. Another component picks which AI model
runs each step; you pick the agent and write its instructions.

AGENTS:
${agentCatalog(agents)}

MODEL STRENGTHS (for your awareness; currently available: ${available.join(", ") || "none detected"}):
${describeCapabilities(caps)}

RULES:
- Use the fewest steps that do the job well (max ${maxSteps}). A simple task is 1 step.
- Steps with no dependency between them run in parallel, possibly on different devices; only add dependsOn when a step truly needs another's output.
- Each prompt must be self-contained: restate the relevant goal and constraints. Outputs of dependsOn steps are appended to it automatically.
- Put research first when the work depends on current facts, part availability or docs.
- For important code, designs or PCB/CAD output, add a review step by the "reviewer" agent with differentFrom set to the author step id, so a different model checks it.
- needsWorkspace=true only for steps that must edit files on disk.
- synthesize=true when several outputs must be merged into one final answer.
- If a WORKSPACE MAP is given, split coding work along its communities so steps that run in parallel own different files: list each coding step's files in "files" (paths from the map, or new files it creates). Coding steps may run on different devices on separate git branches that are merged afterwards, so overlapping files cause merge conflicts. Make a step that changes a "most connected" abstraction run first and the steps that use it depend on it.
- If RELEVANT PAST RUNS are given, reuse their decisions and avoid their mistakes; mention what matters in the step prompts.
${context ? `\n${context}\n` : ""}
Classifier hint: main kind "${c.kind}", also ${c.alsoKinds.join(", ") || "none"}, complexity ${c.complexity}.

Reply with ONLY a JSON object, no prose:
{"goal":"...","synthesize":true,"steps":[{"id":"s1","title":"...","agent":"<agent name>","prompt":"...","dependsOn":[],"differentFrom":[],"needsWorkspace":false,"files":[]}]}

TASK:
${task}`;
}

/** Pulls the first JSON object out of a model reply (handles ```json fences and chatter). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  if (start < 0) throw new Error("no JSON object in planner reply");
  let depth = 0;
  let inStr = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(body.slice(start, i + 1));
  }
  throw new Error("unterminated JSON in planner reply");
}

/**
 * Validates and repairs a plan: resolves agents/kinds, drops unknown or
 * forward dependencies (guaranteeing a DAG), dedupes ids, caps step count.
 */
export function normalizePlan(raw: unknown, task: string, c: Classification, agents: Map<string, Agent>, maxSteps: number): Plan {
  const parsed = PlanSchema.parse(raw);
  const steps: PlanStep[] = [];
  const seen = new Set<string>();
  const idMap = new Map<string, string>();
  for (const s of parsed.steps.slice(0, maxSteps)) {
    let id = s.id.replace(/[^\w-]/g, "_");
    while (seen.has(id)) id += "_";
    const agent = s.agent && agents.has(s.agent) ? agents.get(s.agent) : undefined;
    const kind = (TASK_KINDS as readonly string[]).includes(s.kind ?? "") ? (s.kind as TaskKind) : (agent?.kind ?? c.kind);
    const fallbackAgent = agent ?? [...agents.values()].find((a) => a.kind === kind);
    const earlier = (refs?: string[]) => refs?.map((d) => idMap.get(d)).filter((d): d is string => !!d);
    steps.push({
      id,
      title: s.title,
      kind,
      agent: fallbackAgent?.name,
      prompt: s.prompt,
      // Only earlier steps may be dependencies, so the graph can never cycle.
      dependsOn: earlier(s.dependsOn) ?? [],
      differentFrom: earlier(s.differentFrom),
      provider: (PROVIDER_IDS as string[]).includes(s.provider ?? "") ? (s.provider as ProviderId) : undefined,
      needsWorkspace: s.needsWorkspace,
      files: s.files?.length ? s.files.slice(0, 60) : undefined,
    });
    seen.add(id);
    idMap.set(s.id, id);
  }
  return { goal: parsed.goal || task.slice(0, 200), synthesize: parsed.synthesize && steps.length > 1, steps };
}

export function singleStepPlan(task: string, c: Classification, agents: Map<string, Agent>, agentName?: string): Plan {
  const agent = (agentName && agents.get(agentName)) || [...agents.values()].find((a) => a.kind === c.kind);
  return {
    goal: task.slice(0, 200),
    synthesize: false,
    steps: [
      {
        id: "s1",
        title: agent ? `${agent.name}: ${task.slice(0, 60)}` : task.slice(0, 60),
        kind: agent?.kind ?? c.kind,
        agent: agent?.name,
        prompt: task,
        dependsOn: [],
        needsWorkspace: c.needsWorkspace,
      },
    ],
  };
}

export function synthesisPrompt(task: string, outputs: { title: string; agent?: string; provider?: string; output: string }[]): string {
  const parts = outputs.map((o, i) => `### Step ${i + 1}: ${o.title} (${o.agent ?? "agent"} via ${o.provider ?? "?"})\n${o.output}`).join("\n\n");
  return `Several specialist AI agents worked on parts of the task below. Merge their work into one
complete, coherent final answer for the user. Resolve conflicts (prefer reviewed/corrected
versions and say when reviewers flagged issues that remain), remove duplication, keep all
concrete deliverables (code, designs, BOMs, files, citations) intact.

TASK:
${task}

STEP OUTPUTS:
${parts}`;
}
