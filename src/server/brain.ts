import type { Hono } from "hono";
import type { Config } from "../config.js";

/**
 * `/api/brain/*`: the phone app's way to the AI_Assistant brain (tasks to confirm, WhatsApp chats
 * and mute, the brief on demand, model key usage, the memory graph). The brain has no other remote:
 * Telegram was removed. The brain listens on 127.0.0.1 only, so this runs on the machine with BRAIN_TOKEN.
 * Only the paths below pass; everything else is refused.
 */
const ALLOWED: [string, RegExp][] = [
  ["GET", /^\/tasks$/],
  ["POST", /^\/tasks$/],
  ["POST", /^\/tasks\/\d+\/(confirm|reject|done)$/],
  ["PATCH", /^\/tasks\/\d+$/],
  ["GET", /^\/chats$/],
  ["POST", /^\/chats\/\d+\/mute$/],
  ["POST", /^\/brief$/],
  ["GET", /^\/llm\/usage$/],
  ["GET", /^\/graph$/],
  ["GET", /^\/memory\/stats$/],
  // the learning harness (AI_Assistant learn.py): feedback, lessons, runs
  ["GET", /^\/learn\/(status|lessons|episodes|cases)$/],
  ["POST", /^\/learn\/episodes\/\d+\/feedback$/],
  ["POST", /^\/learn\/lessons$/],
  ["PATCH", /^\/learn\/lessons\/\d+$/],
  ["POST", /^\/learn\/cases\/\d+\/off$/],
  ["POST", /^\/learn\/(reflect|run)$/],
];

export function brainPathAllowed(method: string, path: string): boolean {
  return ALLOWED.some(([m, re]) => m === method && re.test(path));
}

export function mountBrain(app: Hono, d: { config: Config; brainFetch?: typeof fetch }) {
  app.all("/api/brain/*", async (c) => {
    const { url, token } = d.config.assistant;
    if (!token) return c.json({ error: `device ${d.config.node.name} does not run the brain (BRAIN_TOKEN)` }, 404);
    const path = c.req.path.replace(/^\/api\/brain/, "");
    const method = c.req.method;
    if (!brainPathAllowed(method, path)) return c.json({ error: `${method} ${path} is not available from the app` }, 403);
    try {
      const res = await (d.brainFetch ?? fetch)(`${url.replace(/\/$/, "")}${path}${new URL(c.req.url).search}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: method === "GET" ? undefined : (await c.req.text()) || "{}",
        signal: AbortSignal.timeout(120_000),
      });
      return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json" } });
    } catch (e) {
      return c.json({ error: `brain not reachable: ${(e as Error).message}` }, 502);
    }
  });
}
