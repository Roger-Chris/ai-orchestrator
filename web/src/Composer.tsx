import { useEffect, useRef, useState } from "react";
import { type Agent, LABEL, type RunOptions } from "./api";

const OPTIONS_KEY = "orc.options";
const DEFAULTS: RunOptions = { mode: "auto", ask: true };

function loadOptions(): RunOptions {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

/**
 * Where you talk to the agents. Start a message with @agent to send it to one specialist.
 * Options stick per device (the phone can keep different defaults from the desktop).
 */
export function Composer({ agents, onSend, disabled }: { agents: Agent[]; onSend: (text: string, o: RunOptions) => Promise<void>; disabled?: boolean }) {
  const [text, setText] = useState("");
  const [opts, setOpts] = useState<RunOptions>(loadOptions);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(opts));
    } catch {
      /* not remembered: fine */
    }
  }, [opts]);

  // Grow with the text, up to a point.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 240)}px`;
    el.style.overflowY = el.scrollHeight > 240 ? "auto" : "hidden";
  }, [text]);

  const mention = text.match(/^@([\w-]+)\s/)?.[1];
  const mentioned = mention && agents.find((a) => a.name === mention);

  const send = async () => {
    const body = mentioned ? text.slice(mention!.length + 2).trim() : text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError("");
    try {
      const o: RunOptions = { ...opts, ...(mentioned ? { agent: mentioned.name, mode: "direct" } : {}) };
      if (o.branches && (!o.permission || o.permission === "read")) o.permission = "edit";
      await onSend(body, o);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const set = <K extends keyof RunOptions>(k: K, v: RunOptions[K]) => setOpts((o) => ({ ...o, [k]: v || undefined }));

  return (
    <div className="composer">
      {open && (
        <div className="options">
          <label>
            How
            <select value={opts.mode ?? "auto"} onChange={(e) => set("mode", e.target.value as RunOptions["mode"])}>
              <option value="auto">Brain decides</option>
              <option value="plan">Plan and split</option>
              <option value="direct">One model</option>
              <option value="design">Design first, then build</option>
            </select>
          </label>
          <label>
            Model
            <select value={opts.provider ?? ""} onChange={(e) => set("provider", e.target.value as RunOptions["provider"])}>
              <option value="">Best for the job</option>
              {Object.entries(LABEL).map(([id, l]) => (
                <option key={id} value={id}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label>
            Access
            <select value={opts.permission ?? ""} onChange={(e) => set("permission", e.target.value as RunOptions["permission"])}>
              <option value="">Read-only</option>
              <option value="edit">Edit files</option>
              <option value="full">Full (run anything)</option>
            </select>
          </label>
          <label className="wide">
            Folder on the hub
            <input value={opts.cwd ?? ""} onChange={(e) => set("cwd", e.target.value)} placeholder="e.g. C:\projects\my-app" />
          </label>
          <label className="check">
            <input type="checkbox" checked={!!opts.ask} onChange={(e) => set("ask", e.target.checked)} /> Agents may ask me
          </label>
          <label className="check">
            <input type="checkbox" checked={!!opts.checkpoints} onChange={(e) => set("checkpoints", e.target.checked)} /> Pause after each step
          </label>
          <label className="check">
            <input type="checkbox" checked={!!opts.branches} onChange={(e) => set("branches", e.target.checked)} /> Code on branches across devices
          </label>
        </div>
      )}
      <div className="compose-row">
        <button className={`ghost icon ${open ? "on" : ""}`} onClick={() => setOpen((v) => !v)} aria-label="Options" aria-expanded={open} title="Options">
          ⚙
        </button>
        <textarea
          ref={ta}
          rows={1}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends on a keyboard; on phones the return key makes a new line.
            if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Message the agents. Start with @coder, @researcher… to pick one."
        />
        <button className="primary" disabled={busy || disabled || !text.trim()} onClick={() => void send()} aria-label="Send">
          ↑
        </button>
      </div>
      <div className="compose-hint small muted">
        {mentioned ? `To @${mentioned.name} only · ` : ""}
        {modeLabel(opts)}
        {error && <span className="bad"> · {error}</span>}
      </div>
    </div>
  );
}

function modeLabel(o: RunOptions): string {
  const parts = [{ auto: "brain decides", plan: "plan and split", direct: "one model", design: "design first" }[o.mode ?? "auto"]];
  if (o.provider) parts.push(LABEL[o.provider]);
  parts.push(o.permission === "edit" ? "can edit files" : o.permission === "full" ? "full access" : "read-only");
  if (o.ask) parts.push("may ask you");
  if (o.checkpoints) parts.push("pauses after each step");
  if (o.branches) parts.push("branches");
  return parts.join(" · ");
}
