import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { runProcess, tryParseJson } from "../providers/base.js";
import type { Store } from "../store/db.js";
import type { RunRecord } from "../types.js";

const SUMMARY_CHARS = 3000;

type Exec = typeof runProcess;

/**
 * Long-term memory of finished runs. Always kept locally (SQLite full-text search);
 * optionally mirrored to a NotebookLM notebook, which can also be asked about new tasks.
 */
export class Memory {
  constructor(
    private config: Config,
    private store: Store,
    private exec: Exec = runProcess,
  ) {}

  private get nlm() {
    const n = this.config.memory.notebooklm;
    return n.enabled && n.notebook ? n : undefined;
  }

  /** Saves a finished run. NotebookLM failures are reported, never thrown. */
  async remember(run: RunRecord, onWarn?: (msg: string) => void): Promise<void> {
    if (!this.config.memory.enabled || run.status !== "done") return;
    const summary = summarize(run);
    this.store.addMemory({ runId: run.id, task: run.task, kind: run.classification?.kind ?? "", summary, ts: run.finishedAt ?? Date.now() });

    const nlm = this.nlm;
    if (!nlm) return;
    // A file rather than an argument: summaries are long and Windows caps command lines.
    const dir = mkdtempSync(join(tmpdir(), "orc-mem-"));
    try {
      const file = join(dir, `run-${run.id}.md`);
      writeFileSync(file, `# ${run.task.slice(0, 120)}\n\n${summary}\n`);
      const r = await this.exec({
        command: nlm.command,
        args: ["source", "add", file, "--notebook", nlm.notebook!, "--type", "file", "--title", `Run ${run.id}: ${run.task.slice(0, 80)}`, "--json"],
        timeoutMs: 120_000,
      });
      if (r.code !== 0) onWarn?.(`NotebookLM: could not save run ${run.id}: ${(r.stderr || r.stdout).trim().slice(-300)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Relevant past runs for a new task, as a prompt section, or undefined when there are none. */
  async recall(task: string, excludeRunId?: string): Promise<string | undefined> {
    if (!this.config.memory.enabled) return undefined;
    const parts: string[] = [];
    const hits = this.store.searchMemory(task, this.config.memory.recall, excludeRunId);
    if (hits.length) {
      parts.push(
        hits
          .map((h) => `### ${new Date(h.ts).toISOString().slice(0, 10)} · ${h.task.slice(0, 160)}\n${h.summary.slice(0, 1200)}`)
          .join("\n\n"),
      );
    }
    const nlm = this.nlm;
    if (nlm?.ask) {
      const answer = await this.askNotebook(
        `A new task is about to be planned. From earlier runs in this notebook, list briefly any decisions, designs, ` +
          `problems or results that matter for it. If nothing is relevant, reply exactly: NOTHING RELEVANT.\n\nNEW TASK:\n${task.slice(0, 4000)}`,
      );
      if (answer && !/NOTHING RELEVANT/i.test(answer)) parts.push(`From your NotebookLM memory:\n${answer}`);
    }
    return parts.length ? parts.join("\n\n") : undefined;
  }

  private async askNotebook(question: string): Promise<string | undefined> {
    const nlm = this.nlm!;
    const r = await this.exec({
      command: nlm.command,
      args: ["ask", "--notebook", nlm.notebook!, "--prompt-file", "-", "--json"],
      stdin: question,
      timeoutMs: 120_000,
    });
    if (r.code !== 0) return undefined;
    const j = tryParseJson(r.stdout);
    const text = j ? (j.answer ?? j.text ?? j.response ?? j.content) : r.stdout;
    return typeof text === "string" && text.trim() ? text.trim().slice(0, 4000) : undefined;
  }

  /** For `orc doctor`: whether the NotebookLM CLI is installed and logged in. */
  async notebookStatus(): Promise<string> {
    const n = this.config.memory.notebooklm;
    if (!n.enabled) return "off (local memory only)";
    if (!n.notebook) return "enabled but memory.notebooklm.notebook is not set";
    const r = await this.exec({ command: n.command, args: ["auth", "check", "--test", "--passive", "--json"], timeoutMs: 60_000 });
    if (r.spawnError) return `\`${n.command}\` not found. Install: uv tool install "notebooklm-py[browser]"`;
    return r.code === 0 ? `ready (notebook ${n.notebook})` : "not logged in. Run `notebooklm login`";
  }
}

/** What is worth remembering about a run: the task, the approved design, the outcome. */
export function summarize(run: RunRecord): string {
  const design = run.design ? run.steps.find((s) => s.id === run.design!.draftStepId)?.output : undefined;
  const models = [...new Set(run.steps.filter((s) => s.status === "done" && s.provider).map((s) => s.provider))].join(", ");
  const parts = [
    `Task: ${run.task.slice(0, 600)}`,
    `Kind: ${run.classification?.kind ?? "?"} · models: ${models || "?"} · steps: ${run.steps.length}`,
    design ? `Approved design (excerpt):\n${design.slice(0, 1200)}` : "",
    `Result (excerpt):\n${(run.result ?? "").slice(0, SUMMARY_CHARS)}`,
  ];
  return parts.filter(Boolean).join("\n\n").slice(0, SUMMARY_CHARS + 1800);
}
