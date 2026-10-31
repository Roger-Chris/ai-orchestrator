import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ActionLog } from "../src/actions/log.js";
import { rawMessage } from "../src/integrations/gmail.js";
import { MailDesk, parseMail } from "../src/mail/desk.js";
import { scopeProblem } from "../src/outside/mcp.js";
import { GUARD_SCRIPT, ORDER_WORDS, parseCart, SECRET_FIELD } from "../src/shop/agent.js";
import { ShopDesk } from "../src/shop/desk.js";
import { Store } from "../src/store/db.js";

const newStore = () => new Store(join(mkdtempSync(join(tmpdir(), "orc-mail-")), "t.db"));
const WRITTEN = '{"subject":"Monday","body":"Can we move it to Monday?"}';

describe("mail", () => {
  let store: Store;
  let sent: { to: string; subject: string; body: string }[];
  let log: ActionLog;
  let desk: MailDesk;
  let fail: string | undefined;
  beforeEach(() => {
    store = newStore();
    sent = [];
    fail = undefined;
    log = new ActionLog(store);
    desk = new MailDesk({
      store,
      log,
      node: "hub",
      think: async () => WRITTEN,
      gmail: {
        recentSent: async () => [],
        send: async (m) => {
          if (fail) throw new Error(fail);
          sent.push(m);
          return "g1";
        },
      },
    });
  });

  it("a draft sends nothing, and Send sends the edited words once and logs it", async () => {
    const m = await desk.draft({ to: "a@b.co", about: "move the meeting", by: "brain" });
    expect(sent).toEqual([]);
    expect(m.status).toBe("draft");
    const done = await desk.send(m.id, { to: "c@d.co", subject: "Edited", body: "My words" });
    expect(done.status).toBe("sent");
    expect(sent).toEqual([{ to: "c@d.co", subject: "Edited", body: "My words" }]);
    await expect(desk.send(m.id, { to: "c@d.co", subject: "Edited", body: "My words" })).rejects.toThrow(/already/);
    expect(sent.length).toBe(1);
    const entry = log.list().find((e) => e.action === "mail.send")!;
    expect(entry).toMatchObject({ who: "owner", status: "done" });
    expect(entry.args).toContain("c@d.co");
    expect(entry.args).not.toContain("My words");
  });

  it("two taps at once send once", async () => {
    const m = await desk.draft({ to: "a@b.co", about: "x y" });
    const edit = { to: "a@b.co", subject: "s", body: "b" };
    const r = await Promise.allSettled([desk.send(m.id, edit), desk.send(m.id, edit)]);
    expect(r.filter((x) => x.status === "fulfilled").length).toBe(1);
    expect(sent.length).toBe(1);
  });

  it("a failed send is logged and can be tried again", async () => {
    const m = await desk.draft({ to: "a@b.co", about: "x y" });
    fail = "Gmail 500";
    const edit = { to: "a@b.co", subject: "s", body: "b" };
    expect(await desk.send(m.id, edit)).toMatchObject({ status: "failed", error: "Gmail 500" });
    expect(log.list().find((e) => e.action === "mail.send")).toMatchObject({ status: "failed" });
    fail = undefined;
    expect((await desk.send(m.id, edit)).status).toBe("sent");
  });

  it("a name leaves the address for the owner, and a bad address never reaches Gmail", async () => {
    const m = await desk.draft({ to: "Varun", about: "x y" });
    expect(m.to).toBe("");
    for (const to of ["", "Varun", "a@b.co, evil@x.co", "a@b.co\r\nBcc: evil@x.co"]) await expect(desk.send(m.id, { to, subject: "s", body: "b" })).rejects.toThrow(/email address/);
    expect(sent).toEqual([]);
  });

  it("the raw message can't gain headers and carries UTF-8", () => {
    expect(() => rawMessage({ to: "a@b.co", subject: "x\r\nBcc: evil@x.co", body: "b" })).toThrow(/line break/);
    const text = Buffer.from(rawMessage({ to: "a@b.co", subject: "நன்றி", body: "₹5" }), "base64url").toString();
    expect(text).toContain("To: a@b.co");
    expect(text).toContain("=?UTF-8?B?");
    expect(text).toContain(Buffer.from("₹5").toString("base64"));
  });

  it("an unreadable answer is not a draft", () => {
    expect(parseMail("sorry")).toBeUndefined();
    expect(parseMail(`Here: ${WRITTEN}`)?.subject).toBe("Monday");
  });
});

