import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { describePhoneAction, PhoneDesk } from "../src/phone/desk.js";
import type { PushPayload } from "../src/server/push.js";
import { mountPhone } from "../src/server/phone.js";
import { Store } from "../src/store/db.js";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "orc-phone-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, "work");
  mkdirSync(root);
  writeFileSync(join(root, "boarding pass.pdf"), "PDF");
  writeFileSync(join(root, ".env"), "KEY=1");
  const config = parseConfig({ dataDir: join(dir, "data"), actions: { roots: [root] } });
  const store = new Store(join(dir, "data"));
  cleanup.unshift(() => store.close());
  const pushes: PushPayload[] = [];
  let now = Date.UTC(2026, 9, 30, 8);
  const phone = new PhoneDesk(store, config, (p) => pushes.push(p), () => now);
  const app = new Hono();
  mountPhone(app, { phone });
  return { root, phone, pushes, app, tick: (ms: number) => (now += ms) };
}

const post = (app: Hono, path: string, body?: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

describe("phone actions (D3)", () => {
  it("say what will happen; calls and texts only open, never dial or send", () => {
    expect(describePhoneAction({ kind: "alarm", hour: 6, minute: 5, label: "flight" })).toBe("Set an alarm for 06:05 (flight)");
    expect(describePhoneAction({ kind: "call", number: "+91 98400 12345", name: "Amma" })).toBe("Call Amma (opens the dialer; you press call)");
    expect(describePhoneAction({ kind: "sms", number: "+919840012345", text: "Running late" })).toContain("(opens the message; you press send)");
  });

  it("wait for the owner's tap, ping the phone, and expire after a day", async () => {
    const s = setup();
    const res = await post(s.app, "/api/phone/actions", { kind: "alarm", hour: 6, minute: 30, reason: "early flight" });
    const a = await res.json();
    expect(a).toMatchObject({ status: "pending", summary: "Set an alarm for 06:30", reason: "early flight" });
    expect(s.pushes[0]).toMatchObject({ title: "On your phone?", body: "Set an alarm for 06:30", url: "/phone" });
    expect((await (await s.app.request("/api/phone/actions?status=pending")).json()).map((x: any) => x.id)).toEqual([a.id]);
    expect(await (await post(s.app, `/api/phone/actions/${a.id}/done`)).json()).toMatchObject({ status: "done" });
    const b = s.phone.add({ kind: "reminder", at: "2026-10-30T18:00", text: "call the bank" });
    s.tick(25 * 3_600_000);
    expect(s.phone.get(b.id)?.status).toBe("expired");
    expect((await post(s.app, "/api/phone/actions", { kind: "reminder", at: "tomorrow-ish", text: "x" })).status).toBe(400);
    expect((await post(s.app, "/api/phone/actions", { kind: "call", number: "*#06#" })).status).toBe(400);
    expect((await post(s.app, "/api/phone/actions", { kind: "teleport" })).status).toBe(400);
  });

  it("a file is downloadable by key while it waits, and never a secret", async () => {
    const s = setup();
    const a = s.phone.add({ kind: "file", path: "boarding pass.pdf" });
    expect(a.fileKey).toMatch(/^[0-9a-f]{32}$/);
    const res = await s.app.request(`/f/${a.fileKey}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="boarding pass.pdf"');
    expect(await res.text()).toBe("PDF");
    expect((await s.app.request("/f/nope")).status).toBe(404);
    s.phone.close(a.id, "dismissed");
    expect((await s.app.request(`/f/${a.fileKey}`)).status).toBe(404);
    expect((await post(s.app, "/api/phone/actions", { kind: "file", path: ".env" })).status).toBe(400);
    expect((await post(s.app, "/api/phone/actions", { kind: "file", path: "/etc/passwd" })).status).toBe(400);
  });
});
