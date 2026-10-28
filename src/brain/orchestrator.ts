import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Agent } from "../agents/loader.js";
import type { Cluster } from "../cluster/cluster.js";
import type { Config } from "../config.js";
import type { WorkspaceMap } from "../context/graphify.js";
import type { Memory } from "../memory/memory.js";
import type { Store } from "../store/db.js";
import { git } from "../cluster/branchwork.js";
import type {
  BranchJob,
  Classification,
  TestRun,
  DesignDecision,
  Permission,
  ReviewDecision,
  Plan,
  PlanStep,
  ProviderId,
  ProviderResult,
  RunEvent,
  RunEventType,
  RunOptions,
  RunRecord,
  StepRecord,
} from "../types.js";
import { DEEP_KINDS } from "./capabilities.js";
import { classify, classifyPrompt, refineClassification } from "./classifier.js";
import { type PriorRound, designSlug, elephantPrompt, goldfishPrompt, implementationTask, pickGoldfish } from "./design.js";
import { buildPlannerPrompt, extractJson, normalizePlan, singleStepPlan, synthesisPrompt } from "./planner.js";
import type { Router } from "./router.js";

/** How many different (device, provider) pairs a step tries before giving up. */
const MAX_ATTEMPTS = 3;
/** Cap on each upstream output pasted into a dependent step's prompt. */
const MAX_DEP_CHARS = 16_000;
/** Questions answered plus redos per step, before it just finishes. */
const MAX_ROUNDS = 8;
const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_CHARS = 3000;

const ASK_INSTRUCTIONS = `If you cannot do this well without a decision only the user can make (a missing requirement,
or a choice between options with real trade-offs), reply with ONLY <ask>your question</ask> and nothing
else; you will get the answer and continue. Decide everything you reasonably can yourself.`;

/** The agent's question, when its answer ends with <ask>…</ask>. */
export function parseQuestion(text: string): string | undefined {
  const m = text.match(/<ask>([\s\S]+?)<\/ask>\s*$/i);
  return m?.[1].trim() || undefined;
}

interface Live {
  run: RunRecord;
  seq: number;
  abort: AbortController;
  done: Promise<RunRecord>;
  /** Memory + workspace map for planning, gathered once per run. */
  context?: Promise<string | undefined>;
  /** Set when the run works on git branches: where devices clone from and branch off. */
  branchCtx?: { repoUrl: string; base: string; cwd: string };
  /** The task as the agents see it: your message plus the conversation so far. */
  task: string;
  stepAborts: Map<string, AbortController>;
  /** Steps currently waiting for you. */
  parked: number;
}

export interface OrchestratorExtras {
  memory?: Memory;
  /** Code map of a working folder (Graphify), for planning. */
  workspace?: (cwd: string) => Promise<WorkspaceMap | undefined>;
  /** Something needs you (a question, a checkpoint, a design) or a run ended: e.g. send a phone notification. */
  onAttention?: (run: RunRecord, step: StepRecord | undefined, type: RunEventType) => void | Promise<void>;
  /** A live briefing on the owner's setup (devices, models, today's tasks), given to every agent. */
  setup?: () => Promise<string | undefined>;
}

export class Orchestrator {
  private live = new Map<string, Live>();
  private bus = new EventEmitter();
  /** Runs and steps paused for you: design approval (key: run id), questions and checkpoints (run:step). */
  private waiters = new Map<string, (v: unknown) => void>();

  constructor(
    private config: Config,
    private store: Store,
    private cluster: Cluster,
    private router: Router,
    public agents: Map<string, Agent>,
    private extras: OrchestratorExtras = {},
  ) {
    this.bus.setMaxListeners(200);
  }

  /** Starts a run in the background and returns its record immediately. */
  submit(task: string, options: RunOptions = {}): RunRecord {
    const run: RunRecord = {
      id: randomUUID().slice(0, 8),
      threadId: options.threadId,
      task,
      options,
      status: "queued",
      steps: [],
      createdAt: Date.now(),
    };
    const abort = new AbortController();
    const history = options.threadId ? this.threadHistory(options.threadId, run.id) : undefined;
    const agentTask = history ? `${history}\n\nNEW MESSAGE FROM THE USER:\n${task}` : task;
    const entry: Live = { run, seq: 0, abort, done: Promise.resolve(run), task: agentTask, stepAborts: new Map(), parked: 0 };
    if (options.threadId) this.store.touchThread(options.threadId);
    this.live.set(run.id, entry);
    this.store.saveRun(run);
    entry.done = this.execute(entry).finally(() => {
      // Keep finished runs briefly so late SSE subscribers still get them from memory.
      setTimeout(() => this.live.delete(run.id), 60_000).unref();
    });
    return run;
  }

  async runToCompletion(task: string, options: RunOptions = {}): Promise<RunRecord> {
    const run = this.submit(task, options);
    return this.live.get(run.id)!.done;
  }

  get(id: string): RunRecord | undefined {
    return this.live.get(id)?.run ?? this.store.getRun(id);
  }

  wait(id: string): Promise<RunRecord> | undefined {
    return this.live.get(id)?.done;
  }

