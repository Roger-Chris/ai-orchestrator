import type { Cluster } from "../cluster/cluster.js";
import { tailnetDevices } from "../cluster/tailscale.js";
import type { ProviderPool } from "../providers/registry.js";
import { PROVIDER_NAME, localDay } from "../server/home.js";
import type { Store } from "../store/db.js";
import type { ProviderId, RunRecord } from "../types.js";

/**
 * A short, live briefing about the owner and their setup, given to every agent as system
 * instructions. Without it a question like "which devices are online?" gets a generic
 * how-to; with it the agent answers from the facts the hub already has.
 */

export interface SetupSources {
  profile: { name?: string; about?: string };
  cluster: Cluster;
  pool: ProviderPool;
  store: Store;
  /** Runs still going (from the orchestrator), to say what is running or waiting. */
  active: () => Pick<RunRecord, "id" | "task" | "status">[];
  /** One line each about connected services (brain, Gmail, notifications…). */
  services: () => string[];
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const clock = (ts: number) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

let tailnetCache: { at: number; text: string[] } | undefined;

/** Phones and other tailnet devices that don't run the orchestrator, cached for a minute. */
async function otherDevices(known: Set<string>): Promise<string[]> {
  if (tailnetCache && Date.now() - tailnetCache.at < 60_000) return tailnetCache.text;
  const text = (await tailnetDevices())
    .filter((d) => !known.has(d.hostName.toLowerCase()))
    .map((d) => `- ${d.hostName}${d.os ? ` (${d.os})` : ""}: ${d.online ? "online" : "offline"} on Tailscale, not running the orchestrator`);
  tailnetCache = { at: Date.now(), text };
  return text;
}

export async function describeSetup(s: SetupSources, now = new Date()): Promise<string> {
  const who = s.profile.name ? `${s.profile.name}'s` : "the owner's";
  const lines: string[] = [
    `You are working inside ${who} personal AI Orchestrator: a hub that routes their requests to their own Claude, ChatGPT, Gemini and Groq subscriptions across their devices on a private Tailscale network. The facts below are live. When a question is about their setup, devices, models, tasks or what is running, answer from these facts, specifically, instead of giving general instructions. If something isn't covered here, say so plainly.`,
  ];
  if (s.profile.about) lines.push(`About ${s.profile.name ?? "them"}: ${s.profile.about}`);
  lines.push(`Now: ${now.toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} (hub's local time). This hub: ${s.cluster.name}.`);

  // Devices running the orchestrator, and what each can use right now.
  const self = await s.cluster.localInfo();
  const ready = (ps: { id: ProviderId; ready: boolean; coolingDownUntil?: number }[]) =>
    ps.map((p) => (p.ready ? PROVIDER_NAME[p.id] : p.coolingDownUntil ? `${PROVIDER_NAME[p.id]} (limit until ${clock(p.coolingDownUntil)})` : undefined)).filter(Boolean).join(", ") || "none";
  const devices = [`- ${self.name} (this hub): online; models ready: ${ready(self.providers)}${self.branchWork ? "; takes coding work on git branches" : ""}`];
  for (const p of s.cluster.list()) {
    devices.push(`- ${p.name}: ${p.online ? `online; models ready: ${ready(p.providers)}${p.branchWork ? "; takes coding work on git branches" : ""}` : `offline${p.lastSeen ? ` since ${clock(p.lastSeen)}` : ""}`}`);
  }
  devices.push(...(await otherDevices(new Set([self.name, ...s.cluster.list().map((p) => p.name)].map((n) => n.toLowerCase())))));
  lines.push(`Devices:\n${devices.join("\n")}`);

  const tasks = s.store.tasksFor(localDay(now));
  if (tasks.length) {
    lines.push(
      `Today's tasks (from their mail and messages):\n${tasks
        .slice(0, 12)
        .map((t) => `- ${t.done ? "[done] " : ""}${t.time ?? "today"}: ${short(t.title, 90)}${t.detail ? ` (${short(t.detail, 50)})` : ""}`)
        .join("\n")}`,
    );
  } else lines.push("Today's tasks: none due today.");

  const active = s.active();
  const waiting = active.filter((r) => r.status === "waiting" || r.status === "awaiting_approval");
  const running = active.filter((r) => !waiting.includes(r));
  if (waiting.length) lines.push(`Waiting on them: ${waiting.map((r) => `"${short(r.task, 60)}"`).join(", ")}.`);
  if (running.length > 1) lines.push(`Also running now: ${running.length - 1} other request(s).`);

  const services = s.services();
  if (services.length) lines.push(`Connected services:\n${services.map((x) => `- ${x}`).join("\n")}`);
  return lines.join("\n\n");
}
