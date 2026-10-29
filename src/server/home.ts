import type { ActionHub } from "../actions/desk.js";
import type { Cluster } from "../cluster/cluster.js";
import type { Orchestrator } from "../brain/orchestrator.js";
import type { ProviderPool } from "../providers/registry.js";
import type { AssistantTasks } from "../integrations/assistant.js";
import type { GmailReader } from "../integrations/gmail.js";
import type { Store } from "../store/db.js";
import type { ReplyDrafter } from "../whatsapp/drafter.js";
import { quietChats } from "../whatsapp/convo.js";
import type { StyleBook } from "../whatsapp/learn.js";

/** A chat's name: its WhatsApp name, else the style book's, else the number. */
function chatNamer(store: Store, book?: StyleBook) {
  const q = store.db.prepare("SELECT name FROM wa_chats WHERE id = ?");
  return (id: string) => {
    const name = (q.get(id) as { name?: string } | undefined)?.name;
    return [name, book?.contacts.find((c) => c.chatId === id)?.name].find((n) => n && !n.startsWith("+")) ?? `+${id.split("@")[0]}`;
  };
}
import type { Attention, Decision, Home, Insights, ProviderId, Running } from "../types.js";

export const PROVIDER_NAME: Record<ProviderId, string> = { claude: "Claude", codex: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", groq: "Groq" };

/** Local date as YYYY-MM-DD (the hub's time zone, which is yours). */
export const localDay = (t = new Date()) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;

const short = (s: string, n = 90) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export async function buildHome(d: {
  store: Store;
  orchestrator: Orchestrator;
  pool: ProviderPool;
  cluster: Cluster;
  gmail?: GmailReader;
  assistant?: AssistantTasks;
  drafter?: ReplyDrafter;
  actions?: ActionHub;
}): Promise<Home> {
  const decisions: Decision[] = [];
  const running: Running[] = [];
  for (const a of d.orchestrator.active()) {
    const run = d.orchestrator.get(a.id);
    if (!run) continue;
    if (run.status === "awaiting_approval") {
      decisions.push({ kind: "design", runId: run.id, threadId: run.threadId, from: "Design review", text: short(run.task), since: run.createdAt });
    }
    for (const s of run.steps) {
      if (s.status === "waiting" && s.question) {
        decisions.push({ kind: "question", runId: run.id, threadId: run.threadId, stepId: s.id, from: s.agent ?? s.title, text: s.question, since: s.startedAt ?? run.createdAt });
      } else if (s.status === "review") {
        decisions.push({ kind: "checkpoint", runId: run.id, threadId: run.threadId, stepId: s.id, from: s.title, text: `Step finished: ${short(s.title, 60)}. Continue?`, since: s.finishedAt ?? run.createdAt });
      }
    }
    if (["queued", "planning", "running"].includes(run.status)) {
      const current = run.steps.find((s) => s.status === "running");
      running.push({
        runId: run.id,
        threadId: run.threadId,
        task: short(run.task, 70),
        stepsDone: run.steps.filter((s) => s.status === "done" || s.status === "skipped").length,
        stepsTotal: run.steps.length,
        now: run.status !== "running" ? (run.status === "planning" ? "Planning" : "Queued") : current && [current.provider && PROVIDER_NAME[current.provider], current.title].filter(Boolean).join(" · "),
      });
    }
  }
  decisions.sort((a, b) => a.since - b.since);

  const attention: Attention[] = [];
  const lastDay = d.store.runsSince(Date.now() - 86_400_000, 200);
  for (const r of lastDay.filter((r) => r.status === "failed").slice(0, 3)) {
    attention.push({ level: "error", title: `Failed: ${short(r.task, 50)}`, detail: short(r.error ?? "no error message", 80), runId: r.id, threadId: r.threadId, task: r.task });
  }
  // Signed out only matters for a model you were using; an optional one you never set up is not news.
  // Only use on this device counts: history copied from another machine says nothing about logins here.
  const usedThisWeek = new Set((d.store.usage(7) as { provider: string; node: string }[]).filter((u) => u.node === d.cluster.name).map((u) => u.provider));
  for (const p of await d.pool.status()) {
    if (p.coolingDownUntil) attention.push({ level: "warn", title: `${PROVIDER_NAME[p.id]} hit its limit`, detail: `Back at ${clock(p.coolingDownUntil)}; other models take its work until then` });
    else if (p.installed && !p.authenticated && usedThisWeek.has(p.id)) attention.push({ level: "warn", title: `${PROVIDER_NAME[p.id]} is signed out`, detail: p.detail ?? "Sign in again on the hub" });
  }
  const mail = d.gmail?.status();
  if (mail?.connected && mail.lastError) attention.push({ level: "warn", title: "Gmail check failed", detail: mail.lastError });
  const brain = d.assistant?.status();
  if (brain?.lastSync && !brain.ok) attention.push({ level: "warn", title: "Can't reach the brain", detail: brain.lastError ?? "Today's tasks may be out of date" });
  const peers = d.cluster.list();
  for (const p of peers.filter((p) => !p.online)) {
    attention.push({ level: "warn", title: `${p.name} is offline`, detail: p.lastSeen ? `Last seen ${clock(p.lastSeen)}` : "Not reachable over Tailscale" });
  }

  const day = localDay();
  return {
    node: d.cluster.name,
    devices: 1 + peers.filter((p) => p.online).length,
    day,
    tasks: d.store.tasksFor(day),
    alerts: d.assistant?.alerts() ?? [],
    // The brain reads Gmail; WhatsApp only when its bridge runs, which the hub cannot see.
    sources: { gmail: !!mail?.connected || !!brain?.ok, whatsapp: !!d.drafter?.book() },
    decisions,
    running,
    attention,
    recent: d.store
      .runsSince(0, 10)
      .filter((r) => r.finishedAt)
      .slice(0, 3)
      .map((r) => ({ runId: r.id, threadId: r.threadId, task: short(r.task, 60), status: r.status, at: r.finishedAt! })),
    replies: d.drafter?.drafts(10) ?? [],
    quiet: d.drafter ? quietChats(d.store.db, chatNamer(d.store, d.drafter.book())) : [],
    approvals: (d.actions?.desk.list("pending") ?? []).map((a) => ({
      id: a.id, node: a.node, action: a.action, summary: a.summary, reason: a.reason, since: a.createdAt, expiresAt: a.expiresAt,
    })),
  };
}

export function buildInsights(store: Store, days = 7): Insights {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const runs = store.runsSince(start.getTime(), 5000);

  const byDay = new Map<string, { day: string; runs: number; done: number; failed: number }>();
  for (let i = 0; i < days; i++) {
    const t = new Date(start);
    t.setDate(start.getDate() + i);
    byDay.set(localDay(t), { day: localDay(t), runs: 0, done: 0, failed: 0 });
  }
  for (const r of runs) {
    const row = byDay.get(localDay(new Date(r.createdAt)));
    if (!row) continue;
    row.runs++;
    if (r.status === "done") row.done++;
    if (r.status === "failed") row.failed++;
  }

  const took = runs
    .filter((r) => r.status === "done" && r.finishedAt)
    .map((r) => r.finishedAt! - r.createdAt)
    .sort((a, b) => a - b);

  const providers = new Map<string, { provider: string; calls: number; failed: number; ms: number }>();
  for (const u of store.usage(days) as { provider: string; calls: number; failed: number; duration_ms: number }[]) {
    const p = providers.get(u.provider) ?? { provider: u.provider, calls: 0, failed: 0, ms: 0 };
    p.calls += Number(u.calls);
    p.failed += Number(u.failed);
    p.ms += Number(u.duration_ms);
    providers.set(u.provider, p);
  }

  return {
    days: [...byDay.values()],
    runs: runs.length,
    done: runs.filter((r) => r.status === "done").length,
    failed: runs.filter((r) => r.status === "failed").length,
    medianMs: took.length ? took[Math.floor(took.length / 2)] : undefined,
    providers: [...providers.values()]
      .sort((a, b) => b.calls - a.calls)
      .map((p) => ({ provider: p.provider, calls: p.calls, failed: p.failed, avgMs: p.calls ? Math.round(p.ms / p.calls) : 0 })),
  };
}