  cancel(id: string): boolean {
    const l = this.live.get(id);
    if (!l || ["done", "failed", "cancelled"].includes(l.run.status)) return false;
    l.abort.abort();
    return true;
  }

  /** The conversation so far, for a follow-up message: earlier requests and their results. */
  private threadHistory(threadId: string, exclude: string): string | undefined {
    const turns = this.store
      .threadRuns(threadId)
      .filter((r) => r.id !== exclude && (r.result || r.error))
      .slice(-MAX_HISTORY_TURNS);
    if (!turns.length) return undefined;
    const lines = turns.map(
      (r) => `User: ${truncate(r.task, 2000)}\nResult${r.status === "done" ? "" : ` (${r.status})`}: ${truncate(r.result ?? r.error ?? "", MAX_HISTORY_CHARS)}`,
    );
    return `CONVERSATION SO FAR (earlier messages and what the agents produced):\n\n${lines.join("\n\n")}`;
  }

  /** Runs still in progress or waiting for you, newest first. */
  active(): Pick<RunRecord, "id" | "threadId" | "task" | "status" | "createdAt">[] {
    return [...this.live.values()]
      .map((l) => l.run)
      .filter((r) => !["done", "failed", "cancelled"].includes(r.status))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ id, threadId, task, status, createdAt }) => ({ id, threadId, task, status, createdAt }));
  }

  /** Every event of every run (for notifications). */
  subscribeAll(fn: (ev: RunEvent) => void): () => void {
    this.bus.on("event", fn);
    return () => this.bus.off("event", fn);
  }

  /** Subscribe to a run's events. Returns an unsubscribe function. */
  subscribe(id: string, fn: (ev: RunEvent) => void): () => void {
    const handler = (ev: RunEvent) => ev.runId === id && fn(ev);
    this.bus.on("event", handler);
    return () => this.bus.off("event", handler);
  }

  private emit(l: Live, type: RunEventType, data?: unknown, stepId?: string) {
    const ev: RunEvent = { runId: l.run.id, seq: ++l.seq, ts: Date.now(), type, stepId, data };
    this.store.appendEvent(ev);
    this.bus.emit("event", ev);
  }

  private save(l: Live) {
    this.store.saveRun(l.run);
  }

  private async execute(l: Live): Promise<RunRecord> {
    const { run } = l;
    const opts = run.options;
    try {
      this.emit(l, "run.started", { task: run.task, options: opts });
      const c = await this.classify(run.task, opts);
      run.classification = c;
      this.emit(l, "run.classified", c);
      if (opts.branches) await this.prepareBranches(l);

      const mode = opts.mode ?? "auto";
      let task = l.task;
      if (mode === "design") {
        const { doc, notes } = await this.designPhase(l);
        task = implementationTask(l.task, truncate(doc, MAX_DEP_CHARS * 4), notes);
      }

      run.status = "planning";
      this.save(l);
      let plan =
        mode === "direct" || opts.agent || (mode === "auto" && c.complexity === "simple")
          ? singleStepPlan(task, c, this.agents, opts.agent, run.task)
          : await this.plan(l, task);
      if (mode === "design") plan = prefixIds(plan, "impl-");
      if (opts.provider) for (const s of plan.steps) s.provider = opts.provider;
      this.addSteps(l, plan);

      run.status = "running";
      this.save(l);
      await this.runGraph(l);
      if (l.abort.signal.aborted) throw new Error("cancelled");

      const ids = new Set(plan.steps.map((s) => s.id));
      const done = run.steps.filter((s) => ids.has(s.id) && s.status === "done");
      if (!done.length) throw new Error(run.steps.find((s) => ids.has(s.id) && s.error)?.error ?? "no step succeeded");

      if (plan.synthesize && done.length > 1) {
        run.result = await this.synthesize(l, done);
      } else {
        // The final answer is the output of the leaf steps (those nothing depends on).
        const depended = new Set(plan.steps.flatMap((s) => s.dependsOn));
        const leaves = done.filter((s) => !depended.has(s.id));
        const final = leaves.length ? leaves : done;
        run.result = final.map((s) => (final.length > 1 ? `## ${s.title}\n\n${s.output}` : s.output)).join("\n\n");
      }
      if (run.design?.savedTo) run.result += `\n\n---\nApproved design: \`${run.design.savedTo}\``;
      const branches = run.steps.filter((s) => s.branch?.pushed);
      if (branches.length) {
        run.result += `\n\n---\n## Branches to review and merge\n${branches
          .map((s) => `- \`${s.branch!.name}\` — ${s.title} (${s.provider} @ ${s.branch!.node}): ${s.branch!.changedFiles.length} file(s), tests ${testLabel(s.branch!.tests)}`)
          .join("\n")}`;
      }
      run.status = "done";
      run.finishedAt = Date.now();
      this.save(l);
      this.emit(l, "run.completed", { result: run.result });
      void this.extras.onAttention?.(run, undefined, "run.completed");
      // Local memory is written before the first await; the NotebookLM upload finishes in the background.
      this.extras.memory?.remember(run, (msg) => console.warn(msg)).catch((e) => console.warn(`memory: ${(e as Error).message}`));
    } catch (e) {
      run.status = l.abort.signal.aborted ? "cancelled" : "failed";
      run.error = (e as Error).message;
      run.finishedAt = Date.now();
      this.save(l);
      this.emit(l, "run.failed", { error: run.error });
      if (run.status === "failed") void this.extras.onAttention?.(run, undefined, "run.failed");
    }
    return run;
  }

  /**
   * Branch work starts from a commit every device can fetch: HEAD of your folder. If HEAD
   * is not on the remote yet, it is pushed as orc/<run>/base (your own branches are untouched).
   */
  private async prepareBranches(l: Live) {
    const opts = l.run.options;
    const cwd = resolve(opts.cwd ?? process.cwd());
    const remote = this.config.branches.remote;
    if ((opts.permission ?? this.config.brain.defaultPermission) === "read") throw new Error("Branch work changes code: choose Edit files or Full access.");
    const url = await git(["remote", "get-url", remote], cwd);
    if (!url.ok || !url.out) throw new Error(`Branch work needs a git folder with a "${remote}" remote the other devices can reach; ${cwd} has none.`);
    const head = await git(["rev-parse", "HEAD"], cwd);
    if (!head.ok) throw new Error(`${cwd} has no commits yet; commit first so the devices have something to branch from.`);
    const note = (n: string) => this.emit(l, "step.progress", { note: n }, "branches");
    if ((await git(["status", "--porcelain", "--untracked-files=no"], cwd)).out) note("uncommitted changes in your folder are not included; devices work from the last commit");
    await git(["fetch", remote], cwd);
    const onRemote = (await git(["branch", "-r", "--contains", head.out], cwd)).out.split("\n").some((b) => b.trim().startsWith(`${remote}/`));
    if (!onRemote) {
      const ref = `orc/${l.run.id}/base`;
      const push = await git(["push", remote, `HEAD:refs/heads/${ref}`], cwd);
      if (!push.ok) throw new Error(`could not push the base commit for the devices (${ref}): ${push.err.slice(-400)}`);
      note(`your latest commit is not on ${remote} yet; pushed it as ${ref} for the devices`);
    }
    l.branchCtx = { repoUrl: url.out, base: head.out, cwd };
    note(`devices branch from ${head.out.slice(0, 8)} of ${url.out}`);
  }

  /** One attempt at a coding step on its own branch, on the chosen device. */
  private async branchAttempt(l: Live, spec: PlanStep, rec: StepRecord, byId: Map<string, StepRecord>, cand: { node: string; provider: ProviderId }, prompt: string, agent: Agent | undefined, signal: AbortSignal): Promise<ProviderResult> {
    const ctx = l.branchCtx!;
    const deps = spec.dependsOn.map((d) => byId.get(d)?.branch).filter((b): b is NonNullable<StepRecord["branch"]> => !!b?.pushed);
    const job: BranchJob = {
      repoUrl: ctx.repoUrl,
      base: ctx.base,
      branch: `orc/${l.run.id}-${spec.id}`,
      mergeBranches: deps.map((b) => b.name),
      title: spec.title,
      provider: cand.provider,
      prompt,
      system: agent?.system,
      deep: agent?.deep || DEEP_KINDS.includes(spec.kind),
      files: spec.files,
      testCommand: this.config.branches.testCommand,
      timeoutMs: this.config.brain.stepTimeoutMinutes * 60_000,
    };
    const br = await this.cluster.runBranch(cand.node, job, {
      signal,
      onDelta: (text) => this.emit(l, "step.delta", { text }, spec.id),
      onProgress: (note) => this.emit(l, "step.progress", { note }, spec.id),
    });
    const agentRes = br.agent;
    if (!br.ok) {
      return { ok: false, text: "", provider: cand.provider, durationMs: br.durationMs, error: br.error, rateLimited: agentRes?.rateLimited, retryAt: agentRes?.retryAt };
    }
    rec.branch = { name: br.branch, base: br.base, commit: br.commit, node: cand.node, changedFiles: br.changedFiles, diffStat: br.diffStat, diff: br.diff, tests: br.tests, pushed: br.pushed };
    const summary = br.pushed
      ? `Branch \`${br.branch}\` on ${cand.node}: ${br.changedFiles.length} file(s) changed, tests ${testLabel(br.tests)}.\n\n\`\`\`\n${br.diffStat}\n\`\`\`\n\n\`\`\`diff\n${br.diff}\n\`\`\``
      : "No files changed, so no branch was pushed.";
    return { ...(agentRes ?? { provider: cand.provider, durationMs: br.durationMs }), ok: true, text: `${agentRes?.text ?? ""}\n\n${summary}`.trim() };
  }

  /** Merges a step's branch into the branch checked out in your folder. Conflicts are aborted, never left behind. */
  async mergeBranch(runId: string, stepId: string): Promise<{ ok: boolean; error?: string }> {
    const run = this.get(runId);
    const rec = run?.steps.find((s) => s.id === stepId);
    if (!run || !rec?.branch?.pushed) return { ok: false, error: "that step has no branch" };
    if (!["done", "failed", "cancelled"].includes(run.status)) return { ok: false, error: "wait for the run to finish before merging" };
    if (rec.branch.merged) return { ok: true };
    const cwd = resolve(run.options.cwd ?? process.cwd());
    const remote = this.config.branches.remote;
    const name = rec.branch.name;
    const fetch = await git(["fetch", remote, `+refs/heads/${name}:refs/remotes/${remote}/${name}`], cwd);
    let error = fetch.ok ? undefined : `fetch failed: ${fetch.err.slice(-400)}`;
    if (!error) {
      const m = await git(["merge", "--no-ff", "--no-edit", "-m", `Merge ${name}: ${rec.title}`, `${remote}/${name}`], cwd);
      if (!m.ok) {
        await git(["merge", "--abort"], cwd);
        error = `merge stopped (nothing changed): ${(m.out || m.err).slice(-600)}`;
      }
    }
    rec.branch.merged = !error;
    rec.branch.mergeError = error;
    this.store.saveRun(run);
    return error ? { ok: false, error } : { ok: true };
  }

  /** Related past runs and a code map of the working folder, for the planner and the design author. */
  private context(l: Live): Promise<string | undefined> {
    l.context ??= (async () => {
      const cwd = resolve(l.run.options.cwd ?? process.cwd());
      const [memory, map] = await Promise.all([
        this.extras.memory?.recall(l.run.task, l.run.id).catch(() => undefined),
        this.extras.workspace?.(cwd).catch(() => undefined),
      ]);
      const parts: string[] = [];
      const notes: string[] = [];
      if (memory) {
        parts.push(`RELEVANT PAST RUNS (your memory):\n${memory}`);
        notes.push("recalled related past runs");
      }
      if (map) {
        parts.push(`WORKSPACE MAP of ${cwd}:\n${map.text}`);
        notes.push(`workspace map: ${map.nodes} symbols in ${map.communities} communities`);
      }
      this.emit(l, "step.progress", { note: notes.join(" · ") || "no related memory or code map" }, "context");
      return parts.length ? parts.join("\n\n") : undefined;
    })();
    return l.context;
  }

  /** Appends steps to the run (design rounds and the build each add some) and announces the whole plan. */
  private addSteps(l: Live, plan: Plan) {
    const prev = l.run.plan?.steps ?? [];
    l.run.plan = { goal: plan.goal, synthesize: plan.synthesize, steps: [...prev, ...plan.steps] };
    l.run.steps.push(...plan.steps.map((s): StepRecord => ({ id: s.id, title: s.title, kind: s.kind, agent: s.agent, status: "pending", attempts: [] })));
    this.emit(l, "plan.created", l.run.plan);
  }

  /**
   * Elephant-Goldfish: the author drafts (Claude when available), fresh reviewers on other
   * models get only the document, then the run waits for you. Revisions loop; approval returns.
   */
  private async designPhase(l: Live): Promise<{ doc: string; notes?: string }> {
    const { run } = l;
    let prior: PriorRound | undefined;
    for (let round = 1; ; round++) {
      run.status = "running";
      this.save(l);
      const available = new Set((await this.cluster.candidates()).map((c) => c.provider));
      const draftId = `design-${round}`;
      this.addSteps(l, {
        goal: run.task.slice(0, 200),
        synthesize: false,
        steps: [
          {
            id: draftId,
            title: round === 1 ? "Elephant: draft the design" : `Elephant: revise the design (round ${round})`,
            kind: "system_design",
            agent: this.agents.has("architect") ? "architect" : undefined,
            prompt: elephantPrompt(l.task, prior, await this.context(l)),
            dependsOn: [],
            provider: available.has("claude") ? "claude" : undefined,
            // Runs here so it can read the codebase it is designing for.
            needsWorkspace: true,
            readOnly: true,
          },
        ],
      });
      await this.runGraph(l);
      if (l.abort.signal.aborted) throw new Error("cancelled");
      const draft = run.steps.find((s) => s.id === draftId)!;
      if (draft.status !== "done" || !draft.output) throw new Error(`design draft failed: ${draft.error ?? "no output"}`);

      const reviewers = pickGoldfish(available, draft.provider);
      const reviewIds = reviewers.map((p) => `review-${round}-${p}`);
      this.addSteps(l, {
        goal: run.task.slice(0, 200),
        synthesize: false,
        steps: reviewers.map((p, i) => ({
          id: reviewIds[i],
          title: `Goldfish review (${p})`,
          kind: "code_review",
          agent: this.agents.has("reviewer") ? "reviewer" : undefined,
          prompt: goldfishPrompt(),
          dependsOn: [draftId],
          provider: p,
          readOnly: true,
        })),
      });
      await this.runGraph(l);
      if (l.abort.signal.aborted) throw new Error("cancelled");
      const reviews = reviewIds.map((id) => run.steps.find((s) => s.id === id)!);

      run.design = { round, draftStepId: draftId, reviewStepIds: reviewIds };
      run.status = "awaiting_approval";
      this.save(l);
      // Listen before announcing, so a decision made straight from the event isn't lost.
      const pending = this.waitForDecision(l);
      void this.extras.onAttention?.(run, undefined, "design.review_ready");
      this.emit(l, "design.review_ready", {
        round,
        draftStepId: draftId,
        reviews: reviews.map((r) => ({ stepId: r.id, provider: r.provider, ok: r.status === "done", verdict: verdictOf(r.output) })),
      });

      const decision = await pending;
      if (decision.action === "approve") {
        run.design.savedTo = this.saveDesign(l, draft.output);
        run.status = "running";
        this.save(l);
        this.emit(l, "design.approved", { notes: decision.notes, savedTo: run.design.savedTo });
        return { doc: draft.output, notes: decision.notes };
      }
      this.emit(l, "design.revising", { feedback: decision.feedback });
      prior = {
        draft: draft.output,
        reviews: reviews.filter((r) => r.output).map((r) => ({ provider: r.provider, output: r.output! })),
        feedback: decision.feedback,
      };
    }
  }

  private waitForDecision(l: Live): Promise<DesignDecision> {
    return new Promise((resolveDecision, reject) => {
      const onAbort = () => {
        this.waiters.delete(l.run.id);
        reject(new Error("cancelled"));
      };
      if (l.abort.signal.aborted) return onAbort();
      l.abort.signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.set(l.run.id, (d) => {
        l.abort.signal.removeEventListener("abort", onAbort);
        this.waiters.delete(l.run.id);
        resolveDecision(d as DesignDecision);
      });
    });
  }

  /** Approve or send back a design that is waiting for you. False when nothing is waiting. */
  decide(id: string, decision: DesignDecision): boolean {
    return this.live.get(id)?.run.status === "awaiting_approval" ? this.resolveWaiter(id, decision) : false;
  }

  /** Writes the approved design to docs/designs/ (EGM's convention) when the run may edit files. */
  private saveDesign(l: Live, doc: string): string | undefined {
    const permission = l.run.options.permission ?? this.config.brain.defaultPermission;
    if (permission === "read") return undefined;
    try {
      const dir = resolve(l.run.options.cwd ?? process.cwd(), "docs", "designs");
      mkdirSync(dir, { recursive: true });
      const slug = designSlug(l.run.task);
      let path = resolve(dir, `${slug}.md`);
      for (let n = 2; existsSync(path); n++) path = resolve(dir, `${slug}-${n}.md`);
      writeFileSync(path, doc.endsWith("\n") ? doc : `${doc}\n`);
      return path;
    } catch (e) {
      this.emit(l, "step.progress", { note: `could not save the design: ${(e as Error).message}` }, l.run.design?.draftStepId);
      return undefined;
    }
  }

  /**
   * Keyword classification, refined by Groq when it is set up (about a second). It decides
   * which model gets the work and whether a task needs a plan, so a better guess here
   * saves a slow planning call. Any problem keeps the keyword guess.
   */
  private async classify(task: string, opts: RunOptions): Promise<Classification> {
    const c = classify(task);
    if (this.config.brain.classifier !== "model" || opts.agent || opts.provider) return c;
    const target = (await this.cluster.candidates()).filter((x) => x.provider === "groq").sort((a, b) => Number(b.local) - Number(a.local) || a.load - b.load)[0];
    if (!target) return c;
    const res = await this.cluster.run(target.node, "groq", { prompt: classifyPrompt(task), permission: "read", timeoutMs: 8000 });
    this.store.recordUsage("groq", target.node, res.ok, res.durationMs);
    return res.ok ? refineClassification(c, res.text) : c;
  }

  /** The setup briefing, or nothing if it can't be built: a missing briefing must never stop a run. */
  private async briefing(): Promise<string | undefined> {
    try {
      return await this.extras.setup?.();
    } catch {
      return undefined;
    }
  }

  /** Asks the planner model for a step graph; falls back to one step on any problem. */
  private async plan(l: Live, task: string): Promise<Plan> {
    const { run } = l;
    const c = run.classification!;
    const candidates = await this.cluster.candidates();
    const available = [...new Set(candidates.map((x) => x.provider))];
    const prompt = buildPlannerPrompt(task, c, this.agents, this.router.caps, this.config.brain.maxPlanSteps, available, await this.context(l));
    const order: ProviderId[] = [this.config.brain.planner, "claude", "codex", "gemini"];
    for (const provider of [...new Set(order)]) {
      const target = candidates.filter((x) => x.provider === provider).sort((a, b) => Number(b.local) - Number(a.local) || a.load - b.load)[0];
      if (!target) continue;
      this.emit(l, "step.progress", { note: `planning with ${provider} @ ${target.node}` }, "plan");
      const res = await this.cluster.run(target.node, provider, {
        prompt,
        model: provider === this.config.brain.planner ? this.config.brain.plannerModel : undefined,
        permission: "read",
        timeoutMs: 5 * 60_000,
        signal: l.abort.signal,
      });
      this.store.recordUsage(provider, target.node, res.ok, res.durationMs);
      if (!res.ok) continue;
      try {
        return normalizePlan(extractJson(res.text), task, c, this.agents, this.config.brain.maxPlanSteps);
      } catch {
        /* malformed plan: try the next planner */
      }
    }
    return singleStepPlan(task, c, this.agents);
  }

  /** Runs pending steps as soon as their dependencies finish, up to maxParallelSteps at once. */
  private async runGraph(l: Live): Promise<void> {
    const byId = new Map(l.run.steps.map((s) => [s.id, s]));
    const specs = new Map(l.run.plan!.steps.map((s) => [s.id, s]));
    const running = new Map<string, Promise<void>>();

    while (!l.abort.signal.aborted) {
      for (const rec of l.run.steps) {
        if (rec.status !== "pending") continue;
        const deps = specs.get(rec.id)!.dependsOn.map((d) => byId.get(d)!);
        if (deps.some((d) => d.status === "failed" || d.status === "skipped")) {
          rec.status = "skipped";
          rec.error = "a step it depends on failed";
          this.emit(l, "step.failed", { error: rec.error, skipped: true }, rec.id);
        } else if (deps.every((d) => d.status === "done") && running.size < this.config.brain.maxParallelSteps) {
          rec.status = "running";
          running.set(
            rec.id,
            this.runStep(l, specs.get(rec.id)!, rec, byId).finally(() => running.delete(rec.id)),
          );
        }
      }
      if (!running.size) break;
      await Promise.race(running.values());
      this.save(l);
    }
    await Promise.allSettled(running.values());
  }

  private async runStep(l: Live, spec: PlanStep, rec: StepRecord, byId: Map<string, StepRecord>): Promise<void> {
    const agent = spec.agent ? this.agents.get(spec.agent) : undefined;
    const deps = spec.dependsOn.map((d) => byId.get(d)!).filter((d) => d.output);
    const prompt = deps.length
      ? `${spec.prompt}\n\n---\nOutputs from earlier steps you can build on:\n\n${deps
          .map((d) => `### ${d.title} (${d.agent ?? "agent"} via ${d.provider})\n${truncate(d.output!, MAX_DEP_CHARS)}`)
          .join("\n\n")}`
      : spec.prompt;

    const exclude = this.config.brain.crossReview
      ? (spec.differentFrom ?? []).map((d) => byId.get(d)?.provider).filter((p): p is ProviderId => !!p)
      : [];
    // The run's access level is the ceiling; an agent's own setting can only lower it.
    const allowed = spec.readOnly ? "read" : (l.run.options.permission ?? this.config.brain.defaultPermission);
    const permission = agent?.permission ? lowerPermission(allowed, agent.permission) : allowed;
    // Steps that change files run here, where the workspace is, unless the run works on
    // branches: then any device that accepts branch work can take them.
    const onBranch = !!l.branchCtx && permission !== "read";
    const needsWorkspace = !onBranch && (!!spec.needsWorkspace || permission !== "read");
    const ranked = this.router.rank(
      {
        kind: spec.kind,
        needsWorkspace,
        branchWork: onBranch,
        needsWeb: spec.kind === "research",
        prefer: agent?.prefer,
        exclude,
        pin: spec.provider,
        nodes: l.run.options.nodes,
      },
      await this.cluster.candidates(),
    );

    rec.startedAt = Date.now();
    this.emit(l, "step.started", { title: spec.title, agent: spec.agent, kind: spec.kind, ranking: ranked.slice(0, 4) }, spec.id);

    if (!ranked.length) {
      rec.status = "failed";
      rec.error = `no available model can run a ${spec.kind} step${needsWorkspace ? " that edits files on this device" : onBranch ? " on a branch (no device with node.acceptBranchWork and a coding model)" : ""}${exclude.length ? ` (excluding ${exclude.join(", ")})` : ""}`;
      rec.finishedAt = Date.now();
      this.emit(l, "step.failed", { error: rec.error }, spec.id);
      return;
    }

    // Each step can be stopped on its own, as well as with the whole run.
    const ctrl = new AbortController();
    const onRunAbort = () => ctrl.abort();
    l.abort.signal.addEventListener("abort", onRunAbort, { once: true });
    l.stepAborts.set(spec.id, ctrl);
    const opts = l.run.options;
    const askNote = opts.ask ? `\n\n${ASK_INSTRUCTIONS}` : "";
    // Your answers to its questions and your redo instructions, carried into the next round.
    let followUp = "";

    // Agents answer from the owner's actual setup, not generic advice; coding on branches doesn't need it.
    const brief = onBranch ? undefined : await this.briefing();
    const system = [brief, agent?.system].filter(Boolean).join("\n\n---\n\n") || undefined;

    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        let res: ProviderResult | undefined;
        let node = "";
        let tries = 0;
        for (const cand of ranked) {
          if (tries >= MAX_ATTEMPTS || ctrl.signal.aborted) break;
          if (tries++) this.emit(l, "step.fallback", { to: cand.provider, node: cand.node, why: cand.why }, spec.id);
          rec.provider = cand.provider;
          rec.node = node = cand.node;
          this.emit(l, "step.progress", { note: `running on ${cand.provider} @ ${cand.node} (${cand.why})` }, spec.id);
          const full = `${prompt}${followUp}${askNote}`;
          const r: ProviderResult = onBranch
            ? await this.branchAttempt(l, spec, rec, byId, cand, full, agent, ctrl.signal)
            : await this.cluster.run(cand.node, cand.provider, {
                prompt: full,
                system,
                deep: agent?.deep || DEEP_KINDS.includes(spec.kind),
                cwd: cand.local ? resolve(opts.cwd ?? process.cwd()) : undefined,
                permission: cand.local ? permission : "read",
                timeoutMs: this.config.brain.stepTimeoutMinutes * 60_000,
                signal: ctrl.signal,
                onDelta: (text) => this.emit(l, "step.delta", { text }, spec.id),
                onProgress: (note) => this.emit(l, "step.progress", { note }, spec.id),
              });
          this.store.recordUsage(cand.provider, cand.node, r.ok, r.durationMs);
          rec.attempts.push({ provider: cand.provider, node: cand.node, ok: r.ok, error: r.error, durationMs: r.durationMs });
          if (r.ok) {
            res = r;
            break;
          }
          this.emit(
            l,
            "step.progress",
            { note: `${cand.provider} @ ${cand.node} failed: ${r.error?.slice(0, 300)}${r.rateLimited ? " (usage limit, cooling down)" : ""}` },
            spec.id,
          );
        }
        if (!res) break;

        // The agent asked you something instead of guessing: wait for your answer, then carry on.
        const question = opts.ask ? parseQuestion(res.text) : undefined;
        if (question) {
          rec.question = question;
          const answer = await this.pause<string>(l, rec, "waiting", "step.question", { question }, ctrl.signal);
          (rec.answers ??= []).push({ question, answer });
          rec.question = undefined;
          this.emit(l, "step.answered", { question, answer }, spec.id);
          followUp += `\n\n---\nYou asked: ${question}\nThe user answered: ${answer}\nContinue the task with this answer.`;
          continue;
        }

        let output = res.text;
        if (opts.checkpoints) {
          rec.output = output;
          const d = await this.pause<ReviewDecision>(l, rec, "review", "step.review", { output, provider: res.provider, model: res.model, node }, ctrl.signal);
          if (d.action === "redo") {
            followUp += `\n\n---\nYour previous answer was:\n${truncate(output, MAX_DEP_CHARS)}\n\nThe user asked you to redo it: ${d.instructions}`;
            this.emit(l, "step.progress", { note: `redoing: ${d.instructions}` }, spec.id);
            continue;
          }
          if (d.action === "edit") {
            this.recordCorrection(l.run, rec, output, d.output);
            output = d.output;
            rec.edited = true;
            this.emit(l, "step.edited", { output }, spec.id);
          }
        }

        rec.status = "done";
        rec.output = output;
        rec.finishedAt = Date.now();
        this.emit(l, "step.completed", { provider: res.provider, model: res.model, node, durationMs: res.durationMs, usage: res.usage, output }, spec.id);
        return;
      }

      rec.status = "failed";
      rec.error = ctrl.signal.aborted && !l.abort.signal.aborted ? "stopped by you" : (rec.attempts.at(-1)?.error ?? "cancelled");
    } catch (e) {
      // Stopped while waiting for you.
      rec.status = "failed";
      rec.error = l.abort.signal.aborted ? "cancelled" : (e as Error).message;
    } finally {
      l.abort.signal.removeEventListener("abort", onRunAbort);
      l.stepAborts.delete(spec.id);
    }
    rec.question = undefined;
    rec.finishedAt = Date.now();
    this.emit(l, "step.failed", { error: rec.error }, spec.id);
  }

  /**
   * Parks a step until you respond (an answer, or a checkpoint decision). The run shows as
   * waiting while any step is parked; stopping the step or the run ends the wait.
   */
  private async pause<T>(l: Live, rec: StepRecord, status: "waiting" | "review", type: RunEventType, data: unknown, signal: AbortSignal): Promise<T> {
    const key = `${l.run.id}:${rec.id}`;
    rec.status = status;
    l.parked++;
    l.run.status = "waiting";
    this.save(l);
    const pending = new Promise<T>((resolveIt, reject) => {
      const onAbort = () => {
        this.waiters.delete(key);
        reject(new Error("stopped by you"));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      this.waiters.set(key, (v) => {
        signal.removeEventListener("abort", onAbort);
        this.waiters.delete(key);
        resolveIt(v as T);
      });
    });
    this.emit(l, type, data, rec.id);
    void this.extras.onAttention?.(l.run, rec, type);
    try {
      return await pending;
    } finally {
      l.parked--;
      rec.status = "running";
      if (l.run.status === "waiting" && !l.parked) l.run.status = "running";
      this.save(l);
    }
  }

  /** Answer a step's question. False when that step is not asking. */
  answer(runId: string, stepId: string, answer: string): boolean {
    const rec = this.live.get(runId)?.run.steps.find((s) => s.id === stepId);
    return rec?.status === "waiting" ? this.resolveWaiter(`${runId}:${stepId}`, answer) : false;
  }

  /** Continue, edit or redo a step paused at a checkpoint. */
  review(runId: string, stepId: string, decision: ReviewDecision): boolean {
    const rec = this.live.get(runId)?.run.steps.find((s) => s.id === stepId);
    return rec?.status === "review" ? this.resolveWaiter(`${runId}:${stepId}`, decision) : false;
  }

  /** Stops one step (running, asking or paused); steps that depend on it are skipped. */
  stopStep(runId: string, stepId: string): boolean {
    const ctrl = this.live.get(runId)?.stepAborts.get(stepId);
    if (!ctrl) return false;
    ctrl.abort();
    return true;
  }

  /**
   * Replaces a finished step's answer. Later steps that have not started use your version;
   * on a finished run it updates the record (and the result, when it was this step's answer).
   */
  editStep(runId: string, stepId: string, output: string): { ok: boolean; error?: string } {
    const l = this.live.get(runId);
    const run = l?.run ?? this.store.getRun(runId);
    const rec = run?.steps.find((s) => s.id === stepId);
    if (!run || !rec) return { ok: false, error: "step not found" };
    if (rec.status === "review") return this.review(runId, stepId, { action: "edit", output }) ? { ok: true } : { ok: false, error: "not paused" };
    if (rec.status !== "done") return { ok: false, error: "only finished steps can be edited" };
    const finished = ["done", "failed", "cancelled"].includes(run.status);
    const started = run.plan?.steps.filter((s) => s.dependsOn.includes(stepId)).some((s) => run.steps.find((x) => x.id === s.id)?.status !== "pending");
    if (!finished && started) return { ok: false, error: "steps that use this answer have already started; turn on checkpoints to edit before they do" };
    const old = rec.output ?? "";
    this.recordCorrection(run, rec, old, output);
    rec.output = output;
    rec.edited = true;
    if (finished && run.result === old) run.result = output;
    if (l) this.emit(l, "step.edited", { output }, stepId);
    this.store.saveRun(run);
    return { ok: true };
  }

  private resolveWaiter(key: string, value: unknown): boolean {
    const w = this.waiters.get(key);
    if (!w) return false;
    w(value);
    return true;
  }

  /** Your edits become corrections in memory, so similar future tasks see what you changed. */
  private recordCorrection(run: RunRecord, rec: StepRecord, before: string, after: string) {
    if (before === after || !this.config.memory.enabled) return;
    this.store.addMemory({
      runId: `${run.id}:${rec.id}:correction`,
      task: `${run.task}\n${rec.title}`,
      kind: rec.kind,
      summary: `The user corrected an answer (${rec.agent ?? rec.kind}, ${rec.provider ?? "?"}) for "${rec.title}".\nBefore (excerpt):\n${before.slice(0, 1200)}\n\nAfter, the user's version (excerpt):\n${after.slice(0, 1800)}`,
      ts: Date.now(),
    });
  }

  private async synthesize(l: Live, done: StepRecord[]): Promise<string> {
    const prompt = synthesisPrompt(
      l.run.task,
      done.map((s) => ({ title: s.title, agent: s.agent, provider: s.provider, output: truncate(s.output ?? "", MAX_DEP_CHARS * 2) })),
    );
    const ranked = this.router.rank({ kind: "writing", prefer: [this.config.brain.planner] }, await this.cluster.candidates());
    const id = "synthesis";
    const system = await this.briefing();
    for (const cand of ranked.slice(0, MAX_ATTEMPTS)) {
      this.emit(l, "step.started", { title: "Synthesize final answer", kind: "writing", ranking: [cand] }, id);
      const res = await this.cluster.run(cand.node, cand.provider, {
        prompt,
        system,
        permission: "read",
        timeoutMs: this.config.brain.stepTimeoutMinutes * 60_000,
        signal: l.abort.signal,
        onDelta: (text) => this.emit(l, "step.delta", { text }, id),
      });
      this.store.recordUsage(cand.provider, cand.node, res.ok, res.durationMs);
      if (res.ok) {
        this.emit(l, "step.completed", { provider: res.provider, node: cand.node, durationMs: res.durationMs, output: res.text }, id);
        return res.text;
      }
      this.emit(l, "step.failed", { error: res.error }, id);
    }
    // Synthesis failed everywhere: hand back the raw step outputs rather than nothing.
    return done.map((s) => `## ${s.title}\n\n${s.output}`).join("\n\n");
  }
}

/** Renames a plan's step ids (and references to them) so they can't collide with earlier steps. */
function prefixIds(plan: Plan, prefix: string): Plan {
  const p = (id: string) => `${prefix}${id}`;
  return {
    ...plan,
    steps: plan.steps.map((s) => ({ ...s, id: p(s.id), dependsOn: s.dependsOn.map(p), differentFrom: s.differentFrom?.map(p) })),
  };
}

function testLabel(t?: TestRun): string {
  return !t ? "not run" : t.ok ? "passed" : "FAILED";
}

const PERMISSION_RANK: Record<Permission, number> = { read: 0, edit: 1, full: 2 };
function lowerPermission(a: Permission, b: Permission): Permission {
  return PERMISSION_RANK[a] <= PERMISSION_RANK[b] ? a : b;
}

function verdictOf(review?: string): string | undefined {
  return review?.match(/VERDICT:\s*(APPROVE WITH CHANGES|APPROVE|REWORK)/i)?.[1].toUpperCase();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]`;
}
