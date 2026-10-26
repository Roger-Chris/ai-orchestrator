/**
 * Shared domain types for the orchestrator brain.
 */

/** Built-in provider ids. Each maps to one of your subscriptions. */
export type ProviderId = "claude" | "codex" | "gemini" | "perplexity";
export const PROVIDER_IDS: ProviderId[] = ["claude", "codex", "gemini", "perplexity"];

/**
 * The kinds of work the brain knows how to route. Each provider has a 0..10
 * score per kind (see brain/capabilities.ts) and each agent targets one kind.
 */
export const TASK_KINDS = [
  "system_design",
  "ui_ux",
  "coding",
  "debugging",
  "code_review",
  "reasoning",
  "math",
  "research",
  "writing",
  "long_context",
  "multimodal",
  "pcb_design",
  "cad_3d",
  "data_analysis",
  "quick",
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** How much a step may touch the machine it runs on. */
export type Permission = "read" | "edit" | "full";

export interface ProviderRequest {
  prompt: string;
  system?: string;
  model?: string;
  /** Use the provider's configured deepModel when no explicit model is given. */
  deep?: boolean;
  /** Working directory the agent operates in (agentic CLIs only). */
  cwd?: string;
  permission?: Permission;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called with incremental text as the provider produces it. */
  onDelta?: (text: string) => void;
  /** Called with tool/progress notices (e.g. "running: npm test"). */
  onProgress?: (note: string) => void;
}

export interface ProviderResult {
  ok: boolean;
  text: string;
  provider: ProviderId;
  model?: string;
  durationMs: number;
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  citations?: string[];
  error?: string;
  /** True when the failure looks like a subscription usage / rate limit. */
  rateLimited?: boolean;
  /** When the provider says the limit resets, if it told us (epoch ms). */
  retryAt?: number;
}

export interface ProviderStatus {
  id: ProviderId;
  installed: boolean;
  authenticated: boolean;
  command?: string;
  version?: string;
  detail?: string;
  coolingDownUntil?: number;
}

/** One unit of work in a plan. */
export interface PlanStep {
  id: string;
  title: string;
  kind: TaskKind;
  agent?: string;
  prompt: string;
  dependsOn: string[];
  /** Pin a provider; otherwise the router chooses. */
  provider?: ProviderId;
  /** Never run this step on the same provider as these steps (cross-model review). */
  differentFrom?: string[];
  /** Step edits files in the local workspace, so it stays on the hub device. */
  needsWorkspace?: boolean;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  /** Whether to run a final synthesis step that merges all outputs. */
  synthesize: boolean;
}

export type RunMode = "auto" | "direct" | "plan";

export interface RunOptions {
  mode?: RunMode;
  provider?: ProviderId;
  agent?: string;
  cwd?: string;
  permission?: Permission;
  /** Restrict to these devices (node names); default any. */
  nodes?: string[];
}

export type RunStatus = "queued" | "planning" | "running" | "done" | "failed" | "cancelled";

export type RunEventType =
  | "run.started"
  | "run.classified"
  | "plan.created"
  | "step.started"
  | "step.delta"
  | "step.progress"
  | "step.completed"
  | "step.failed"
  | "step.fallback"
  | "run.completed"
  | "run.failed";

export interface RunEvent {
  runId: string;
  seq: number;
  ts: number;
  type: RunEventType;
  stepId?: string;
  data?: unknown;
}

export interface StepAttempt {
  provider: ProviderId;
  node: string;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface StepRecord {
  id: string;
  title: string;
  kind: TaskKind;
  agent?: string;
  provider?: ProviderId;
  node?: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  output?: string;
  error?: string;
  attempts: StepAttempt[];
  startedAt?: number;
  finishedAt?: number;
}

export interface RunRecord {
  id: string;
  task: string;
  options: RunOptions;
  status: RunStatus;
  classification?: Classification;
  plan?: Plan;
  steps: StepRecord[];
  result?: string;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

export interface Classification {
  kind: TaskKind;
  /** Secondary kinds detected, a hint that the task should be split. */
  alsoKinds: TaskKind[];
  complexity: "simple" | "moderate" | "complex";
  needsWeb: boolean;
  needsWorkspace: boolean;
  scores: Partial<Record<TaskKind, number>>;
}
