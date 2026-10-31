import { resolve } from "node:path";
import { z } from "zod";
import type { ActionDef } from "../actions/registry.js";
import { runCartAgent, STORE_IDS } from "./agent.js";

const def = <A extends z.ZodTypeAny>(d: ActionDef<A>) => d as unknown as ActionDef;

export const SHOP_ACTIONS: ActionDef[] = [
  def({
    name: "shop.cart",
    describe: "Find a product on a store and add it to the cart in the assistant's own browser profile, then read the cart back. It can't order or pay. Prefer the shop tool, which shows the owner the result.",
    // One store, or a list to search: then it adds to the cart at the best one and says which.
    args: z.object({ store: z.union([z.enum(STORE_IDS), z.array(z.enum(STORE_IDS)).min(1)]), request: z.string().min(2).max(500) }),
    // A cart orders nothing and the owner asked for it. Outside agents are refused this one (src/outside/mcp.ts).
    risk: () => "safe",
    summary: (a) => `Add to the ${Array.isArray(a.store) ? "best store's" : a.store} cart: ${a.request}`,
    run: async (a, ctx) => {
      const s = ctx.config.shopping;
      const cart = await runCartAgent(a.store, a.request, { dataDir: resolve(ctx.config.dataDir), browser: s.browser, command: s.command, model: s.model, headless: s.headless, timeoutMinutes: s.timeoutMinutes, signal: ctx.signal });
      return { ok: true, output: `${cart.status}: ${cart.items.map((i) => `${i.qty} x ${i.name}`).join(", ") || "nothing in the cart"}${"total" in cart && cart.total ? `, total ${cart.total}` : ""}${"note" in cart && cart.note ? ` (${cart.note})` : ""}`, data: cart };
    },
  }),
];
