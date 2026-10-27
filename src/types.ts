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
  /** Always read-only, whatever the run's access level (design and review steps). */
  readOnly?: boolean;
  /** Files this step owns (from the Graphify code map), so parallel branches don't collide. */
  files?: string[];
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
  /** Whether to run a final synthesis step that merges all outputs. */
  synthesize: boolean;
}

/** design: Elephant-Goldfish. One model drafts a design, fresh models review only the document, you approve before any coding. */
export type RunMode = "auto" | "direct" | "plan" | "design";

export interface RunOptions {
  mode?: RunMode;
  provider?: ProviderId;
  agent?: string;
  cwd?: string;
  permission?: Permission;
  /** Restrict to these devices (node names); default any. */
  nodes?: string[];
  /**
   * Coding steps work on their own git branches, on any device that accepts branch work,
   * and push them for you to review and merge. Needs edit access and a git folder with a remote.
   */
  branches?: boolean;
  /** Agents may stop and ask you a question instead of guessing. */
  ask?: boolean;
  /** Pause after every step so you can continue, edit its answer or have it redone. */
  checkpoints?: boolean;
  /** Conversation this run belongs to; earlier turns are given to the agents as context. */
  threadId?: string;
}

/** What you decide at a checkpoint. */
export type ReviewDecision = { action: "continue" } | { action: "edit"; output: string } | { action: "redo"; instructions: string };

/** A conversation: a series of runs that build on each other. */
export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

/** A coding step sent to a device to do on its own branch. */
export interface BranchJob {
  repoUrl: string;
  /** Commit to branch from. */
  base: string;
  branch: string;
  /** Branches of steps this one depends on, merged in before work starts. */
  mergeBranches?: string[];
  title: string;
  provider: ProviderId;
  prompt: string;
  system?: string;
  model?: string;
  deep?: boolean;
  files?: string[];
  /** "auto" detects from the project; "" runs no tests. */
  testCommand: string;
  timeoutMs?: number;
}

export interface TestRun {
  command: string;
  ok: boolean;
  output: string;
}

export interface BranchResult {
  ok: boolean;
  branch: string;
  base: string;
  commit?: string;
  changedFiles: string[];
  diffStat: string;
  diff: string;
  tests?: TestRun;
  pushed: boolean;
  agent?: ProviderResult;
  error?: string;
  durationMs: number;
}

/** What the run view shows for a step that worked on a branch. */
export interface StepBranch {
  name: string;
  base: string;
  commit?: string;
  node: string;
  changedFiles: string[];
  diffStat: string;
  diff: string;
  tests?: TestRun;
  pushed: boolean;
  merged?: boolean;
  mergeError?: string;
}

export type RunStatus = "queued" | "planning" | "running" | "awaiting_approval" | "waiting" | "done" | "failed" | "cancelled";

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
  | "step.question"
  | "step.answered"
  | "step.review"
  | "step.edited"
  | "design.review_ready"
  | "design.approved"
  | "design.revising"
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
  /** waiting: asked you a question; review: paused at a checkpoint for you. */
  status: "pending" | "running" | "waiting" | "review" | "done" | "failed" | "skipped";
  output?: string;
  error?: string;
  branch?: StepBranch;
  /** Open question from the agent, while status is waiting. */
  question?: string;
  /** Questions it asked and your answers. */
  answers?: { question: string; answer: string }[];
  /** You changed its answer. */
  edited?: boolean;
  attempts: StepAttempt[];
  startedAt?: number;
  finishedAt?: number;
}

export interface RunRecord {
  id: string;
  threadId?: string;
  task: string;
  options: RunOptions;
  status: RunStatus;
  classification?: Classification;
  plan?: Plan;
  steps: StepRecord[];
  result?: string;
  error?: string;
  design?: DesignState;
  createdAt: number;
  finishedAt?: number;
}

export interface DesignState {
  round: number;
  draftStepId: string;
  reviewStepIds: string[];
  /** Where the approved design was written, when the run may edit files. */
  savedTo?: string;
}

export type DesignDecision = { action: "approve"; notes?: string } | { action: "revise"; feedback: string };

export interface Classification {
  kind: TaskKind;
  /** Secondary kinds detected, a hint that the task should be split. */
  alsoKinds: TaskKind[];
  complexity: "simple" | "moderate" | "complex";
  needsWeb: boolean;
  needsWorkspace: boolean;
  scores: Partial<Record<TaskKind, number>>;
}
