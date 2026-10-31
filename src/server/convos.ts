import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Hono } from "hono";
import { stream } from "hono/streaming";
import { z } from "zod";
import type { ConvoDesk } from "../convos/desk.js";

/**
 * Recorded conversations over HTTP.
 * - `POST /api/convos`: multipart `audio` (with optional `source`, `durationSec`) or JSON `{text, source?}`.
 * - `GET /api/convos`, `GET /api/convos/:id`, `POST /api/convos/:id/retry`: the app's Record screen.
 * - `POST /node/transcribe`: the raw audio, on a device with Whisper (`convos.whisperHere`, the
 *   laptop). Answers NDJSON with progress, like an APK build: a long recording takes minutes.
 */

const MAX_BYTES = 400 * 1024 * 1024;
const TextBody = z.object({ text: z.string().min(1).max(500_000), source: z.string().max(40).optional() });

export function mountConvos(app: Hono, d: { convos?: ConvoDesk; whisper?: { here: boolean; dataDir: string; run: (file: string) => Promise<{ text: string; language?: string }> } }) {
  const off = (c: any) => c.json({ error: "recordings are not set up on this hub" }, 404);

  app.post("/api/convos", async (c) => {
    if (!d.convos) return off(c);
    if (Number(c.req.header("content-length") ?? 0) > MAX_BYTES) return c.json({ error: "the recording is too large (400 MB at most)" }, 413);
    if ((c.req.header("content-type") ?? "").startsWith("multipart/form-data")) {
      const form = await c.req.parseBody();
      const file = form.audio;
      if (!(file instanceof File)) return c.json({ error: "send the recording in the `audio` field" }, 400);
      const seconds = Number(form.durationSec);
      return c.json(d.convos.addAudio(new Uint8Array(await file.arrayBuffer()), file.type || "audio/mp4", String(form.source ?? "phone").slice(0, 40), Number.isFinite(seconds) ? seconds : undefined), 201);
    }
    const parsed = TextBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "send `audio` or `text`" }, 400);
    return c.json(d.convos.addText(parsed.data.text, parsed.data.source ?? "text"), 201);
  });
  app.get("/api/convos", (c) => (d.convos ? c.json(d.convos.list(Number(c.req.query("limit") ?? 30))) : off(c)));
  app.get("/api/convos/:id", (c) => {
    if (!d.convos) return off(c);
    const x = d.convos.get(c.req.param("id"));
    return x ? c.json(x) : c.json({ error: "no such recording" }, 404);
  });
  app.post("/api/convos/:id/retry", (c) => {
    if (!d.convos) return off(c);
    const x = d.convos.retry(c.req.param("id"));
    return x ? c.json(x) : c.json({ error: "no such recording" }, 404);
  });

  app.post("/node/transcribe", async (c) => {
    if (!d.whisper?.here) return c.json({ error: "this device does not transcribe (convos.whisperHere)" }, 403);
    const dir = resolve(d.whisper.dataDir, "convos-in");
    mkdirSync(dir, { recursive: true });
    const file = resolve(dir, `${randomBytes(6).toString("hex")}.${(c.req.header("x-audio-ext") ?? "m4a").replace(/\W/g, "").slice(0, 5) || "m4a"}`);
    writeFileSync(file, new Uint8Array(await c.req.arrayBuffer()));
    c.header("Content-Type", "application/x-ndjson");
    return stream(c, async (s) => {
      const tick = setInterval(() => void s.write(`${JSON.stringify({ type: "progress" })}\n`), 30_000);
      try {
        const result = await d.whisper!.run(file);
        await s.write(`${JSON.stringify({ type: "result", result })}\n`);
      } catch (e) {
        await s.write(`${JSON.stringify({ type: "result", error: (e as Error).message })}\n`);
      } finally {
        clearInterval(tick);
        rmSync(file, { force: true }); // this device's copy; the hub keeps the recording
      }
    });
  });
}
