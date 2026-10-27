import type { ReviewDecision, RunEvent, RunOptions, RunRecord, Thread } from "../../src/types";

export type { RunEvent, RunOptions, RunRecord, StepRecord, Thread } from "../../src/types";

const TOKEN_KEY = "orc.token";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(t: string) {
  try {
    localStorage.setItem(TOKEN_KEY, t.trim());
  } catch {
    /* storage blocked: the token lasts until reload */
  }
}

export class Unauthorized extends Error {}

function headers(json = true): Record<string, string> {
  const h: Record<string, string> = json ? { "Content-Type": "application/json" } : {};
  const t = getToken();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: headers(),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 401) throw new Unauthorized("This device needs your access token.");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}

/**
 * Streams a run's events (stored ones first, then live). Uses fetch rather than
 * EventSource so the token travels in a header, never in the URL.
 */
export function streamRun(runId: string, onEvent: (ev: RunEvent) => void): () => void {
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch(`/api/runs/${runId}/events`, { headers: headers(false), signal: ctrl.signal });
      if (!res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("");
          if (!data || data === "{}") continue;
          try {
            onEvent(JSON.parse(data));
          } catch {
            /* ignore a malformed frame */
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") console.error(e);
    }
  })();
  return () => ctrl.abort();
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
  prefer: string[];
}

export const Api = {
  threads: () => api<Thread[]>("/api/threads"),
  active: () => api<Pick<RunRecord, "id" | "threadId" | "task" | "status" | "createdAt">[]>("/api/active"),
  thread: (id: string) => api<{ thread: Thread; runs: RunRecord[] }>(`/api/threads/${id}`),
  newThread: () => api<Thread>("/api/threads", { body: {} }),
  renameThread: (id: string, title: string) => api(`/api/threads/${id}`, { method: "PATCH", body: { title } }),
  deleteThread: (id: string) => api(`/api/threads/${id}`, { method: "DELETE" }),
  send: (threadId: string, text: string, options: RunOptions) => api<RunRecord>(`/api/threads/${threadId}/messages`, { body: { text, ...options } }),
  run: (id: string) => api<RunRecord>(`/api/runs/${id}`),
  cancel: (id: string) => api(`/api/runs/${id}/cancel`, { body: {} }),
  answer: (run: string, step: string, answer: string) => api(`/api/runs/${run}/steps/${step}/answer`, { body: { answer } }),
  review: (run: string, step: string, d: ReviewDecision) => api(`/api/runs/${run}/steps/${step}/review`, { body: d }),
  edit: (run: string, step: string, output: string) => api(`/api/runs/${run}/steps/${step}/edit`, { body: { output } }),
  stop: (run: string, step: string) => api(`/api/runs/${run}/steps/${step}/stop`, { body: {} }),
  rate: (run: string, step: string, rating: 1 | -1) => api(`/api/runs/${run}/steps/${step}/rate`, { body: { rating } }),
  merge: (run: string, step: string) => api(`/api/runs/${run}/steps/${step}/merge`, { body: {} }),
  approve: (run: string, notes: string) => api(`/api/runs/${run}/approve`, { body: { notes } }),
  revise: (run: string, feedback: string) => api(`/api/runs/${run}/revise`, { body: { feedback } }),
  nodes: (refresh = false) => api<{ self: NodeInfo; peers: NodeInfo[] }>(refresh ? "/api/nodes/refresh" : "/api/nodes", refresh ? { body: {} } : {}),
  agents: () => api<Agent[]>("/api/agents"),
  usage: () => api<{ day: string; provider: string; node: string; calls: number; ok: number; failed: number; duration_ms: number }[]>("/api/usage?days=7"),
  pushKey: () => api<{ publicKey: string }>("/api/push/key"),
  pushSubscribe: (sub: PushSubscriptionJSON) => api("/api/push/subscribe", { body: sub }),
  pushUnsubscribe: (endpoint: string) => api("/api/push/unsubscribe", { body: { endpoint } }),
  pushTest: () => api<{ sent: number }>("/api/push/test", { body: {} }),
};

export const LABEL: Record<string, string> = { claude: "Claude", codex: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity" };

export const FINISHED = ["done", "failed", "cancelled"];
