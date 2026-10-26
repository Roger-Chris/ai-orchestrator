import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import type { Agent } from "../agents/loader.js";
import type { Cluster } from "../cluster/cluster.js";
import type { Config } from "../config.js";
import type { Store } from "../store/db.js";
import type {
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
import { classify } from "./classifier.js";
import { buildPlannerPrompt, extractJson, normalizePlan, singleStepPlan, synthesisPrompt } from "./planner.js";
import type { Router } from "./router.js";

/** How many different (device, provider) pairs a step tries before giving up. */
const MAX_ATTEMPTS = 3;
/** Cap on each upstream output pasted into a dependent step's prompt. */
const MAX_DEP_CHARS = 16_000;

interface Live {
  run: RunRecord;
  seq: number;
  abort: AbortController;
  done: Promise<RunRecord>;
}

export class Orchestrator {
  private live = new Map<string, Live>();
  private bus = new EventEmitter();

  constructor(
    private config: Config,
    private store: Store,
    private cluster: Cluster,
    private router: Router,
    public agents: Map<string, Agent>,
  ) {
    this.bus.setMaxListeners(200);
  }

  /** Starts a run in the background and returns its record immediately. */
  submit(task: string, options: RunOptions = {}): RunRecord {
    const run: RunRecord = {
      id: randomUUID().slice(0, 8),
      task,
      options,
      status: "queued",
      steps: [],
      createdAt: Date.now(),
    };
    const abort = new AbortController();
    const entry: Live = { run, seq: 0, abort, done: Promise.resolve(run) };
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
      const c = classify(run.task);
      run.classification = c;
      this.emit(l, "run.classified", c);

      run.status = "planning";
      this.save(l);
      const mode = opts.mode ?? "auto";
      const plan =
        mode === "direct" || opts.agent || (mode === "auto" && c.complexity === "simple")
          ? singleStepPlan(run.task, c, this.agents, opts.agent)
          : await this.plan(l);
      if (opts.provider) for (const s of plan.steps) s.provider = opts.provider;
      run.plan = plan;
      run.steps = plan.steps.map((s) => ({ id: s.id, title: s.title, kind: s.kind, agent: s.agent, status: "pending", attempts: [] }));
      this.emit(l, "plan.created", plan);

      run.status = "running";
      this.save(l);
      await this.runGraph(l, plan);
      if (l.abort.signal.aborted) throw new Error("cancelled");

      const done = run.steps.filter((s) => s.status === "done");
      if (!done.length) throw new Error(run.steps.find((s) => s.error)?.error ?? "no step succeeded");

      if (plan.synthesize && done.length > 1) {
        run.result = await this.synthesize(l, done);
      } else {
        // The final answer is the output of the leaf steps (those nothing depends on).
        const depended = new Set(plan.steps.flatMap((s) => s.dependsOn));
        const leaves = done.filter((s) => !depended.has(s.id));
        const final = leaves.length ? leaves : done;
        run.result = final.map((s) => (final.length > 1 ? `## ${s.title}\n\n${s.output}` : s.output)).join("\n\n");
      }
      run.status = "done";
      run.finishedAt = Date.now();
      this.save(l);
      this.emit(l, "run.completed", { result: run.result });
    } catch (e) {
      run.status = l.abort.signal.aborted ? "cancelled" : "failed";
      run.error = (e as Error).message;
      run.finishedAt = Date.now();
      this.save(l);
      this.emit(l, "run.failed", { error: run.error });
    }
    return run;
  }

  /** Asks the planner model for a step graph; falls back to one step on any problem. */
  private async plan(l: Live): Promise<Plan> {
    const { run } = l;
    const c = run.classification!;
    const candidates = await this.cluster.candidates();
    const available = [...new Set(candidates.map((x) => x.provider))];
    const prompt = buildPlannerPrompt(run.task, c, this.agents, this.router.caps, this.config.brain.maxPlanSteps, available);
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
        return normalizePlan(extractJson(res.text), run.task, c, this.agents, this.config.brain.maxPlanSteps);
      } catch {
        /* malformed plan: try the next planner */
      }
    }
    return singleStepPlan(run.task, c, this.agents);
  }

  /** Runs steps as soon as their dependencies finish, up to maxParallelSteps at once. */
  private async runGraph(l: Live, plan: Plan): Promise<void> {
    const byId = new Map(l.run.steps.map((s) => [s.id, s]));
    const specs = new Map(plan.steps.map((s) => [s.id, s]));
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
    const permission = l.run.options.permission ?? agent?.permission ?? this.config.brain.defaultPermission;
    // Steps that change files must run here, where the workspace is.
    const needsWorkspace = !!spec.needsWorkspace || permission !== "read";
    const ranked = this.router.rank(
      {
        kind: spec.kind,
        needsWorkspace,
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
      rec.error = `no available model can run a ${spec.kind} step${needsWorkspace ? " that edits files on this device" : ""}${exclude.length ? ` (excluding ${exclude.join(", ")})` : ""}`;
      rec.finishedAt = Date.now();
      this.emit(l, "step.failed", { error: rec.error }, spec.id);
      return;
    }

    for (const cand of ranked) {
      if (rec.attempts.length >= MAX_ATTEMPTS || l.abort.signal.aborted) break;
      if (rec.attempts.length) this.emit(l, "step.fallback", { to: cand.provider, node: cand.node, why: cand.why }, spec.id);

      rec.provider = cand.provider;
      rec.node = cand.node;
      this.emit(l, "step.progress", { note: `running on ${cand.provider} @ ${cand.node} (${cand.why})` }, spec.id);
      const res: ProviderResult = await this.cluster.run(cand.node, cand.provider, {
        prompt,
        system: agent?.system,
        deep: agent?.deep || DEEP_KINDS.includes(spec.kind),
        cwd: cand.local ? resolve(l.run.options.cwd ?? process.cwd()) : undefined,
        permission: cand.local ? permission : "read",
        timeoutMs: this.config.brain.stepTimeoutMinutes * 60_000,
        signal: l.abort.signal,
        onDelta: (text) => this.emit(l, "step.delta", { text }, spec.id),
        onProgress: (note) => this.emit(l, "step.progress", { note }, spec.id),
      });
      this.store.recordUsage(cand.provider, cand.node, res.ok, res.durationMs);
      rec.attempts.push({ provider: cand.provider, node: cand.node, ok: res.ok, error: res.error, durationMs: res.durationMs });

      if (res.ok) {
        rec.status = "done";
        rec.output = res.text;
        rec.finishedAt = Date.now();
        this.emit(
          l,
          "step.completed",
          { provider: res.provider, model: res.model, node: cand.node, durationMs: res.durationMs, usage: res.usage, output: res.text },
          spec.id,
        );
        return;
      }
      this.emit(
        l,
        "step.progress",
        { note: `${cand.provider} @ ${cand.node} failed: ${res.error?.slice(0, 300)}${res.rateLimited ? " (usage limit, cooling down)" : ""}` },
        spec.id,
      );
    }

    rec.status = "failed";
    rec.error = rec.attempts.at(-1)?.error ?? "cancelled";
    rec.finishedAt = Date.now();
    this.emit(l, "step.failed", { error: rec.error }, spec.id);
  }

  private async synthesize(l: Live, done: StepRecord[]): Promise<string> {
    const prompt = synthesisPrompt(
      l.run.task,
      done.map((s) => ({ title: s.title, agent: s.agent, provider: s.provider, output: truncate(s.output ?? "", MAX_DEP_CHARS * 2) })),
    );
    const ranked = this.router.rank({ kind: "writing", prefer: [this.config.brain.planner] }, await this.cluster.candidates());
    const id = "synthesis";
    for (const cand of ranked.slice(0, MAX_ATTEMPTS)) {
      this.emit(l, "step.started", { title: "Synthesize final answer", kind: "writing", ranking: [cand] }, id);
      const res = await this.cluster.run(cand.node, cand.provider, {
        prompt,
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

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]`;
}