describe("the cart agent's answer and walls", () => {
  it("ready needs items and a total; anything else is not believed", () => {
    expect(parseCart('{"status":"ready","items":[{"name":"Pen","qty":2,"price":"₹95"}],"total":"₹95"}')).toMatchObject({ status: "ready", total: "₹95" });
    expect(parseCart('{"status":"ready","items":[],"total":"₹95"}')).toBeUndefined();
    expect(parseCart('{"status":"ready","items":[{"name":"Pen"}],"total":"unknown"}')).toBeUndefined();
    expect(parseCart('{"status":"ordered","items":[]}')).toBeUndefined();
    expect(parseCart("no json")).toBeUndefined();
    expect(parseCart('{"status":"needs_you","items":[],"note":"sign in"}')).toMatchObject({ status: "needs_you", note: "sign in" });
  });

  it("order and pay controls match, adding to a cart does not", () => {
    for (const t of ["Buy Now", "Place your order", "Place Order", "Proceed to Buy", "Proceed to Pay", "Click to Pay", "Pay now", "Checkout", "Check out", "/checkout/start"]) expect(ORDER_WORDS.test(t), t).toBe(true);
    for (const t of ["Add to Cart", "Go to Cart", "Search", "Add", "Pen, set of 10", "Payback points"]) expect(ORDER_WORDS.test(t), t).toBe(false);
    for (const t of ["password", "ap_password", "enter otp", "cardNumber", "cc-number", "cvv", "upi id"]) expect(SECRET_FIELD.test(t), t).toBe(true);
    expect(SECRET_FIELD.test("twotabsearchtextbox")).toBe(false);
    expect(() => new Function(GUARD_SCRIPT)).not.toThrow();
  });

  it("outside agents can't drive the owner's store accounts", () => {
    const agent = { scopes: { devices: ["*"], folders: [], risk: "ask", memoryWrite: false } } as any;
    expect(scopeProblem(agent, "omen", "shop.cart", {})).toMatch(/owner/);
  });
});

describe("shopping", () => {
  const cart = (data: unknown, ok = true) => async () => ({ status: "done", node: "omen", action: "shop.cart", result: { ok, output: "x", data } }) as any;
  const make = (act: any, linkOnly: string[] = []) => {
    const store = newStore();
    const log = new ActionLog(store);
    const notes: any[] = [];
    return { desk: new ShopDesk({ store, act, log, node: "omen", logNode: "hub", linkOnly, notify: (p) => notes.push(p) }), log, notes, store };
  };
  const READY = { status: "ready", items: [{ name: "Pen", qty: 1, price: "₹95" }], total: "₹95" };

  it("stops at the cart and tells the phone the items and total", async () => {
    const { desk, notes } = make(cart(READY));
    const { run, done } = desk.start({ store: "flipkart", request: "a pen", by: "brain" });
    expect(run.status).toBe("working");
    expect(await done).toMatchObject({ status: "ready", total: "₹95" });
    expect(notes[0].title).toContain("₹95");
    expect(notes[0].url).toBe(`/shop?id=${run.id}`);
  });

  it("checkout needs the total on the screen, opens the store only, and every tap is logged", async () => {
    const { desk, log } = make(cart(READY));
    const { run, done } = desk.start({ store: "flipkart", request: "a pen" });
    await done;
    expect(() => desk.checkout(run.id, "₹90")).toThrow(/total changed/);
    expect(() => desk.checkout(run.id, "")).toThrow(/total changed/);
    expect(desk.checkout(run.id, "₹95").status).toBe("checkout");
    expect(log.list().filter((e) => e.action === "shop.checkout")).toHaveLength(1);
    expect(desk.close(run.id, "ordered").status).toBe("ordered");
    expect(() => desk.checkout(run.id, "₹95")).toThrow(/not ready/);
  });

  it("a cart that is not ready can't go to checkout", async () => {
    const { desk } = make(cart({ status: "needs_you", items: [], note: "sign in" }));
    const { run, done } = desk.start({ store: "blinkit", request: "milk" });
    expect((await done).status).toBe("needs_you");
    expect(() => desk.checkout(run.id, "")).toThrow(/not ready/);
  });

  it("link-only stores never start the agent", async () => {
    let called = false;
    const { desk } = make(async () => ((called = true), {}), ["amazon"]);
    const r = await desk.start({ store: "Amazon.in", request: "a pen" }).done;
    expect(r.status).toBe("link");
    expect(r.searchUrl).toBe("https://www.amazon.in/s?k=a%20pen");
    expect(called).toBe(false);
  });

  it("an offline device or a crash says so, and agents run one at a time", async () => {
    const off = make(async () => ({ status: "refused", node: "omen", action: "shop.cart", error: "device omen is offline" }));
    expect(await off.desk.start({ store: "zepto", request: "milk" }).done).toMatchObject({ status: "failed", note: "device omen is offline" });
    let running = 0;
    let most = 0;
    const q = make(async () => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { status: "done", node: "omen", action: "shop.cart", result: { ok: true, output: "", data: READY } };
    });
    await Promise.all([q.desk.start({ store: "zepto", request: "milk" }).done, q.desk.start({ store: "zepto", request: "eggs" }).done]);
    expect(most).toBe(1);
  });

  it("refuses a store it doesn't know, and a restart doesn't leave a cart spinning", async () => {
    const { desk, store } = make(async () => new Promise(() => undefined));
    expect(() => desk.start({ store: "ebay", request: "a pen" })).toThrow(/don't shop/);
    const { run } = desk.start({ store: "zepto", request: "milk" });
    const again = new ShopDesk({ store, act: (async () => ({})) as any, logNode: "hub", linkOnly: [] });
    expect(again.get(run.id)).toMatchObject({ status: "failed" });
  });
});
