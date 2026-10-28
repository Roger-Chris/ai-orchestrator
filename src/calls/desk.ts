import type { AlertAction, BrainAlert, DayTask } from "../types.js";

/**
 * A phone call about one brain alert. The phone speaks what the hub says (its own text-to-speech),
 * records what you answer, and sends it here; the hub transcribes it (Groq Whisper), asks a model
 * what to say and do, and does it.
 *
 * What a call can do is a fixed, safe list. Nothing here can send a message, buy, delete or edit:
 * - done, snooze, dismiss: your answer to the alert, recorded in the brain (AssistantTasks.ack);
 * - draft_reply: a read-only run that writes a reply for you to send yourself;
 * - delegate: a read-only run (research or drafting) with your words as the task;
 * - none: just talk.
 * draft_reply and delegate only happen after the assistant proposed them and you said yes.
 */

export const CALL_ACTIONS = ["done", "snooze", "dismiss", "draft_reply", "delegate", "none"] as const;
export type CallAction = (typeof CALL_ACTIONS)[number];
type RunAction = "draft_reply" | "delegate";
const ACKS: AlertAction[] = ["done", "snooze", "dismiss"];
const RUNS: RunAction[] = ["draft_reply", "delegate"];

export interface CallLine {
  who: "assistant" | "owner";
  text: string;
  at: number;
}

export interface CallState {
  alertId: number;
  lines: CallLine[];
  /** A run the assistant offered and is waiting for your yes. */
  proposal?: { action: RunAction; args: Record<string, string> };
  /** Runs started from this call. */
  runs: string[];
  ended: boolean;
  touched: number;
}

export interface TurnResult {
  /** What the hub heard (your words). */
  transcript: string;
  /** What the phone should speak. */
  say: string;
  /** What was done; `none` when nothing was (including a refused or not yet agreed action). */
  action: CallAction;
  /** The call is over (the alert was answered). */
  done: boolean;
  /** The read-only run started by draft_reply or delegate. */
  runId?: string;
  /** An action the model asked for that is not allowed. */
  refused?: string;
  /** draft_reply or delegate, offered and waiting for your yes. */
  proposed?: RunAction;
}

export class CallError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502,
  ) {
    super(message);
  }
}

export interface CallDeps {
  /** Groq: speech-to-text and the JSON decision. Absent when the hub has no Groq key. */
  voice?: { configured: boolean; transcribe(audio: Blob, filename: string): Promise<string>; decide(system: string, prompt: string): Promise<string> };
  /** Without Groq, typed turns are decided by another model (Claude, Gemini, ChatGPT): the raw answer. */
  think?: (system: string, prompt: string) => Promise<string>;
  /** Records your answer in the brain. */
  ack: (alertId: number, action: AlertAction) => Promise<void>;
  /** Starts a READ-ONLY orchestrator run; returns its id. */
  start: (task: string) => string;
  /** The live owner/setup briefing (src/brain/setup.ts). */
  setup?: () => Promise<string>;
  /** The brain task behind the alert, when it is on today's list. */
  task?: (taskId: number) => DayTask | undefined;
}

