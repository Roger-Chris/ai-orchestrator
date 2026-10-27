import { useCallback, useEffect, useRef, useState } from "react";
import { Api, FINISHED, LABEL, type RunRecord, streamRun } from "./api";
import { Markdown, StepCard } from "./StepCard";

/** Keeps a run up to date while it works: deltas stream in, anything else refetches the record. */
function useLiveRun(initial: RunRecord) {
  const [run, setRun] = useState(initial);
  const [live, setLive] = useState<Record<string, string>>({});
  const timer = useRef<number>(0);

  const refresh = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => Api.run(initial.id).then(setRun).catch(() => {}), 120);
  }, [initial.id]);

  useEffect(() => setRun(initial), [initial]);

  useEffect(() => {
    if (FINISHED.includes(initial.status)) return;
    return streamRun(initial.id, (ev) => {
      if (ev.type === "step.delta" && ev.stepId) {
        const text = (ev.data as { text: string }).text;
        setLive((l) => ({ ...l, [ev.stepId!]: (l[ev.stepId!] ?? "") + text }));
      } else {
        if (ev.type === "step.started" && ev.stepId) setLive((l) => ({ ...l, [ev.stepId!]: "" }));
        refresh();
      }
    });
  }, [initial.id, initial.status, refresh]);

  return { run, live, refresh };
}

const RUN_STATUS: Record<string, string> = {
  queued: "starting",
  planning: "planning",
  running: "working",
  waiting: "needs you",
  awaiting_approval: "design needs your decision",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

export function RunCard({ initial, onSettled }: { initial: RunRecord; onSettled?: () => void }) {
  const { run, live, refresh } = useLiveRun(initial);
  const finished = FINISHED.includes(run.status);
  const needsYou = run.status === "waiting" || run.status === "awaiting_approval";
  const [showSteps, setShowSteps] = useState(!finished);

  useEffect(() => {
    if (needsYou) setShowSteps(true);
  }, [needsYou]);
  useEffect(() => {
    if (finished) onSettled?.();
  }, [finished, onSettled]);

  const models = [...new Set(run.steps.map((s) => s.provider).filter(Boolean))].map((p) => LABEL[p!] ?? p).join(", ");

  return (
    <section className={`run ${needsYou ? "attention" : ""}`}>
      <header className="run-h">
        <button className="link" onClick={() => setShowSteps((v) => !v)} aria-expanded={showSteps}>
          <span className={`dot r-${run.status}`} aria-hidden />
          {RUN_STATUS[run.status] ?? run.status}
          {run.steps.length > 0 && ` · ${run.steps.length} step${run.steps.length > 1 ? "s" : ""}`}
          {models && ` · ${models}`}
          <span className="chev">{showSteps ? "▾" : "▸"}</span>
        </button>
        {!finished && (
          <button className="ghost small" onClick={() => Api.cancel(run.id).then(refresh)}>
            Cancel
          </button>
        )}
      </header>

      {showSteps && (
        <div className="steps">
          {run.steps.map((s) => (
            <StepCard key={s.id} run={run} step={s} live={live[s.id]} onChange={refresh} />
          ))}
          {!run.steps.length && !finished && <div className="muted small pad">Planning who does what…</div>}
        </div>
      )}

      {run.status === "awaiting_approval" && <DesignDecision run={run} onDone={refresh} />}
      {run.steps.some((s) => s.branch?.pushed) && <Branches run={run} onChange={refresh} />}

      {run.result && (
        <div className="answer">
          <Markdown text={run.result} />
          <div className="actions">
            <button className="ghost small" onClick={() => navigator.clipboard?.writeText(run.result ?? "")}>
              Copy
            </button>
          </div>
        </div>
      )}
      {run.status === "failed" && run.error && <div className="error">{run.error}</div>}
    </section>
  );
}

function DesignDecision({ run, onDone }: { run: RunRecord; onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reviews = run.design?.reviewStepIds.map((id) => run.steps.find((s) => s.id === id)).filter(Boolean) ?? [];
  const verdict = (out?: string) => out?.match(/VERDICT:\s*(APPROVE WITH CHANGES|APPROVE|REWORK)/i)?.[1] ?? "reviewed";
  const go = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="decision">
      <h3>The design is ready for your decision</h3>
      <p className="muted small">
        Round {run.design?.round}. Reviews:{" "}
        {reviews.map((r) => `${LABEL[r!.provider ?? ""] ?? r!.provider}: ${r!.status === "done" ? verdict(r!.output) : "failed"}`).join(" · ") || "none"}
      </p>
      <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Which findings to address, or what to change" />
      <div className="actions">
        <button className="primary" disabled={busy} onClick={() => go(() => Api.approve(run.id, text))}>
          Approve &amp; build
        </button>
        <button className="ghost" disabled={busy || !text.trim()} onClick={() => go(() => Api.revise(run.id, text))}>
          Send back for revision
        </button>
      </div>
      {error && <div className="error small">{error}</div>}
    </div>
  );
}

function Branches({ run, onChange }: { run: RunRecord; onChange: () => void }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const steps = run.steps.filter((s) => s.branch?.pushed);
  const finished = FINISHED.includes(run.status);
  const merge = async (id: string) => {
    setBusy(id);
    setError("");
    try {
      await Api.merge(run.id, id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
      onChange();
    }
  };
  return (
    <div className="branches">
      <h3>Branches to review</h3>
      <p className="muted small">Merging happens in the run's folder on the hub, into the branch checked out there. A conflict stops the merge and changes nothing.</p>
      {steps.map((s) => {
        const b = s.branch!;
        return (
          <div className="branch" key={s.id}>
            <div className="branch-h">
              <strong>{s.title}</strong>
              <span className={`badge p-${s.provider}`}>
                {LABEL[s.provider ?? ""] ?? s.provider} @ {b.node}
              </span>
            </div>
            <div className="small">
              <code>{b.name}</code> · {b.changedFiles.length} file(s) ·{" "}
              {!b.tests ? <span className="muted">tests not run</span> : b.tests.ok ? <span className="ok">tests passed</span> : <span className="bad">tests failed</span>}
            </div>
            <details>
              <summary className="small">Changes</summary>
              <pre>{b.diffStat}</pre>
              <pre>{b.diff}</pre>
              {b.tests && !b.tests.ok && <pre>{b.tests.output}</pre>}
            </details>
            <div className="actions">
              <button className="primary small" disabled={!finished || b.merged || busy === s.id} onClick={() => merge(s.id)}>
                {b.merged ? "Merged" : busy === s.id ? "Merging…" : "Merge"}
              </button>
              {b.mergeError && <span className="bad small">{b.mergeError}</span>}
              {!finished && <span className="muted small">Merge when the run finishes.</span>}
            </div>
          </div>
        );
      })}
      {error && <div className="error small">{error}</div>}
    </div>
  );
}
