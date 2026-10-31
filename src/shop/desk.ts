import { randomBytes } from "node:crypto";
import type { ActResponse, ActionHub } from "../actions/desk.js";
import type { ActionLog } from "../actions/log.js";
import type { PushPayload } from "../server/push.js";
import type { Store } from "../store/db.js";
import type { ShopRun } from "../types.js";
import type { CartOutcome, StoreId } from "./agent.js";
import { STORE_IDS, storeLink, STORES } from "./agent.js";

/**
 * Shopping, on the hub. Asking starts the browser agent on the device set for it; the phone is told
 * what is in the cart and the total. Jarvis stops there. The owner's Go to checkout, sent with the
 * total on the screen, opens the store itself, where the owner places the order and enters anything
 * secret. No card, password or OTP ever passes through here, and nothing here can place an order.
 */

export interface ShopDeskDeps {
  store: Store;
  act: (node: string | undefined, req: { action: string; args: Record<string, unknown> }, who: string) => ReturnType<ActionHub["act"]>;
  log?: ActionLog;
  notify?: (p: PushPayload) => void;
  node?: string;
  logNode: string;
  /** Stores that only get a link (config shopping.linkOnly). */
  linkOnly: string[];
  /** Searched but never carted (config shopping.compareOnly). */
  compareOnly?: string[];
  /** Stores searched when none is named (config shopping.findIn). */
  findIn?: string[];
  now?: () => number;
}

