/**
 * Shared domain types for the orchestrator brain.
 */

/** Built-in provider ids. Each maps to one of your subscriptions. */
/** `local` is a model on this machine through Ollama (free, private; slow without a GPU). */
export type ProviderId = "claude" | "codex" | "gemini" | "perplexity" | "groq" | "local";
export const PROVIDER_IDS: ProviderId[] = ["claude", "codex", "gemini", "perplexity", "groq", "local"];

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

/** Something you have to do on a given day, picked out of your mail or messages (or added by hand). */
export interface DayTask {
  id: string;
  /** Local date, YYYY-MM-DD. */
  day: string;
  /** "10:00", "by 5 pm"; absent when it is just "today". */
  time?: string;
  title: string;
  source: "gmail" | "whatsapp" | "manual";
  /** Where it came from, e.g. "Arun" or "clinic confirmation". */
  detail?: string;
  done: boolean;
}

// ---- the home screen (GET /api/home, GET /api/insights)

/** Something the brain is waiting on you for. */
export interface Decision {
  kind: "question" | "checkpoint" | "design";
  runId: string;
  threadId?: string;
  stepId?: string;
  /** Who is asking: the agent or step title. */
  from: string;
  /** The question, or what is waiting for review. */
  text: string;
  since: number;
}

export interface Running {
  runId: string;
  threadId?: string;
  task: string;
  stepsDone: number;
  stepsTotal: number;
  /** What it is doing right now, e.g. "Claude · Write the OpenSCAD model". */
  now?: string;
}

/** Something wrong you might want to act on. */
export interface Attention {
  level: "error" | "warn";
  title: string;
  detail: string;
  /** Present for a failed run, so the app can open or retry it. */
  runId?: string;
  threadId?: string;
  task?: string;
}

/**
 * Something the AI_Assistant brain wants you to see, pushed through POST /api/notify. It is quiet
 * by default and decides the level (AI_Assistant brain/app/alerts.py); you answer with an AlertAction.
 */
export interface BrainAlert {
  id: number;
  /** 1 morning brief, 2 notification, 3 alarm, 4 call. */
  level: number;
  /** new_task | question | overdue | brief */
  kind: string;
  title: string;
  body: string;
  task_id?: number | null;
  created_at?: string;
}

/** done finishes the task behind it; snooze brings it back in an hour; dismiss = not important. */
export type AlertAction = "done" | "snooze" | "dismiss";

export interface Home {
  node: string;
  devices: number;
  day: string;
  tasks: DayTask[];
  /** Which task sources are connected (none yet: tasks are added through /api/tasks). */
  sources: { gmail: boolean; whatsapp: boolean };
  /** What the brain says needs you, most urgent first. */
  alerts: BrainAlert[];
  decisions: Decision[];
  running: Running[];
  attention: Attention[];
  recent: { runId: string; threadId?: string; task: string; status: string; at: number }[];
  /** WhatsApp replies drafted in your style, waiting for you to send or dismiss. */
  replies: ReplyDraft[];
  /** Direct chats that went quiet after your message (WhatsApp); absent from an older hub. */
  quiet?: QuietChat[];
  /** Device actions the assistant wants to take, waiting for Approve or Deny; absent from an older hub. */
  approvals?: PendingApproval[];
}

/** One action waiting for the owner (src/actions). */
export interface PendingApproval {
  id: string;
  node: string;
  action: string;
  summary: string;
  reason?: string;
  since: number;
  expiresAt: number;
}

/** A direct chat where you had the last word and nothing came back. */
export interface QuietChat {
  chatId: string;
  name: string;
  /** Your last message, a few words of it. */
  last: string;
  /** When you sent it (ms). */
  since: number;
}

/** A WhatsApp reply written in your style. The hub never sends it; you do. */
export interface ReplyDraft {
  id: string;
  chatId: string;
  name: string;
  isGroup: boolean;
  /** Phone number for a wa.me link; absent for chats WhatsApp only gives a hidden id for. */
  phone?: string;
  /** What they said that this answers. */
  incoming: string;
  /** The first option's text. */
  text: string;
  /** Ways to answer: agree, say no, something in between; each written the way you type. */
  options: ReplyOption[];
  provider: ProviderId;
  createdAt: number;
}

export interface ReplyOption {
  /** One or two words: Yes, No, Later, Ask why… */
  label: string;
  text: string;
}

