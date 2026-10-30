import * as SecureStore from "expo-secure-store";
import { WaReply } from "./wareply";
import type { PersonSummary } from "../../../src/types";
import type { WorkPerson, WorkPersonView, WorkStatus, WorkTask } from "../../../src/types";
import type { AiHub, Build, BrainAlert, OutsideAgent, OutsideAgentScopes, OutsideAuditEntry, PhoneAction, Home, Insights, JobKind, ProviderId, ReplyDraft, ReviewDecision, RunOptions, RunRecord, Thread } from "../../../src/types";

export type { PersonSummary } from "../../../src/types";
export type { WorkPerson, WorkPersonView, WorkStatus, WorkTask, WorkUpdate } from "../../../src/types";
export type { AiHub, Build, BuildBranch, OutsideAgent, OutsideAgentScopes, OutsideAuditEntry, PhoneAction, JobKind, ProviderId, ToolInfo, ToolState } from "../../../src/types";
export type { AlertAction, Attention, BrainAlert, DayTask, Decision, Home, HomeBuild, Insights, PendingApproval, QuietChat, ReplyDraft, RunEvent, RunOptions, RunRecord, Running, StepRecord, Thread } from "../../../src/types";

/** Where the hub is and how to get in. Kept in Android's encrypted storage. */
export interface Connection {
  url: string;
  token: string;
}

let current: Connection | null = null;

// ---- backup hubs. Every device runs the same server, so when the hub you chose (the Linux machine)
// stops answering, e.g. in a power cut, the app moves to the next one that answers (the laptop) and goes
// back once yours answers again. The others are found from the hub's /api/nodes; yours is always first.
let hubs: string[] = [];
const hubListeners = new Set<(url: string) => void>();
let watching: ReturnType<typeof setInterval> | undefined;

/** The hubs this phone can use, the one you chose first. */
export const hubList = () => hubs;
/** The hub you chose (Settings → Change hub); `connection().url` is the one in use right now. */
export const primaryHub = () => hubs[0];
/** Called with the new hub's address whenever the app moves to another hub. */
export function onHubChange(f: (url: string) => void): () => void {
  hubListeners.add(f);
  return () => hubListeners.delete(f);
}

const clean = (u: string) => u.trim().replace(/\/+$/, "");

async function answers(url: string, timeoutMs = 4000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return (await fetch(`${url}/api/health`, { headers: authHeaders(), signal: ctrl.signal })).ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function useHub(url: string) {
  if (!current || current.url === url) return;
  current = { ...current, url };
  WaReply.configure(url, current.token);
  hubListeners.forEach((f) => f(url));
}

let switching: Promise<boolean> | null = null;
/** Moves to the first other hub that answers, yours first. True when the app changed hub. */
export function failover(): Promise<boolean> {
  switching ??= (async () => {
    try {
      for (const url of hubs) {
        if (url !== current?.url && (await answers(url))) {
          useHub(url);
          return true;
        }
      }
      return false;
    } finally {
      switching = null;
    }
  })();
  return switching;
}

/** Every minute: back to your hub when it answers again, or away from one that stopped answering. Exported for tests. */
export async function checkHubs() {
  if (!current || hubs.length < 2) return;
  if (current.url !== hubs[0] && (await answers(hubs[0]))) useHub(hubs[0]);
  else if (!(await answers(current.url))) await failover();
}

/** The other devices that run the server, from your hub, kept for when it is down. */
export async function refreshHubs(): Promise<string[]> {
  if (!current || current.url !== hubs[0]) return hubs;
  const { peers } = await api<{ peers: { url?: string; online?: boolean }[] }>("/api/nodes");
  const others = peers
    .filter((p) => p.url)
    .sort((a, b) => Number(!!b.online) - Number(!!a.online))
    .map((p) => clean(p.url!))
    .filter((u, i, all) => u !== hubs[0] && all.indexOf(u) === i);
  hubs = [hubs[0], ...others];
  await SecureStore.setItemAsync("orc.hubs", JSON.stringify(others));
  return hubs;
}

/** Gives every hub this phone's notification token, so whichever is up can reach you. Best effort. */
export async function registerPushEverywhere(fcmToken: string) {
  await SecureStore.setItemAsync("orc.fcm", fcmToken);
  await Promise.all(
    hubs.map((url) =>
      fetch(`${url}/api/push/fcm`, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify({ token: fcmToken }) }).catch(() => undefined),
    ),
  );
}

