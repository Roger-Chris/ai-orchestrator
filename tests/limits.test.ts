import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ToolRegistry } from "../src/ai/tools.js";
import { claudeLimits } from "../src/providers/claude.js";
import { codexLimits } from "../src/providers/codex.js";
import { headerLimits } from "../src/providers/openai-compat.js";
import { buildModelLimits } from "../src/server/ai-hub.js";
import { payloadFor } from "../src/server/push.js";
import { Store } from "../src/store/db.js";
import type { RunRecord } from "../src/types.js";

const dirs: string[] = [];
const stores: Store[] = [];
afterAll(() => {
  stores.forEach((s) => s.close());
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "orc-limits-"));
  dirs.push(d);
  return d;
};

describe("what each service says is left", () => {
  it("reads Claude Code's rate_limit_event", () => {
    const info = { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.02, resetsAt: 1793467200 }, seven_day: { utilization: 0.73, resetsAt: 1793530800 } } };
    expect(claudeLimits(info)).toEqual([
      { label: "5 hours", usedPercent: 2, resetsAt: 1793467200000 },
      { label: "7 days", usedPercent: 73, resetsAt: 1793530800000 },
    ]);
    expect(claudeLimits({ status: "allowed" })).toBeUndefined();
  });

  it("reads the newest Codex session file, only if this run wrote it", () => {
    const home = tmp();
    const day = join(home, "sessions", "2026", "10", "31");
    mkdirSync(day, { recursive: true });
    const file = join(day, "rollout.jsonl");
    const line = { type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 7, window_minutes: 43200, resets_at: 1795630028 }, secondary: null } } };
    writeFileSync(file, `{"type":"other"}\n${JSON.stringify(line)}\n{"type":"last"}\n`);
    expect(codexLimits(0, home)).toEqual([{ label: "30 days", usedPercent: 7, resetsAt: 1795630028000 }]);
    utimesSync(file, new Date(1000), new Date(1000));
    expect(codexLimits(Date.now(), home)).toBeUndefined();
    expect(codexLimits(0, join(home, "nothing-here"))).toBeUndefined();
  });

  it("reads Groq's rate-limit headers", () => {
    const h = new Headers({ "x-ratelimit-limit-tokens": "1000", "x-ratelimit-remaining-tokens": "250", "x-ratelimit-reset-tokens": "1m30s", "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "100" });
    expect(headerLimits(h, 1000)).toEqual([
      { label: "tokens", usedPercent: 75, resetsAt: 91_000 },
      { label: "requests", usedPercent: 0, resetsAt: undefined },
    ]);
    expect(headerLimits(new Headers())).toBeUndefined();
  });
});

describe("token use", () => {
  const tool = (id: string, extra = {}) => ({ id, name: id, kind: "agent", cost: "subscription", limits: {}, state: "ready", usageToday: { calls: 0, failed: 0, avgMs: 0, spentUsd: 0 }, ...extra });

  it("counts tokens per model, keeps the last limits, and treats a passed reset as empty", async () => {
    const store = new Store(tmp());
    stores.push(store);
    const now = Date.now();
    store.recordUsage("claude", "hub", true, 10, { inputTokens: 100, outputTokens: 20, limits: [{ label: "5 hours", usedPercent: 40, resetsAt: now + 60_000 }, { label: "7 days", usedPercent: 90, resetsAt: now - 1 }] });
    store.recordUsage("claude", "mac", true, 10, { inputTokens: 5, outputTokens: 1 });
    store.recordUsage("gemini", "hub", true, 10, undefined);
    store.recordUsage("gemini", "hub", false, 10, 0.5);
    const tools = { list: async () => [tool("claude"), tool("gemini", { state: "cooling", until: now + 5000 }), tool("tts:openai", { kind: "speech" })] } as unknown as ToolRegistry;

    const got = await buildModelLimits({ tools, store }, false, now);

    expect(got.models.map((m) => m.id)).toEqual(["claude", "gemini"]);
    const [claude, gemini] = got.models;
    expect(claude.today).toEqual({ in: 105, out: 21, calls: 2 });
    expect(claude.windows).toEqual([{ label: "5 hours", usedPercent: 40, resetsAt: now + 60_000 }, { label: "7 days", usedPercent: 0, resetsAt: undefined }]);
    expect(claude.windowsAt).toBeGreaterThan(0);
    expect(gemini).toMatchObject({ state: "cooling", windows: [], today: { in: 0, out: 0, calls: 2 } });
    expect(got.today).toEqual({ in: 105, out: 21 });
    expect(got.days).toHaveLength(1);
  });

  it("adds the token columns to a database made before them", () => {
    const dir = tmp();
    const first = new Store(dir);
    first.db.exec("ALTER TABLE usage DROP COLUMN tokens_in; ALTER TABLE usage DROP COLUMN tokens_out");
    first.close();
    const store = new Store(dir);
    stores.push(store);
    store.recordUsage("claude", "hub", true, 10, { inputTokens: 7, outputTokens: 2 });
    expect(store.usage(1)).toMatchObject([{ tokens_in: 7, tokens_out: 2 }]);
  });
});

describe("notices", () => {
  it("a build's design notice opens the Builds screen", () => {
    const run = { id: "r1", task: "x", options: { buildId: "b1" }, status: "awaiting_approval", steps: [], createdAt: 0 } as RunRecord;
    expect(payloadFor(run, undefined, "design.review_ready")?.url).toBe("/builds?id=b1");
  });
});