export interface Insights {
  days: { day: string; runs: number; done: number; failed: number }[];
  runs: number;
  done: number;
  failed: number;
  /** Median time from start to finish of runs that completed, ms. */
  medianMs?: number;
  providers: { provider: string; calls: number; failed: number; avgMs: number }[];
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

// ---- AI tools (Jarvis phase 1: src/ai/tools.ts, src/ai/route.ts; the app's AI hub screen)

/** local: runs on your own machine; free: a free tier; subscription: a plan you already pay for; paid: billed per use. */
export type CostClass = "local" | "free" | "subscription" | "paid";
export const COST_ORDER: CostClass[] = ["local", "free", "subscription", "paid"];

/** What a tool does: agent (can work on files), chat (text in, text out), speech, transcribe, vision. */
export type ToolKind = "agent" | "chat" | "speech" | "transcribe" | "vision";

/** ready: can take work; busy: all its slots are taken; cooling: resting after a limit until `until`; limit: today's cap reached; off: disabled; not_set_up: no login or key. */
export type ToolState = "ready" | "busy" | "cooling" | "limit" | "off" | "not_set_up";

export interface ToolInfo {
  id: string;
  name: string;
  kind: ToolKind;
  cost: CostClass;
  /** Kinds of work it is best at (score >= 8.5), best first. Empty for non-chat tools. */
  strengths: TaskKind[];
  /** Its score per kind of work (chat and agent tools). */
  scores?: Partial<Record<TaskKind, number>>;
  /** Can run tools and edit files. */
  agentic: boolean;
  limits: { maxConcurrent?: number; perDay?: number; spendPerDay?: number; note?: string };
  state: ToolState;
  /** When cooling or at its daily cap: when it can be used again. */
  until?: number;
  /** Slots in use / slots, 0..1+. */
  load: number;
  usageToday: Usage;
  /** Why it isn't ready, or what model/version it is. */
  detail?: string;
}

/** Calls today, failures, average time, and dollars spent (reported by the service, or estimated with costPerCall). */
export interface Usage {
  calls: number;
  failed: number;
  avgMs: number;
  spentUsd: number;
}

/** The hub's own jobs the model router chooses for. */
export const JOB_KINDS = ["whatsapp_draft", "mail", "call", "brain"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export type JobSize = "small" | "medium" | "large";

export interface Route {
  kind: JobKind | TaskKind;
  size: JobSize;
  /** Try these in order. Empty when nothing can take the job right now. */
  chain: ProviderId[];
  /** Tools left out and why (off, not set up, cooling, daily cap). */
  skipped: { id: ProviderId; why: string }[];
  /** One line on how the chain was chosen. */
  reason: string;
}

/** GET /api/ai-hub: everything the app's AI hub screen shows. */
export interface AiHub {
  tools: ToolInfo[];
  /** Each job with the chain it would use now and the owner's pick (from the app), if any. */
  jobs: { kind: JobKind; label: string; route: Route; preferred?: ProviderId }[];
  today: { calls: number; failed: number; spentUsd: number };
  /** Tools with a daily call or spend cap, and how close they are. */
  caps: { id: string; name: string; perDay?: number; spendPerDay?: number; calls: number; spentUsd: number; reached?: string }[];
  /** Calls and spend per day for the last 7 days (all tools). */
  week: { day: string; calls: number; failed: number; spentUsd: number }[];
}

// ---- Builds (Jarvis phase 2: src/builds; the app's Builds screen)

export interface BuildBranch {
  step: string;
  title: string;
  name: string;
  node: string;
  commit?: string;
  /** passed / failed / none (no tests found or run) */
  tests: string;
  files: number;
  merged?: boolean;
}

export interface Build {
  id: string;
  /** The app's name; builds of the same app share it ("continue the X app"). */
  name: string;
  spec: string;
  /** The git folder on the hub's machine. */
  repo: string;
  node?: string;
  agent: ProviderId;
  reviewer: ProviderId;
  status: "running" | "ready" | "failed" | "merged" | "cancelled";
  runId: string;
  branches: BuildBranch[];
  summary?: string;
  error?: string;
  mergeError?: string;
  continuedFrom?: string;
  /** Unguessable key in the preview links (/p/<key>/...), so the phone's browser can open them without the token. */
  previewKey: string;
  preview?: { status: "building" | "ready" | "failed"; web?: string; apk?: string; webRoot?: string; apkFile?: string; error?: string; log?: string; at: number };
  createdAt: number;
  updatedAt: number;
}