// A hub the app moves to gets the notification token too (it may never have had it).
onHubChange((url) => {
  void SecureStore.getItemAsync("orc.fcm").then((t) =>
    t ? fetch(`${url}/api/push/fcm`, { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders() }, body: JSON.stringify({ token: t }) }).catch(() => undefined) : undefined,
  );
});

export async function loadConnection(): Promise<Connection | null> {
  const url = await SecureStore.getItemAsync("orc.hub");
  const token = await SecureStore.getItemAsync("orc.token");
  current = url ? { url, token: token ?? "" } : null;
  if (current) {
    WaReply.configure(current.url, current.token);
    let others: string[] = [];
    try {
      others = JSON.parse((await SecureStore.getItemAsync("orc.hubs")) ?? "[]");
    } catch {}
    hubs = [current.url, ...others.filter((u) => u !== current!.url)];
    // In the background: is your hub up (else move now, not after a 20 s timeout), and who else is there.
    void (async () => {
      if (!(await answers(current!.url))) await failover();
      else await refreshHubs().catch(() => undefined);
    })();
    watching ??= setInterval(() => void checkHubs(), 60_000);
  }
  return current;
}

export async function saveConnection(c: Connection) {
  const url = clean(c.url);
  await SecureStore.setItemAsync("orc.hub", url);
  await SecureStore.setItemAsync("orc.token", c.token.trim());
  current = { url, token: c.token.trim() };
  hubs = [url, ...hubs.slice(1).filter((u) => u !== url)];
  WaReply.configure(url, current.token);
}

export function connection(): Connection | null {
  return current;
}

export class Unauthorized extends Error {}

export function authHeaders(): Record<string, string> {
  return current?.token ? { Authorization: `Bearer ${current.token}` } : {};
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}, retried = false): Promise<T> {
  if (!current) throw new Error("Not connected to a hub yet.");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 20_000);
  let res: Response;
  try {
    res = await fetch(`${current.url}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    // The hub did not answer at all (not an error it sent): try the same request on a backup hub once.
    if (!retried && hubs.length > 1 && (await failover())) return api<T>(path, init, true);
    if ((e as Error).name === "AbortError") throw new Error(`The hub at ${current.url} did not answer. Is Tailscale on and the hub running?`);
    // Only the request itself failed here ("Network request failed", "fetch failed: java.net.ConnectException…"):
    // usually Tailscale on this phone is off or stuck on "Starting…" (HyperOS stops it), or the hub is restarting.
    throw new Error(`Can't reach the hub at ${current.url}. Check Tailscale on this phone is connected; if it is, the hub may be restarting: pull down to try again.`);
  }
  if (res.status === 401) {
    clearTimeout(timer);
    throw new Unauthorized("The hub rejected the access token.");
  }
  const data = await res.json().catch(() => ({}));
  clearTimeout(timer);
  // The hub says {error}; the brain (FastAPI, through /api/brain) says {detail}.
  if (!res.ok) throw new Error((data as { error?: string; detail?: unknown }).error ?? String((data as { detail?: unknown }).detail ?? `HTTP ${res.status}`));
  return data as T;
}

export interface NodeInfo {
  name: string;
  providers: { id: string; ready: boolean; load: number; coolingDownUntil?: number; detail?: string }[];
  branchWork?: boolean;
  online?: boolean;
  via?: string;
  platform?: string;
  actions?: boolean;
  /** A peer's address on the tailnet (the hub itself has none). */
  url?: string;
}

export interface Agent {
  name: string;
  description: string;
  kind: string;
}

export type ActiveRun = Pick<RunRecord, "id" | "threadId" | "task" | "status" | "createdAt">;

/** A task as the brain keeps it (all of them, not just today's). */
export interface BrainTask {
  id: number;
  kind: "task" | "event" | "question";
  status: "watching" | "pending_confirmation" | "open" | "done" | "rejected";
  title: string;
  details?: string | null;
  due_at?: string | null;
  priority: string;
  people?: string | null;
  source_chat?: string | null;
  source_text?: string | null;
  source?: string;
}

export interface WaChat {
  id: number;
  name: string;
  is_group: boolean;
  muted: boolean;
  messages: number;
}

export interface MemoryRecord {
  uid: string;
  kind: string;
  title: string;
  body: string;
  device?: string;
  updated_at?: string;
  data?: Record<string, unknown>;
}