/** A call left alone this long is forgotten. */
const IDLE_MS = 2 * 60 * 60_000;
const YES = /\b(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|do that|please do|sounds good|go for it|haan|han|ha|ji|correct|right|fine|alright)\b/i;
const NO = /\b(no|nope|don'?t|do not|not now|wait|stop|cancel|never)\b/i;

/** Did the owner agree (and not also say no)? */
export function agrees(words: string): boolean {
  return YES.test(words) && !NO.test(words);
}

const shortText = (s: unknown, n: number) => (typeof s === "string" ? s.trim().slice(0, n) : "");

export class CallDesk {
  private calls = new Map<number, CallState>();

  constructor(private deps: CallDeps) {}

  /** Can the phone talk (voice) here, or only type? */
  get voice(): boolean {
    return !!this.deps.voice?.configured;
  }

  /** Can this hub answer a call at all (voice or typed)? */
  get available(): boolean {
    return this.voice || !!this.deps.think;
  }

  state(alertId: number): CallState | undefined {
    this.forgetIdle();
    return this.calls.get(alertId);
  }

  private open(alertId: number): CallState {
    this.forgetIdle();
    let s = this.calls.get(alertId);
    if (!s) {
      s = { alertId, lines: [], runs: [], ended: false, touched: Date.now() };
      this.calls.set(alertId, s);
    }
    s.touched = Date.now();
    return s;
  }

  private forgetIdle() {
    const cutoff = Date.now() - IDLE_MS;
    for (const [id, s] of this.calls) if (s.touched < cutoff) this.calls.delete(id);
  }

  end(alertId: number) {
    const s = this.calls.get(alertId);
    if (s) s.ended = true;
  }

  /**
   * What the assistant says when you answer: the situation and a suggested way out, from the
   * model when one answers, else the alert's own words.
   */
  async answer(alert: BrainAlert): Promise<{ say: string }> {
    const s = this.open(alert.id);
    s.ended = false;
    const said = s.lines.find((l) => l.who === "assistant");
    if (said) return { say: said.text };
    let say = "";
    if (this.available) {
      try {
        const raw = await this.ask(await this.system(), `${this.context(alert, s)}\n\nThe owner just answered the call. Open it: in two or three short spoken sentences, say what this is about, suggest the best next step, and ask what they want to do. Use action "none".`);
        say = shortText(parseDecision(raw)?.say, 600);
      } catch {
        /* the alert's own words below */
      }
    }
    say ||= `${alert.title}. ${alert.body}`.trim();
    s.lines.push({ who: "assistant", text: say, at: Date.now() });
    return { say };
  }

  /** One exchange: your words (typed, or a voice clip to transcribe) in, what to say and do out. */
  async turn(alert: BrainAlert, input: { text?: string; audio?: { data: Blob; filename: string } }): Promise<TurnResult> {
    if (input.audio && !this.voice) throw new CallError("The hub has no Groq key, so it can't hear voice. Type your answer instead (or add GROQ_API_KEY to the hub's .env).", 409);
    if (!this.available) throw new CallError("No model is ready to take the call: add GROQ_API_KEY to the hub's .env.", 409);
    const s = this.open(alert.id);
    if (s.ended) throw new CallError("This call has ended.", 409);

    let transcript = input.text?.trim() ?? "";
    if (input.audio) {
      try {
        transcript = await this.deps.voice!.transcribe(input.audio.data, input.audio.filename);
      } catch (e) {
        throw new CallError(`Couldn't transcribe that: ${(e as Error).message}`, 502);
      }
    }
    if (!transcript) return { transcript, say: "Sorry, I didn't catch that. Could you say it again?", action: "none", done: false };
    s.lines.push({ who: "owner", text: transcript, at: Date.now() });

    let decision: Decision | undefined;
    try {
      decision = parseDecision(await this.ask(await this.system(), `${this.context(alert, s)}\n\nThe owner just said: "${transcript}"\nAnswer as JSON.`));
    } catch (e) {
      throw new CallError(`The model did not answer: ${(e as Error).message}`, 502);
    }
    const result = await this.act(alert, s, transcript, decision);
    s.lines.push({ who: "assistant", text: result.say, at: Date.now() });
    return result;
  }

  private async act(alert: BrainAlert, s: CallState, transcript: string, d: Decision | undefined): Promise<TurnResult> {
    const base = { transcript, done: false };
    if (!d) return { ...base, say: "Sorry, I lost my thread there. Could you say that again?", action: "none" };
    let say = shortText(d.say, 800);
    const wanted = typeof d.action === "string" ? d.action.trim() : "none";

    // Only the fixed list. Anything else is refused, whatever the model thought.
    if (!(CALL_ACTIONS as readonly string[]).includes(wanted)) {
      return {
        ...base,
        action: "none",
        refused: wanted.slice(0, 60),
        say: "I can't do that from a call. I can mark this done, snooze it for an hour, set it aside as not important, draft a reply for you to send, or hand a research or drafting task to your models.",
      };
    }
    const action = wanted as CallAction;

    if ((ACKS as string[]).includes(action)) {
      try {
        await this.deps.ack(alert.id, action as AlertAction);
      } catch (e) {
        return { ...base, action: "none", say: `I couldn't reach your assistant to record that (${(e as Error).message}). Try again in a moment, or use the buttons.` };
      }
      s.ended = true;
      s.proposal = undefined;
      const fallback = { done: "Marked as done.", snooze: "Snoozed for an hour.", dismiss: "Okay, set aside as not important." }[action as AlertAction];
      return { ...base, action, done: true, say: say || fallback };
    }

    if ((RUNS as string[]).includes(action)) {
      const run = action as RunAction;
      const args = cleanArgs(d.args);
      // Runs only after the assistant offered this one and the owner said yes to it.
      if (s.proposal?.action === run && agrees(transcript)) {
        const merged = { ...s.proposal.args, ...args };
        const runId = this.deps.start(runTask(run, alert, merged, transcript));
        s.runs.push(runId);
        s.proposal = undefined;
        return { ...base, action: run, runId, say: say || (run === "draft_reply" ? "On it. The draft will be on your phone; I won't send anything." : "On it. I'll let you know when it's ready.") };
      }
      s.proposal = { action: run, args };
      if (!say.includes("?")) say = `${say} ${run === "draft_reply" ? "Shall I draft that for you to send yourself?" : "Shall I hand that to your models?"}`.trim();
      return { ...base, action: "none", proposed: run, say };
    }

    // "none": a short plain yes still carries out what was just offered.
    if (s.proposal && agrees(transcript) && transcript.split(/\s+/).length <= 4) {
      const p = s.proposal;
      const runId = this.deps.start(runTask(p.action, alert, p.args, transcript));
      s.runs.push(runId);
      s.proposal = undefined;
      return { ...base, action: p.action, runId, say: p.action === "draft_reply" ? "On it. The draft will be on your phone; I won't send anything." : "On it. I'll let you know when it's ready." };
    }
    return { ...base, action: "none", say: say || "Okay." };
  }

  private ask(system: string, prompt: string): Promise<string> {
    if (this.voice) return this.deps.voice!.decide(system, prompt);
    return this.deps.think!(system, prompt);
  }

  private async system(): Promise<string> {
    let setup = "";
    try {
      setup = (await this.deps.setup?.()) ?? "";
    } catch {
      /* a failing briefing is skipped, never fatal */
    }
    return [CALL_RULES, setup].filter(Boolean).join("\n\n");
  }

  private context(alert: BrainAlert, s: CallState): string {
    const parts = [`ALERT (level ${alert.level}, ${alert.kind}): ${alert.title}\n${alert.body}`];
    const task = alert.task_id != null ? this.deps.task?.(alert.task_id) : undefined;
    if (task) parts.push(`THE TASK BEHIND IT: ${task.title}${task.time ? ` (${task.time})` : ""}${task.detail ? ` · ${task.detail}` : ""}${task.done ? " [done]" : ""}`);
    const convo = s.lines.slice(-12).map((l) => `${l.who === "owner" ? "Owner" : "You"}: ${l.text}`);
    // The owner's newest words are given separately by the caller.
    if (convo.length && s.lines.at(-1)?.who === "owner") convo.pop();
    if (convo.length) parts.push(`THE CALL SO FAR:\n${convo.join("\n")}`);
    if (s.proposal) parts.push(`YOU OFFERED: ${s.proposal.action} ${JSON.stringify(s.proposal.args)}. If the owner agrees, return that same action again.`);
    return parts.join("\n\n");
  }
}

interface Decision {
  say?: unknown;
  action?: unknown;
  args?: unknown;
}

/** The model's JSON answer, also when wrapped in a code fence or prose. */
export function parseDecision(raw: string): Decision | undefined {
  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === "object" ? (v as Decision) : undefined;
  } catch {
    return undefined;
  }
}

