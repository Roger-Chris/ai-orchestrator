import * as SecureStore from "expo-secure-store";
import type { Home, Insights, ReviewDecision, RunOptions, RunRecord, Thread } from "../../../src/types";

export type { Attention, DayTask, Decision, Home, Insights, RunEvent, RunOptions, RunRecord, Running, StepRecord, Thread } from "../../../src/types";

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
  return current;
}

export async function saveConnection(c: Connection) {
  const url = c.url.trim().replace(/\/+$/, "");
  await SecureStore.setItemAsync("orc.hub", url);
  await SecureStore.setItemAsync("orc.token", c.token.trim());
  current = { url, token: c.token.trim() };
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
  taskDone: (id: string, done: boolean) => api(`/api/tasks/${encodeURIComponent(id)}/done`, { body: { done } }),
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

export const FINISHED = ["done", "failed", "cancelled"];