export interface AssistantReply {
  answer: string;
  steps: { tool: string; args: Record<string, unknown>; result: string }[];
  pending: { device: string; action: string; status: string }[];
  /** The learning harness's record of this answer: 👍 / 👎 go to it. */
  episode_id?: number;
  /** What the assistant had learnt and used for this answer. */
  lessons?: { id: number; text: string }[];
}

export type LessonStatus = "proposed" | "trial" | "active" | "off";
export interface Lesson {
  id: number;
  kind: "preference" | "fact" | "skill" | "rule" | "voice";
  text: string;
  when: string;
  status: LessonStatus;
  confidence: number;
  uses: number;
  wins: number;
  losses: number;
  note: string;
}
export interface LearnRun {
  id: number;
  at: string;
  kind: "reflect" | "evaluate";
  ok: boolean;
  passed: number;
  total: number;
  summary: Record<string, unknown>;
}
export interface LearnStatus {
  enabled: boolean;
  lessons: Record<LessonStatus, number>;
  episodes: number;
  good: number;
  bad: number;
  waiting: number;
  cases: number;
  last_eval?: { at: string; passed: number; total: number } | null;
  runs: LearnRun[];
}

/** The newest APK of this app the hub built (Settings → Update this app). */
export type AppUpdate =
  | { available: false; app: string }
  | { available: true; app: string; build: string; spec: string; status: string; branch?: string; builtAt: number; apk: string; size: number };

/** The hub's address, for links the phone opens itself (preview pages, APK downloads). */
export const hubUrl = () => current?.url;

/** A spoken exchange: what the hub heard, the full answer for the screen, and `say` to speak. */
export interface TalkReply extends AssistantReply {
  heard: string;
  say: string;
}

const q = (o: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== "") as [string, string][]).toString();

