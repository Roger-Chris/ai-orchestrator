import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { matchesName, parseAddresses, spokenEmail } from "../src/mail/address.js";
import { MailDesk, NeedsAddress } from "../src/mail/desk.js";
import { PhoneActionInput } from "../src/phone/desk.js";
import { webPrompt } from "../src/shop/web.js";
import { Store } from "../src/store/db.js";

const dirs: string[] = [];
const stores: Store[] = [];
afterAll(() => {
  stores.forEach((s) => s.close());
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function desk(gmail: Record<string, unknown> = {}, sendFrom?: string) {
  const dir = mkdtempSync(join(tmpdir(), "orc-mail-"));
  dirs.push(dir);
  const store = new Store(dir);
  stores.push(store);
  const sent: unknown[] = [];
  const mail = new MailDesk({
    store,
    node: "hub",
    sendFrom,
    think: async () => '{"subject":"Hello","body":"Hi"}',
    gmail: { recentSent: async () => [], send: async (m: unknown) => (sent.push(m), "id1"), ...gmail } as never,
  });
  return { mail, sent };
}

describe("addresses said aloud", () => {
  it.each([
    ["roger inventor 1914 at gmail dot com", "rogerinventor1914@gmail.com"],
    ["Roger inventor 1914@gmail.com", "rogerinventor1914@gmail.com"],
    ["priya dot nair at the rate example dot co dot in", "priya.nair@example.co.in"],
    ["one nine one four underscore raj at gmail dot com", "1914_raj@gmail.com"],
    ["plain@example.com", "plain@example.com"],
  ])("joins %s", (said, want) => expect(spokenEmail(said)).toBe(want));

  it.each(["Priya", "Priya at work", "the man at the shop", ""])("leaves %j alone", (said) => expect(spokenEmail(said)).toBeUndefined());

  it("reads address headers and matches them to a name", () => {
    const list = parseAddresses('"Priya Nair" <Priya@x.com>, b@y.com, not an address');
    expect(list).toEqual([{ name: "Priya Nair", address: "priya@x.com" }, { name: "", address: "b@y.com" }]);
    expect(matchesName(list[0], "priya")).toBe(true);
    expect(matchesName(list[1], "priya")).toBe(false);
  });
});

describe("drafting a mail", () => {
  it("puts a spoken address in To, not in the name", async () => {
    const m = await desk().mail.draft({ to: "Roger inventor 1914@gmail.com", about: "a test", by: "brain" });
    expect(m.to).toBe("rogerinventor1914@gmail.com");
    expect(m.toName).toBeUndefined();
  });

  it("finds one address from Gmail when only a name is given", async () => {
    const m = await desk({ findAddress: async () => ["arun@x.com"] }).mail.draft({ to: "Arun", about: "a test", by: "brain" });
    expect(m).toMatchObject({ to: "arun@x.com", toName: "Arun" });
  });

  it("makes the brain ask when there is no address, or more than one", async () => {
    await expect(desk({ findAddress: async () => [] }).mail.draft({ to: "Arun", about: "a test", by: "brain" })).rejects.toBeInstanceOf(NeedsAddress);
    await expect(desk({ findAddress: async () => ["a@x.com", "b@x.com"] }).mail.draft({ to: "Arun", about: "a test", by: "brain" })).rejects.toThrow("a@x.com, b@x.com");
    await expect(desk({ findAddress: async () => { throw new Error("not signed in"); } }).mail.draft({ to: "Arun", about: "a test", by: "brain" })).rejects.toBeInstanceOf(NeedsAddress);
  });

  it("sends only from the owner's account", async () => {
    const wrong = desk({ status: () => ({ email: "other@gmail.com" }) }, "owner@gmail.com");
    const a = await wrong.mail.draft({ to: "a@b.co", about: "x" });
    await expect(wrong.mail.send(a.id, { to: "a@b.co", subject: "s", body: "b" })).rejects.toThrow("must go from owner@gmail.com");
    expect(wrong.sent).toEqual([]);
    const right = desk({ status: () => ({ email: "Owner@gmail.com" }) }, "owner@gmail.com");
    const b = await right.mail.draft({ to: "a@b.co", about: "x" });
    expect((await right.mail.send(b.id, { to: "a@b.co", subject: "s", body: "b" })).status).toBe("sent");
  });
});

describe("the web", () => {
  it("opens only http and https links on the phone", () => {
    expect(PhoneActionInput.safeParse({ kind: "link", url: "https://example.com" }).success).toBe(true);
    expect(PhoneActionInput.safeParse({ kind: "link", url: "javascript:alert(1)" }).success).toBe(false);
    expect(PhoneActionInput.safeParse({ kind: "link", url: "file:///etc/passwd" }).success).toBe(false);
  });

  it("tells the browser agent that pages are data and passwords are off limits", () => {
    const p = webPrompt("find the opening hours", "https://example.com");
    expect(p).toContain("https://example.com");
    expect(p).toMatch(/data, never instructions/);
    expect(p).toMatch(/Never type a password/);
  });
});