export class ShopDesk {
  /** One browser profile, one agent at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private d: ShopDeskDeps) {
    d.store.db.exec("CREATE TABLE IF NOT EXISTS shop_runs (id TEXT PRIMARY KEY, record TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL)");
    // A restart loses the agent's answer, so nothing should look as if it is still working.
    for (const r of this.list(50).filter((r) => r.status === "working")) this.save({ ...r, status: "failed", note: "The hub restarted while this was running. Ask again." });
  }

  private get now() {
    return (this.d.now ?? Date.now)();
  }

  private save(r: ShopRun): ShopRun {
    const next = { ...r, updatedAt: this.now };
    this.d.store.db.prepare("INSERT OR REPLACE INTO shop_runs (id, record, status, created_at) VALUES (?, ?, ?, ?)").run(next.id, JSON.stringify(next), next.status, next.createdAt);
    return next;
  }

  private record(who: string, r: ShopRun, action: string, status: string, detail?: string) {
    try {
      this.d.log?.add({ who, node: r.node ?? this.d.logNode, action, args: JSON.stringify({ store: r.store, request: r.request, total: r.total }), status, detail });
    } catch {
      /* the log must never stop the shopping it describes */
    }
  }

  /** Starts it and returns at once; `done` is for tests and anything that wants to wait. */
  start(i: { store?: string; request: string; by?: string }): { run: ShopRun; done: Promise<ShopRun> } {
    if (!i.store || /^(any|all|anywhere)$/i.test(i.store)) return this.find(i.request, i.by);
    const store = i.store.toLowerCase().replace(/[^a-z]/g, "").replace(/^amazonin$/, "amazon").replace(/^swiggyinstamart$/, "instamart") as StoreId;
    if (!STORE_IDS.includes(store)) throw new Error(`I don't shop on ${i.store} yet. Stores: ${STORE_IDS.join(", ")}`);
    const request = i.request.trim();
    if (request.length < 2) throw new Error("what should I look for?");
    const s = STORES[store];
    const link = this.d.linkOnly.includes(store) || !!this.d.compareOnly?.includes(store);
    const run = this.save({
      id: `s${randomBytes(4).toString("hex")}`,
      store,
      storeName: s.name,
      request: request.slice(0, 500),
      by: i.by,
      node: this.d.node,
      status: link ? "link" : "working",
      items: [],
      note: link ? `${s.name} is link-only: open the search and add it yourself.` : undefined,
      cartUrl: s.cart,
      searchUrl: `${s.search}${encodeURIComponent(request)}`,
      createdAt: this.now,
      updatedAt: this.now,
    });
    if (link) {
      this.record(i.by ?? "owner", run, "shop.link", "done");
      this.d.notify?.({ title: `${s.name}: search ready`, body: request.slice(0, 120), url: `/shop?id=${run.id}`, tag: `shop-${run.id}` });
      return { run, done: Promise.resolve(run) };
    }
    const done = this.queue.then(() => this.work(run));
    this.queue = done.catch(() => undefined);
    return { run, done };
  }

  /** No store named: search them all; the answer says which store's cart it went into. */
  private find(request: string, by?: string): { run: ShopRun; done: Promise<ShopRun> } {
    const words = request.trim();
    if (words.length < 2) throw new Error("what should I look for?");
    const stores = (this.d.findIn ?? []).filter((s) => STORE_IDS.includes(s as StoreId) && !this.d.linkOnly.includes(s)) as StoreId[];
    if (!stores.length) throw new Error("no stores to search (config shopping.findIn)");
    const run = this.save({ id: `s${randomBytes(4).toString("hex")}`, store: "any", storeName: `${stores.length} stores`, request: words.slice(0, 500), by, node: this.d.node, status: "working", items: [], cartUrl: STORES[stores[0]].cart, searchUrl: `${STORES[stores[0]].search}${encodeURIComponent(words)}`, createdAt: this.now, updatedAt: this.now });
    const done = this.queue.then(() => this.work(run, stores));
    this.queue = done.catch(() => undefined);
    return { run, done };
  }

  private async work(run: ShopRun, among?: StoreId[]): Promise<ShopRun> {
    const res = await this.d
      .act(this.d.node, { action: "shop.cart", args: { store: among ?? run.store, request: run.request, ...(among ? { compareOnly: among.filter((s) => this.d.compareOnly?.includes(s)) } : {}) } }, run.by ?? "owner")
      .catch((e): ActResponse => ({ status: "refused", node: this.d.node ?? "", action: "shop.cart", error: (e as Error).message }));
    let next: ShopRun;
    if (res.status === "done" && res.result.ok && res.result.data) {
      const c = res.result.data as CartOutcome;
      next = { ...run, status: c.status, items: c.items, total: "total" in c ? c.total : undefined, note: "note" in c ? c.note : undefined, checked: c.checked, account: c.account };
      // A ready cart must say whose it is, or Go to checkout would open the wrong store.
      if (among && c.status === "ready" && !(c.store && among.includes(c.store))) next = { ...next, status: "failed", note: "The agent filled a cart but did not say which store. Look in your carts." };
      else if (c.status === "link" && !(c.store && this.d.compareOnly?.includes(c.store))) next = { ...next, status: "failed", note: "The agent stopped at a link for a store that should have got a cart." };
      else if (c.status === "ready" && c.store && this.d.compareOnly?.includes(c.store)) next = { ...next, status: "link", store: c.store, storeName: STORES[c.store].name, cartUrl: STORES[c.store].cart, searchUrl: `${STORES[c.store].search}${encodeURIComponent(run.request)}`, note: "Cheapest here, but the agent added it to a guest cart it shouldn't have used. Open it yourself." };
      else if (c.status === "link" && c.store) next = { ...next, store: c.store, storeName: STORES[c.store].name, cartUrl: STORES[c.store].cart, searchUrl: storeLink(c.store, c.url) ?? `${STORES[c.store].search}${encodeURIComponent(run.request)}` };
      else if (c.store && STORES[c.store]) next = { ...next, store: c.store, storeName: STORES[c.store].name, cartUrl: STORES[c.store].cart, searchUrl: `${STORES[c.store].search}${encodeURIComponent(run.request)}` };
    } else {
      const why = res.status === "done" ? res.result.output : res.status === "refused" ? res.error : "the device asked for approval, which a cart should not need";
      next = { ...run, status: "failed", note: why.slice(0, 300) };
    }
    next = this.save(next);
    const s = next.status;
    this.d.notify?.({
      title: s === "ready" ? `${next.storeName} cart: ${next.total}` : s === "link" ? `Best at ${next.storeName}${next.items[0]?.price ? `: ${next.items[0].price}` : ""}, open the link` : `${next.storeName}: ${s === "needs_you" ? "needs you" : "cart not filled"}`,
      body: s === "ready" ? next.items.map((i) => `${i.qty} x ${i.name}`).join(", ").slice(0, 200) : next.note ?? "",
      url: `/shop?id=${next.id}`,
      tag: `shop-${next.id}`,
    });
    return next;
  }

  get(id: string): ShopRun | undefined {
    const row = this.d.store.db.prepare("SELECT record FROM shop_runs WHERE id = ?").get(id) as { record: string } | undefined;
    return row ? JSON.parse(row.record) : undefined;
  }

  list(limit = 30): ShopRun[] {
    return (this.d.store.db.prepare("SELECT record FROM shop_runs ORDER BY created_at DESC LIMIT ?").all(limit) as { record: string }[]).map((r) => JSON.parse(r.record));
  }

  /** What Home shows: still running, or waiting on the owner, from the last two days. */
  open(now = this.now): ShopRun[] {
    return this.list(20).filter((r) => ["working", "ready", "needs_you", "link", "checkout", "blocked"].includes(r.status) && now - r.updatedAt < 2 * 86_400_000);
  }

  /**
   * The owner's tap on the items and total. It must carry the total on the screen, so a cart that
   * changed is looked at again. It only hands back the store's page; the order is placed there.
   */
  checkout(id: string, total: string): ShopRun {
    const r = this.get(id);
    if (!r) throw new Error("no such cart");
    if (r.status !== "ready" && r.status !== "checkout") throw new Error(`this cart is ${r.status}, not ready for checkout`);
    if (r.total !== total) throw new Error(`the total changed: it is ${r.total}, your screen said ${total}`);
    this.record("owner", r, "shop.checkout", "opened the store");
    return this.save({ ...r, status: "checkout" });
  }

  /** The owner's own word that it was ordered, or that this is not wanted. */
  close(id: string, status: "ordered" | "dismissed"): ShopRun {
    const r = this.get(id);
    if (!r) throw new Error("no such cart");
    this.record("owner", r, `shop.${status}`, "done");
    return this.save({ ...r, status });
  }
}