function cleanArgs(args: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!args || typeof args !== "object") return out;
  for (const [k, v] of Object.entries(args as Record<string, unknown>).slice(0, 6)) {
    if (/^\w{1,30}$/.test(k) && (typeof v === "string" || typeof v === "number")) out[k] = String(v).slice(0, 2000);
  }
  return out;
}

/** The task text for a read-only run started from a call. */
function runTask(action: RunAction, alert: BrainAlert, args: Record<string, string>, words: string): string {
  const about = `Context (an alert from the owner's assistant): ${alert.title}. ${alert.body}`.trim();
  if (action === "draft_reply") {
    return [
      `Draft a reply for the owner to send themselves. Write only the reply text, ready to copy. Do NOT send anything or contact anyone.`,
      about,
      args.to ? `To: ${args.to}` : "",
      `What the owner wants to say: ${args.instructions ?? args.text ?? words}`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  return [
    args.task ?? words,
    about,
    "Research or drafting only: do not send messages, buy, book, delete or change anything. Report back what you found or wrote.",
  ].join("\n\n");
}

const CALL_RULES = `You are the owner's personal assistant, on a voice call with them about one alert. Your words are spoken aloud by their phone, so keep "say" short (one to three plain sentences, no lists, no markdown, no emoji), warm and direct. Explain the situation when needed, suggest the best next step, and listen.

Answer ONLY with a JSON object: {"say": "...", "action": "...", "args": {...}}.
"action" must be exactly one of:
- "done": the owner says it is handled or wants it marked done.
- "snooze": the owner wants to be reminded later (it comes back in an hour).
- "dismiss": the owner says it is not important.
- "draft_reply": write a reply for the owner to send themselves (nothing is ever sent). args: {"to": "who", "instructions": "what to say"}.
- "delegate": hand a research or drafting task to their AI models (read-only). args: {"task": "the task in the owner's words"}.
- "none": just talk (questions, explanations, or when unsure).
Rules:
- Choose done, snooze or dismiss only when the owner clearly asks for it.
- draft_reply and delegate need the owner's agreement: first propose it in "say" (as a question); the hub waits for their yes. When they agree, return the same action again.
- You cannot send messages, call, pay, book, delete or change anything. If asked, say so and offer a draft or a delegate instead.
- Never invent facts about the situation; if unsure, ask.`;
