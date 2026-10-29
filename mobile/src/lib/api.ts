import * as SecureStore from "expo-secure-store";
import { WaReply } from "./wareply";
import type { BrainAlert, Home, Insights, ReplyDraft, ReviewDecision, RunOptions, RunRecord, Thread } from "../../../src/types";

export type { AlertAction, Attention, BrainAlert, DayTask, Decision, Home, Insights, PendingApproval, QuietChat, ReplyDraft, RunEvent, RunOptions, RunRecord, Running, StepRecord, Thread } from "../../../src/types";

/** Where the hub is and how to get in. Kept in Android's encrypted storage. */
export interface Connection {
  url: string;
  token: string;
}

let current: Connection | null = null;

export async function loadConnection(): Promise<Connection | null> {
  const url = await SecureStore.getItemAsync("orc.hub");
  const token = await SecureStore.getItemAsync("orc.token");
  current = url ? { url, token: token ?? "" } : null;
  if (current) WaReply.configure(current.url, current.token);
  return current;
}

export async function saveConnection(c: Connection) {
  const url = c.url.trim().replace(/\/+$/, "");
  await SecureStore.setItemAsync("orc.hub", url);
  await SecureStore.setItemAsync("orc.token", c.token.trim());
  current = { url, token: c.token.trim() };
  WaReply.configure(url, current.token);
}

export function connection(): Connection | null {
  return current;
}

export class Unauthorized extends Error {}

export function authHeaders(): Record<string, string> {
  return current?.token ? { Authorization: `Bearer ${current.token}` } : {};
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<T> {
  if (!current) throw new Error("Not connected to a hub yet.");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 20_000);
  try {
    const res = await fetch(`${current.url}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctrl.signal,
    });
    if (res.status === 401) throw new Unauthorized("The hub rejected the access token.");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    return data as T;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw new Error(`The hub at ${current.url} did not answer. Is Tailscale on and the hub running?`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export interface NodeInfo {
  name: string;
  providers: { id: string; ready: boolean; load: number; coolingDownUntil?: number; detail?: string }[];
  branchWork?: boolean;
  online?: boolean;
  via?: string;
}

export interface Agent {
  name: string;
  description: string;
  kind: string;
}

export type ActiveRun = Pick<RunRecord, "id" | "threadId" | "task" | "status" | "createdAt">;

export const Api = {
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