export const Api = {
  // ---- the assistant (the brain's thinking loop), tasks, memory, WhatsApp chats
  /** `history`: the last few turns, oldest first, so a follow-up like "open it" makes sense. */
  ask: (text: string, history: { role: "user" | "assistant"; content: string }[] = []) =>
    api<AssistantReply>("/api/assistant/ask", { body: { text, source: "app", history }, timeoutMs: 900_000 }),
  /** Words you said (recognised on the phone) to the thinking loop as a voice request: short spoken answers. */
  talk: (text: string, history: { role: "user" | "assistant"; content: string }[] = []) =>
    api<TalkReply>("/api/assistant/voice", { body: { text, history }, timeoutMs: 900_000 }),
  /** A recorded clip instead, for phones without speech recognition; the hub transcribes it (needs its Groq key). */
  async talkClip(uri: string, history: { role: "user" | "assistant"; content: string }[] = []): Promise<TalkReply> {
    if (!current) throw new Error("Not connected to a hub yet.");
    const form = new FormData();
    const name = uri.split("/").pop() || "talk.m4a";
    form.append("audio", { uri, name, type: name.endsWith(".3gp") ? "audio/3gpp" : "audio/mp4" } as never);
    form.append("history", JSON.stringify(history));
    const res = await fetch(`${current.url}/api/assistant/voice`, { method: "POST", headers: authHeaders(), body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    return data as TalkReply;
  },
  // ---- the learning harness (the brain's learn.py)
  feedback: (episodeId: number, good: boolean, note = "") =>
    api<{ id: number; outcome: string }>(`/api/brain/learn/episodes/${episodeId}/feedback`, { body: { good, note } }),
  learnStatus: () => api<LearnStatus>("/api/brain/learn/status"),
  lessons: () => api<Lesson[]>("/api/brain/learn/lessons"),
  addLesson: (text: string, kind: Lesson["kind"] = "preference", when = "") => api<Lesson>("/api/brain/learn/lessons", { body: { text, kind, when } }),
  setLesson: (id: number, status: "active" | "off" | "trial") => api<Lesson>(`/api/brain/learn/lessons/${id}`, { method: "PATCH", body: { status } }),
  learnNow: () => api<Record<string, unknown>>("/api/brain/learn/run", { body: {}, timeoutMs: 3_600_000 }),
  brainTasks: (status?: BrainTask["status"]) => api<BrainTask[]>(`/api/brain/tasks?${q({ status, limit: 200 })}`),
  /** keep (confirm), drop (reject) or done; keep also reopens a finished one. */
  taskAction: (id: number, action: "confirm" | "reject" | "done") => api<BrainTask>(`/api/brain/tasks/${id}/${action}`, { body: {} }),
  addTask: (title: string, due_at?: string) => api<BrainTask>("/api/brain/tasks", { body: { title, due_at } }),
  waChats: () => api<WaChat[]>("/api/brain/chats?limit=200"),
  /** The people in the WhatsApp style book: cards and counts, no messages. */
  people: () => api<{ builtAt: number | null; people: PersonSummary[] }>("/api/style/people"),
  // ---- Work: people you give tasks to, followed through WhatsApp
  work: () => api<{ people: WorkPersonView[] }>("/api/work"),
  workContacts: (q: string) => api<{ chatId: string; name: string; phone?: string }[]>(`/api/work/contacts?q=${encodeURIComponent(q)}`),
  addWorkPerson: (p: { name: string; chatId?: string; role?: string }) => api<WorkPerson>("/api/work/people", { body: p }),
  workPerson: (id: string) =>
    api<{ person: WorkPerson; tasks: (WorkTask & { overdue: boolean })[]; chat: { ts: number; fromMe: boolean; text: string; media?: string }[] }>(`/api/work/people/${id}`),
  addWorkTask: (t: { personId: string; title: string; details?: string; due?: string }) => api<WorkTask>("/api/work/tasks", { body: t }),
  updateWorkTask: (id: string, p: { status?: WorkStatus; note?: string; due?: string | null; title?: string }) => api<WorkTask>(`/api/work/tasks/${id}`, { method: "PATCH", body: p }),
  workMessage: (id: string) => api<{ text: string; phone?: string }>(`/api/work/tasks/${id}/message`),
  muteChat: (id: number, muted: boolean) => api(`/api/brain/chats/${id}/mute`, { body: { muted } }),
  briefNow: () => api("/api/brain/brief", { body: {}, timeoutMs: 120_000 }),
  modelUsage: () => api<{ report: string }>("/api/brain/llm/usage"),
  graph: () => api<{ entities: Record<string, number>; relations: number; owner?: string; owner_summary?: string }>("/api/brain/graph"),
  memorySearch: (query: string, kind?: string) => api<MemoryRecord[]>(`/api/shared-memory/search?${q({ q: query, kind, limit: 30 })}`),
  memoryRecent: () => api<MemoryRecord[]>("/api/shared-memory/recent?limit=20"),
  memoryAbout: (name: string) =>
    api<{ record: MemoryRecord; relations: { title: string }[]; linked: MemoryRecord[] }>(`/api/shared-memory/about?${q({ name })}`),
  remember: (text: string, kind: "note" | "fact" | "decision" = "note") => api<MemoryRecord>("/api/shared-memory/remember", { body: { text, kind } }),
  memoryStatus: () => api<{ ok: boolean; records: number; pending: number; lastSync?: number; lastError?: string }>("/api/shared-memory/status"),

  home: () => api<Home>("/api/home"),
  insights: (days = 7) => api<Insights>(`/api/insights?days=${days}`),
  assistant: () => api<{ configured: boolean; ok: boolean; lastSync?: number; lastError?: string; today?: number }>("/api/assistant"),
  gmail: () => api<{ configured: boolean; connected: boolean; email?: string; lastCheck?: number; lastError?: string; lastAdded?: number }>("/api/gmail"),
  gmailCheck: () => api<{ scanned: number; added: number }>("/api/gmail/check", { body: {}, timeoutMs: 600_000 }),
  /** Writes a fresh draft for a chat; `ask` is what you want to say. */
  /** Hides a chat that went quiet until it moves again. */
  letGo: (chatId: string) => api(`/api/whatsapp/quiet/${encodeURIComponent(chatId)}/let-go`, { body: {} }),
  redraft: (chatId: string, ask?: string) => api<ReplyDraft | { skipped: true }>("/api/whatsapp/drafts", { body: { chatId, ask }, timeoutMs: 180_000 }),
  closeDraft: (id: string, status: "sent" | "dismissed") => api(`/api/whatsapp/drafts/${encodeURIComponent(id)}/${status}`, { body: {} }),
  taskDone: (id: string, done: boolean) => api(`/api/tasks/${encodeURIComponent(id)}/done`, { body: { done } }),
  /** Your answer to a brain alert: done, snooze (back in an hour) or dismiss (not important). */
  ackAlert: (id: number, action: "done" | "snooze" | "dismiss") => api(`/api/alerts/${id}/ack`, { body: { action } }),
  /** Lets the assistant do one action it asked for (it runs right away), or refuses it. */
  decideApproval: (id: string, approve: boolean) =>
    api<{ status: string; result?: { ok: boolean; output: string } }>(`/api/approvals/${id}/${approve ? "approve" : "deny"}`, { body: {}, timeoutMs: 600_000 }),
  health: () => api<{ ok: boolean; node: string }>("/api/health", { timeoutMs: 8000 }),
  threads: () => api<Thread[]>("/api/threads"),
  thread: (id: string) => api<{ thread: Thread; runs: RunRecord[] }>(`/api/threads/${id}`),
  newThread: () => api<Thread>("/api/threads", { body: {} }),
  deleteThread: (id: string) => api(`/api/threads/${id}`, { method: "DELETE" }),
  send: (threadId: string, text: string, options: RunOptions) => api<RunRecord>(`/api/threads/${threadId}/messages`, { body: { text, ...options } }),
  active: () => api<ActiveRun[]>("/api/active"),
  run: (id: string) => api<RunRecord>(`/api/runs/${id}`),
  cancel: (id: string) => api(`/api/runs/${id}/cancel`, { body: {} }),
  answer: (run: string, step: string, answer: string) => api(`/api/runs/${run}/steps/${step}/answer`, { body: { answer } }),
  review: (run: string, step: string, d: ReviewDecision) => api(`/api/runs/${run}/steps/${step}/review`, { body: d }),
  edit: (run: string, step: string, output: string) => api(`/api/runs/${run}/steps/${step}/edit`, { body: { output } }),
  stop: (run: string, step: string) => api(`/api/runs/${run}/steps/${step}/stop`, { body: {} }),
  rate: (run: string, step: string, rating: 1 | -1) => api(`/api/runs/${run}/steps/${step}/rate`, { body: { rating } }),
  merge: (run: string, step: string) => api(`/api/runs/${run}/steps/${step}/merge`, { body: {}, timeoutMs: 120_000 }),
  approve: (run: string, notes: string) => api(`/api/runs/${run}/approve`, { body: { notes } }),
  revise: (run: string, feedback: string) => api(`/api/runs/${run}/revise`, { body: { feedback } }),
  nodes: (refresh = false) => api<{ self: NodeInfo; peers: NodeInfo[] }>(refresh ? "/api/nodes/refresh" : "/api/nodes", refresh ? { body: {} } : {}),
  agents: () => api<Agent[]>("/api/agents"),
  usage: () => api<{ day: string; provider: string; node: string; calls: number; failed: number }[]>("/api/usage?days=7"),
  // ---- devices (phase 3): their files, and actions run on them
  fileNodes: () => api<{ node: string; files: number; roots: string[]; indexedAt: number; truncated: boolean }[]>("/api/files/nodes"),
  findFiles: (text: string, node?: string) => api<{ node: string; path: string; name: string; size: number; mtime: number }[]>(`/api/files/search?${q({ q: text, node, limit: 40 })}`),
  /** Runs an action on a device; risky ones come back `pending` and wait for Approve on Home. */
  act: (node: string, action: string, args: Record<string, unknown> = {}, reason?: string) =>
    api<{ status: "done" | "pending" | "refused"; result?: { ok: boolean; output: string }; error?: string }>("/api/act", { body: { node, action, args, reason }, timeoutMs: 120_000 }),
  // ---- outside agents (paid agents with their own tokens, over MCP at /mcp)
  outsideAgents: () => api<{ agents: OutsideAgent[]; paused: boolean }>("/api/outside-agents"),
  /** The token comes back once; it is never shown again. */
  addOutsideAgent: (name: string, scopes: OutsideAgentScopes) => api<{ agent: OutsideAgent; token: string }>("/api/outside-agents", { body: { name, scopes } }),
  revokeOutsideAgent: (id: string) => api<OutsideAgent>(`/api/outside-agents/${id}/revoke`, { body: {} }),
  /** The kill switch for every outside agent at once. */
  pauseOutsideAgents: (paused: boolean) => api<{ paused: boolean }>("/api/outside-agents/paused", { method: "PUT", body: { paused } }),
  outsideAudit: (agent?: string) => api<OutsideAuditEntry[]>(`/api/outside-agents/audit?${q({ agent, limit: 60 })}`),
  // ---- the phone's to-do from the assistant (alarms, reminders, apps, files; calls and texts drafted)
  phoneActions: () => api<PhoneAction[]>("/api/phone/actions"),
  phoneDone: (id: string) => api(`/api/phone/actions/${id}/done`, { body: {} }),
  phoneDismiss: (id: string) => api(`/api/phone/actions/${id}/dismiss`, { body: {} }),
  // ---- builds (apps built on command)
  builds: () => api<Build[]>("/api/builds?limit=40"),
  appUpdate: () => api<AppUpdate>("/api/app/update"),
  build: (id: string) => api<Build>(`/api/builds/${id}`),
  startBuild: (b: { name: string; spec: string; repo?: string; agent?: "claude" | "codex"; continue?: boolean }) => api<Build>("/api/builds", { body: b }),
  /** Your tap: merges the build's branches into the branch checked out in its folder. */
  mergeBuild: (id: string) => api<Build>(`/api/builds/${id}/merge`, { body: {}, timeoutMs: 180_000 }),
  previewBuild: (id: string) => api(`/api/builds/${id}/preview`, { body: {} }),
  cancelBuild: (id: string) => api<Build>(`/api/builds/${id}/cancel`, { body: {} }),
  /** Full address of a preview link (/p/<key>/...); it carries its own key, so a browser can open it. */
  hubUrl: (path: string) => `${current?.url ?? ""}${path}`,
  /** The AI hub: every AI tool's state and use, what each job would use now, caps, the week. */
  aiHub: (fresh = false) => api<AiHub>(`/api/ai-hub${fresh ? "?fresh=1" : ""}`, { timeoutMs: 30_000 }),
  /** The tool to try first for a job; "auto" gives the choice back to the router. */
  preferAi: (job: JobKind, provider: ProviderId | "auto") => api("/api/ai-hub/prefer", { method: "PUT", body: { job, provider } }),
  fcmStatus: () => api<{ enabled: boolean }>("/api/push/fcm"),
  registerFcm: (token: string) => api("/api/push/fcm", { body: { token } }),
  pushTest: () => api<{ sent: number }>("/api/push/test", { body: {} }),
};

/** One exchange on a call (src/calls/desk.ts TurnResult). */
export interface CallTurn {
  transcript: string;
  say: string;
  action: "done" | "snooze" | "dismiss" | "draft_reply" | "delegate" | "none";
  done: boolean;
  runId?: string;
  refused?: string;
  proposed?: "draft_reply" | "delegate";
}

export interface CallInfo {
  alert: BrainAlert;
  /** The hub can hear voice (it has a Groq key); otherwise type. */
  voice: boolean;
  /** Some model can take the call at all. */
  available: boolean;
  lines: { who: "assistant" | "owner"; text: string; at: number }[];
  ended: boolean;
}

/** A call's answer the hub refused because it can't hear voice: the app switches to typing. */
export class NeedsText extends Error {}

export const Calls = {
  info: (alertId: number) => api<CallInfo>(`/api/calls/${alertId}`),
  answer: (alertId: number) => api<{ say: string; voice: boolean }>(`/api/calls/${alertId}/answer`, { body: {}, timeoutMs: 45_000 }),
  say: (alertId: number, text: string) => api<CallTurn>(`/api/calls/${alertId}/turn`, { body: { text }, timeoutMs: 90_000 }),
  end: (alertId: number) => api(`/api/calls/${alertId}/end`, { body: {} }),
  /** Sends a recorded clip (a file uri from expo-audio) as multipart; React Native reads the file itself. */
  async voice(alertId: number, uri: string): Promise<CallTurn> {
    if (!current) throw new Error("Not connected to a hub yet.");
    const form = new FormData();
    const name = uri.split("/").pop() || "turn.m4a";
    form.append("audio", { uri, name, type: name.endsWith(".3gp") ? "audio/3gpp" : "audio/mp4" } as never);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    try {
      const res = await fetch(`${current.url}/api/calls/${alertId}/turn`, { method: "POST", headers: authHeaders(), body: form, signal: ctrl.signal });
      if (res.status === 401) throw new Unauthorized("The hub rejected the access token.");
      const data = (await res.json().catch(() => ({}))) as CallTurn & { error?: string; fallback?: string };
      if (res.status === 409 && data.fallback === "text") throw new NeedsText(data.error ?? "Type your answer instead.");
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      return data;
    } catch (e) {
      if ((e as Error).name === "AbortError") throw new Error("The hub took too long to answer.");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  },
};

export const FINISHED = ["done", "failed", "cancelled"];
