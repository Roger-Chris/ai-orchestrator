import type { Context } from "hono";
import { z } from "zod";
import type { ModelRouter } from "../ai/route.js";
import type { ToolRegistry } from "../ai/tools.js";
import type { Store } from "../store/db.js";
import { type AiHub, JOB_KINDS, type JobKind, PROVIDER_IDS, type ProviderId } from "../types.js";

/**
 * The AI hub (Jarvis phase 1, R4): one answer for the app's AI hub screen. Every tool with its live
 * state and use today, what each of the hub's jobs would use right now, the caps and how close they
 * are, and the last week's calls and spend. The owner can pick a tool to go first for a job; that
 * pick is kept in the hub's `prefs` table (`route.<job>`) and the router still falls back from it.
 */

export const JOB_LABEL: Record<JobKind, string> = {
  whatsapp_draft: "WhatsApp replies",
  mail: "Reading Gmail",
  call: "Answering on a call",
  brain: "The assistant's thinking",
  work: "Following your people's tasks",
};

const prefKey = (job: JobKind) => `route.${job}`;

export function preferredFor(store: Store) {
  return (job: JobKind) => store.getPref<ProviderId>(prefKey(job));
}

interface UsageRow {
  day: string;
  provider: string;
  calls: number;
  failed: number;
  cost_usd?: number;
}

export async function buildAiHub(d: { tools: ToolRegistry; models: ModelRouter; store: Store }, fresh = false): Promise<AiHub> {
  const tools = await d.tools.list(fresh);
  const preferred = preferredFor(d.store);
  const jobs = await Promise.all(
    JOB_KINDS.map(async (kind) => ({ kind, label: JOB_LABEL[kind], route: await d.models.routeFor(kind, "medium"), preferred: preferred(kind) })),
  );
  const today = tools.reduce((t, x) => ({ calls: t.calls + x.usageToday.calls, failed: t.failed + x.usageToday.failed, spentUsd: t.spentUsd + x.usageToday.spentUsd }), { calls: 0, failed: 0, spentUsd: 0 });
  today.spentUsd = Math.round(today.spentUsd * 100) / 100;
  const caps = tools
    .filter((t) => t.limits.perDay || t.limits.spendPerDay)
    .map((t) => ({ id: t.id, name: t.name, perDay: t.limits.perDay, spendPerDay: t.limits.spendPerDay, calls: t.usageToday.calls, spentUsd: t.usageToday.spentUsd, reached: t.state === "limit" ? t.detail : undefined }));
  const byDay = new Map<string, { day: string; calls: number; failed: number; spentUsd: number }>();
  for (const r of d.store.usage(7) as unknown as UsageRow[]) {
    const w = byDay.get(r.day) ?? { day: r.day, calls: 0, failed: 0, spentUsd: 0 };
    w.calls += r.calls;
    w.failed += r.failed;
    w.spentUsd = Math.round((w.spentUsd + (r.cost_usd ?? 0)) * 100) / 100;
    byDay.set(r.day, w);
  }
  const week = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
  return { tools, jobs, today, caps, week };
}

const PreferBody = z.object({ job: z.enum(JOB_KINDS), provider: z.union([z.literal("auto"), z.enum(PROVIDER_IDS as [ProviderId, ...ProviderId[]])]) });

/** PUT /api/ai-hub/prefer {job, provider | "auto"}: the tool to try first for that job ("auto": the router's order). */
export async function setPreferred(c: Context, store: Store) {
  const body = PreferBody.parse(await c.req.json());
  store.setPref(prefKey(body.job), body.provider === "auto" ? undefined : body.provider);
  return body;
}
