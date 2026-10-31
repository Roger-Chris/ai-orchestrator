import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { ManusProvider } from "../src/providers/manus.js";

/** A fake Manus API v2: task.create, then task.listMessages returns the events given for each poll. */
function fakeManus(polls: object[][]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let poll = 0;
  const http = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/v2/task.create")) return Response.json({ ok: true, task_id: "T1", task_url: "https://manus.im/app/T1" });
    if (url.includes("/v2/task.listMessages")) return Response.json({ ok: true, task_id: "T1", messages: [...polls[Math.min(poll++, polls.length - 1)]].reverse() });
    return Response.json({ ok: false, error: { code: "not_found", message: "no" } }, { status: 404 });
  }) as typeof fetch;
  return { http, calls };
}
const cfg = (over: Record<string, unknown> = {}) => parseConfig({ providers: { manus: { apiKey: "mk", pollSeconds: 1, ...over } } }).providers.manus;
const status = (id: string, agent_status: string, extra: object = {}) => ({ id, type: "status_update", timestamp: 1, status_update: { agent_status, ...extra } });
const said = (id: string, content: string, delivery_kind?: string, attachments: object[] = []) => ({ id, type: "assistant_message", timestamp: 1, assistant_message: { content, delivery_kind, attachments } });

describe("Manus", () => {
  it("creates a task, follows it until it stops and answers with its result and files", async () => {
    const { http, calls } = fakeManus([
      [status("e1", "running"), said("e2", "Looking at flights", "progress")],
      [status("e1", "running"), said("e2", "Looking at flights", "progress"), status("e3", "stopped"), said("e4", "Cheapest: 6E 2134 at ₹4,120", "result", [{ type: "file", filename: "flights.csv", url: "https://files/f.csv" }])],
    ]);
    const deltas: string[] = [];
    const r = await new ManusProvider(cfg(), http, async () => {}).run({ prompt: "Find the cheapest flight to Delhi on Friday", system: "Be brief", onDelta: (d) => void deltas.push(d) });
    expect(r).toMatchObject({ ok: true, provider: "manus", model: "standard" });
    expect(r.text).toBe("Cheapest: 6E 2134 at ₹4,120\n\nFiles:\nflights.csv: https://files/f.csv\n\nManus task: https://manus.im/app/T1");
    expect(deltas).toEqual(["Looking at flights\n"]);
    const create = calls[0];
    expect(create.url).toBe("https://api.manus.ai/v2/task.create");
    expect((create.init!.headers as Record<string, string>)["x-manus-api-key"]).toBe("mk");
    expect(JSON.parse(String(create.init!.body))).toMatchObject({ agent_profile: "standard", interactive_mode: false, message: { content: expect.stringContaining("Find the cheapest flight") } });
    expect(calls[1].url).toContain("task.listMessages?task_id=T1");
  });

  it("never confirms anything for you: a task waiting on you comes back with its link", async () => {
    const { http, calls } = fakeManus([[status("e1", "waiting", { status_detail: { waiting_description: "Send this email to the landlord?", waiting_for_event_type: "gmailSendAction" } })]]);
    const r = await new ManusProvider(cfg(), http, async () => {}).run({ prompt: "email my landlord" });
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toBe("Manus is waiting for you: Send this email to the landlord?. Answer or confirm it in the Manus app: https://manus.im/app/T1");
    expect(calls.some((c) => c.url.includes("confirmAction"))).toBe(false);
  });

  it("says what is missing without a key, and passes Manus errors on", async () => {
    expect((await new ManusProvider(cfg({ apiKey: undefined })).detect()).authenticated).toBe(false);
    expect((await new ManusProvider(cfg({ apiKey: undefined })).run({ prompt: "x" })).error).toMatch(/MANUS_API_KEY/);
    const failing = (async () => Response.json({ ok: false, error: { code: "insufficient_credits", message: "Not enough credits" } }, { status: 402 })) as unknown as typeof fetch;
    expect((await new ManusProvider(cfg(), failing).run({ prompt: "x" })).error).toBe("Manus 402: Not enough credits");
  });

  /** Each key answers task.create with its own status; 200 starts a task that stops at the first poll. */
  function keyed(statuses: Record<string, number>) {
    const used: { key: string; path: string }[] = [];
    const http = (async (url: string, init?: RequestInit) => {
      const key = (init!.headers as Record<string, string>)["x-manus-api-key"];
      used.push({ key, path: url.includes("task.create") ? "create" : "poll" });
      if (url.includes("task.listMessages")) return Response.json({ ok: true, messages: [said("e2", "done", "result"), status("e1", "stopped")] });
      const code = statuses[key] ?? 200;
      if (code !== 200) return Response.json({ ok: false, error: { message: "nope" } }, { status: code });
      return Response.json({ ok: true, task_id: `T-${key}` });
    }) as typeof fetch;
    return { http, used };
  }

  it("moves past a key with no credits or a rejection, and follows the task on the key that made it", async () => {
    const { http, used } = keyed({ a: 402, b: 401 });
    const p = new ManusProvider(cfg({ apiKey: undefined, apiKeys: ["a", "b", "c"] }), http, async () => {});
    expect((await p.detect()).detail).toBe("3 keys in rotation");
    expect((await p.run({ prompt: "x" })).ok).toBe(true);
    expect(used).toEqual([{ key: "a", path: "create" }, { key: "b", path: "create" }, { key: "c", path: "create" }, { key: "c", path: "poll" }]);
    used.length = 0;
    expect((await p.run({ prompt: "y" })).ok).toBe(true);
    expect(used.every((u) => u.key === "c")).toBe(true); // a and b are resting
  });

  it("shares tasks between good keys, and tells the pool when every key is resting", async () => {
    const good = keyed({});
    const shared = new ManusProvider(cfg({ apiKey: undefined, apiKeys: ["a", "b"] }), good.http, async () => {});
    await shared.run({ prompt: "1" });
    await shared.run({ prompt: "2" });
    expect(good.used.filter((u) => u.path === "create").map((u) => u.key)).toEqual(["a", "b"]);

    const out = new ManusProvider(cfg({ apiKey: undefined, apiKeys: ["a", "b"] }), keyed({ a: 402, b: 429 }).http, async () => {});
    const r = await out.run({ prompt: "x" });
    expect(r).toMatchObject({ ok: false, rateLimited: true });
    expect(r.retryAt).toBeGreaterThan(Date.now());
  });

  it("doesn't burn through keys on a problem with the request", async () => {
    const { http, used } = keyed({ a: 400 });
    const r = await new ManusProvider(cfg({ apiKey: undefined, apiKeys: ["a", "b"] }), http, async () => {}).run({ prompt: "x" });
    expect(r.error).toBe("Manus 400: nope");
    expect(used).toEqual([{ key: "a", path: "create" }]);
  });
});
