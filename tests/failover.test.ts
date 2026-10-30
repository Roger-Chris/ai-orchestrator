import { beforeEach, describe, expect, it, vi } from "vitest";

// The phone app's own connection code (mobile/src/lib/api.ts), with the phone's storage and the
// native WhatsApp module replaced: a power cut on the Linux hub, simulated with two fake hubs.
const stored = new Map<string, string>();
// the app resolves it from mobile/node_modules, so the mock must name that copy
vi.mock("../mobile/node_modules/expo-secure-store", () => ({
  getItemAsync: async (k: string) => stored.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => void stored.set(k, v),
}));
const configured: string[] = [];
vi.mock("../mobile/src/lib/wareply", () => ({ WaReply: { configure: (url: string) => void configured.push(url) } }));

const LINUX = "http://100.104.185.17:4317";
const LAPTOP = "http://100.79.112.101:4317";
const up = { [LINUX]: true, [LAPTOP]: true } as Record<string, boolean>;
const calls: { url: string; auth?: string; body?: string }[] = [];

beforeEach(() => {
  stored.clear();
  configured.length = calls.length = 0;
  up[LINUX] = up[LAPTOP] = true;
  stored.set("orc.hub", LINUX);
  stored.set("orc.token", "t");
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const base = `${url.protocol}//${url.host}`;
    calls.push({ url: input, auth: (init.headers as Record<string, string>)?.Authorization, body: init.body as string | undefined });
    if (!up[base]) throw new TypeError("Network request failed"); // what React Native says for an unreachable host
    if (url.pathname === "/api/nodes") return Response.json({ self: { name: "roger-all-series" }, peers: [{ name: "omen", url: `${LAPTOP}/`, online: true }] });
    return Response.json({ from: base, path: url.pathname });
  });
});

/** A fresh copy of the module per test (it keeps the connection in module state). */
async function app() {
  vi.resetModules();
  const m = await import("../mobile/src/lib/api");
  await m.loadConnection();
  await vi.waitFor(() => expect(m.hubList().length).toBe(2)); // the backup is found from /api/nodes
  return m;
}

describe("the app when the Linux hub goes down (simulated power cut)", () => {
  it("finds the laptop as a backup and remembers it", async () => {
    const m = await app();
    expect(m.hubList()).toEqual([LINUX, LAPTOP]);
    expect(JSON.parse(stored.get("orc.hubs")!)).toEqual([LAPTOP]);
  });

  it("moves a request to the laptop when the hub does not answer, then goes back when it does", async () => {
    const m = await app();
    const changes: string[] = [];
    m.onHubChange((u) => changes.push(u));

    up[LINUX] = false;
    expect(await m.api<{ from: string }>("/api/home")).toMatchObject({ from: LAPTOP });
    expect(m.connection()?.url).toBe(LAPTOP);
    expect(m.primaryHub()).toBe(LINUX); // your choice is kept
    expect(configured.at(-1)).toBe(LAPTOP); // WhatsApp reply-from-notification follows

    await m.checkHubs(); // the minute check: Linux still down, stay
    expect(m.connection()?.url).toBe(LAPTOP);

    up[LINUX] = true;
    await m.checkHubs();
    expect(m.connection()?.url).toBe(LINUX);
    expect(changes).toEqual([LAPTOP, LINUX]);
    expect(calls.every((c) => c.auth === "Bearer t")).toBe(true);
  });

  it("re-registers notifications with the hub it moves to, and registers with every hub when turned on", async () => {
    const m = await app();
    await m.registerPushEverywhere("fcm-1");
    const registered = () => calls.filter((c) => c.url.endsWith("/api/push/fcm")).map((c) => new URL(c.url).host);
    expect(registered().sort()).toEqual(["100.104.185.17:4317", "100.79.112.101:4317"]);

    calls.length = 0;
    up[LINUX] = false;
    await m.api("/api/home");
    await vi.waitFor(() => expect(registered()).toEqual(["100.79.112.101:4317"]));
    expect(JSON.parse(calls.find((c) => c.url.endsWith("/api/push/fcm"))!.body!)).toEqual({ token: "fcm-1" });
  });

  it("says Tailscale may be off when no hub answers, and does not move on an error the hub sent", async () => {
    const m = await app();
    up[LINUX] = up[LAPTOP] = false;
    await expect(m.api("/api/home")).rejects.toThrow(/Check Tailscale on this phone/);
    expect(m.connection()?.url).toBe(LINUX);

    up[LINUX] = true;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 }));
    await expect(m.api("/api/home")).rejects.toThrow("boom");
    expect(m.connection()?.url).toBe(LINUX);
  });
});
