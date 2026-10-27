import { useState } from "react";
import { Api, LABEL, type RunRecord, type StepRecord } from "./api";
import { md } from "./md";

const STATUS: Record<StepRecord["status"], string> = {
  pending: "waiting to start",
  running: "working",
  waiting: "has a question",
  review: "paused for you",
  done: "done",
  failed: "failed",
  skipped: "skipped",
};

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: md(text) }} />;
}

/** One agent's step: what it is doing, and what you can do about it right now. */
export function StepCard({ run, step, live, onChange }: { run: RunRecord; step: StepRecord; live?: string; onChange: () => void }) {
  const [mode, setMode] = useState<"" | "edit" | "redo">("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [rated, setRated] = useState<0 | 1 | -1>(0);
  const finished = ["done", "failed", "cancelled"].includes(run.status);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      setMode("");
      setText("");
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const open = (m: "edit" | "redo") => {
    setMode(m);
    setText(m === "edit" ? (step.output ?? "") : "");
  };

  const who = step.provider ? `${LABEL[step.provider] ?? step.provider}${step.node ? ` @ ${step.node}` : ""}` : "";
  const attention = step.status === "waiting" || step.status === "review";

  return (
    <article className={`step s-${step.status} ${attention ? "attention" : ""}`}>
      <header className="step-h">
        <div className="step-title">
          <span className={`dot d-${step.status}`} aria-hidden />
          <span>{step.title}</span>
        </div>
        <div className="step-meta">
          {who && <span className={`badge p-${step.provider}`}>{who}</span>}
          <span className="chip">{STATUS[step.status]}</span>
          {step.edited && <span className="chip">edited by you</span>}
        </div>
      </header>
      <div className="muted small">{[step.agent, step.kind.replace(/_/g, " ")].filter(Boolean).join(" · ")}</div>

      {step.answers?.map((qa, i) => (
        <div key={i} className="qa small">
          <div>
            <b>Asked:</b> {qa.question}
          </div>
          <div>
            <b>You:</b> {qa.answer}
          </div>
        </div>
      ))}

      {step.status === "running" && live && <pre className="live">{live.slice(-3000)}</pre>}

      {step.status === "waiting" && step.question && (
        <div className="ask">
          <div className="ask-q">{step.question}</div>
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Your answer" autoFocus />
          <div className="actions">
            <button className="primary" disabled={busy || !text.trim()} onClick={() => act(() => Api.answer(run.id, step.id, text.trim()))}>
              Answer
            </button>
          </div>
        </div>
      )}

      {(step.status === "review" || step.status === "done") && step.output && mode !== "edit" && (
        <details className="out" open={step.status === "review"}>
          <summary className="small">Answer</summary>
          <Markdown text={step.output} />
        </details>
      )}

      {(step.status === "failed" || step.status === "skipped") && step.error && <div className="error small">{step.error}</div>}

      {mode === "edit" && (
        <div className="editor">
          <textarea rows={12} value={text} onChange={(e) => setText(e.target.value)} />
          <p className="muted small">Your version replaces the agent's answer here and for any step that has not started yet. It is also saved as a correction for similar tasks.</p>
          <div className="actions">
            <button
              className="primary"
              disabled={busy || !text.trim()}
              onClick={() => act(() => (step.status === "review" ? Api.review(run.id, step.id, { action: "edit", output: text }) : Api.edit(run.id, step.id, text)))}
            >
              Save {step.status === "review" ? "and continue" : "edit"}
            </button>
            <button className="ghost" onClick={() => setMode("")}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === "redo" && (
        <div className="editor">
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="What should it do differently?" autoFocus />
          <div className="actions">
            <button className="primary" disabled={busy || !text.trim()} onClick={() => act(() => Api.review(run.id, step.id, { action: "redo", instructions: text.trim() }))}>
              Redo
            </button>
            <button className="ghost" onClick={() => setMode("")}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {!mode && (
        <div className="actions">
          {step.status === "review" && (
            <>
              <button className="primary" disabled={busy} onClick={() => act(() => Api.review(run.id, step.id, { action: "continue" }))}>
                Continue
              </button>
              <button className="ghost" onClick={() => open("edit")}>
                Edit
              </button>
              <button className="ghost" onClick={() => open("redo")}>
                Redo…
              </button>
            </>
          )}
          {["running", "waiting", "review"].includes(step.status) && !finished && (
            <button className="ghost danger" disabled={busy} onClick={() => act(() => Api.stop(run.id, step.id))}>
              Stop
            </button>
          )}
          {step.status === "done" && step.output && (
            <>
              <button className="ghost" onClick={() => open("edit")}>
                Edit answer
              </button>
              <span className="rate" aria-label="Was this the right model for the job?">
                <button className={`ghost small ${rated === 1 ? "on" : ""}`} aria-label="Good" onClick={() => act(() => Api.rate(run.id, step.id, 1).then(() => setRated(1)))}>
                  👍
                </button>
                <button className={`ghost small ${rated === -1 ? "on" : ""}`} aria-label="Bad" onClick={() => act(() => Api.rate(run.id, step.id, -1).then(() => setRated(-1)))}>
                  👎
                </button>
              </span>
            </>
          )}
        </div>
      )}
      {error && <div className="error small">{error}</div>}
    </article>
  );
}
