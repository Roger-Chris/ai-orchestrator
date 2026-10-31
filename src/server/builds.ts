import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { extname, join, relative, resolve, isAbsolute } from "node:path";
import { Readable } from "node:stream";
import type { Hono } from "hono";
import { stream } from "hono/streaming";
import { z } from "zod";
import { BuildError, type BuildDesk } from "../builds/desk.js";
import { buildApkHere, type PreviewMaker } from "../builds/preview.js";
import { slug } from "../shared/replica.js";
import type { Build, ProviderId } from "../types.js";

/**
 * Builds over HTTP (Jarvis phase 2).
 * - `POST /api/builds`: start or continue a build (the brain's `build` tool, the app).
 * - `GET /api/builds`, `GET /api/builds/:id`: the Builds screen.
 * - `POST /api/builds/:id/preview`: make the preview again. `POST /api/builds/:id/cancel`.
 * - `POST /api/builds/:id/merge`: the owner's tap. Only the owner's own apps call it: the brain's
 *   thinking loop is never given a tool for it.
 * - `GET /p/<previewKey>/...`: the preview site and APK, without the token (the key is the secret),
 *   so the phone's browser and package installer can open them.
 */

const Agent = z.enum(["claude", "codex", "gemini"]);
const StartBody = z.object({
  name: z.string().min(1).max(120),
  spec: z.string().min(1).max(20_000),
  repo: z.string().max(1000).optional(),
  node: z.string().max(120).optional(),
  agent: Agent.optional(),
  reviewer: Agent.optional(),
  continue: z.boolean().optional(),
  kind: z.enum(["app", "slides", "video"]).optional(),
  confirmDesign: z.boolean().optional(),
  /** Who is asking ("brain"); the owner's own apps leave it out. */
  by: z.string().max(80).optional(),
});

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pdf": "application/pdf", ".mp4": "video/mp4", ".webm": "video/webm",
  ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".map": "application/json", ".wasm": "application/wasm",
};

/** Makes a build's preview in the background and keeps the result on the build. */
export function previewer(desk: BuildDesk, maker: PreviewMaker, now = Date.now) {
  const busy = new Set<string>();
  return async (b: Build) => {
    if (busy.has(b.id)) return;
    busy.add(b.id);
    try {
      desk.setPreview(b.id, { status: "building", at: now() });
      const r = await maker.make(desk.get(b.id) ?? b);
      desk.setPreview(b.id, { ...r, at: now() });
    } finally {
      busy.delete(b.id);
    }
  };
}

/** Builds as the app shows them: hub paths stay on the hub. */
const pub = (b: Build) => (b.preview ? { ...b, preview: { ...b.preview, webRoot: undefined, apkFile: undefined, filesRoot: undefined } } : b);

/**
 * "Update this app": the newest APK the hub built of the phone app itself (config `builds.selfApp`),
 * merged or still waiting for Merge, so the app can install its own update.
 */
export function appUpdate(desk: BuildDesk | undefined, selfApp: string) {
  const want = slug(selfApp);
  const b = desk?.list(200).find((x) => slug(x.name) === want && x.preview?.status === "ready" && x.preview.apk && x.preview.apkFile && existsSync(x.preview.apkFile));
  if (!b) return { available: false as const, app: selfApp };
  return {
    available: true as const,
    app: selfApp,
    build: b.id,
    spec: b.spec.slice(0, 300),
    status: b.status,
    branch: b.branches.at(-1)?.name,
    builtAt: b.preview!.at,
    apk: b.preview!.apk!,
    size: statSync(b.preview!.apkFile!).size,
  };
}

export function mountBuilds(app: Hono, d: { builds?: BuildDesk; preview?: (b: Build) => Promise<void>; config?: { builds: { selfApp: string } } }) {
  app.get("/api/app/update", (c) => c.json(appUpdate(d.builds, d.config?.builds.selfApp ?? "orchestrator")));
  const off = (c: any) => c.json({ error: "builds are not set up on this hub" }, 404);
  const fail = (c: any, e: unknown) => (e instanceof BuildError ? c.json({ error: e.message }, e.status) : Promise.reject(e));

  app.get("/api/builds", (c) => (d.builds ? c.json(d.builds.list(Number(c.req.query("limit") ?? 30)).map((b) => pub(d.builds!.view(b)))) : off(c)));
  app.get("/api/builds/:id", (c) => {
    if (!d.builds) return off(c);
    const b = d.builds.get(c.req.param("id"));
    return b ? c.json(pub(d.builds.view(b))) : c.json({ error: "no such build" }, 404);
  });
  app.post("/api/builds", async (c) => {
    if (!d.builds) return off(c);
    const parsed = StartBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid build", issues: parsed.error.issues }, 400);
    const body = parsed.data;
    try {
      const started = await d.builds.make({ ...body, agent: body.agent as ProviderId | undefined, reviewer: body.reviewer as ProviderId | undefined });
      return c.json(pub(d.builds.view(started)));
    } catch (e) {
      return fail(c, e);
    }
  });
  app.post("/api/builds/:id/cancel", (c) => {
    if (!d.builds) return off(c);
    try {
      return c.json(pub(d.builds.cancel(c.req.param("id"))));
    } catch (e) {
      return fail(c, e);
    }
  });
  app.post("/api/builds/:id/merge", async (c) => {
    if (!d.builds) return off(c);
    try {
      return c.json(pub(await d.builds.merge(c.req.param("id"))));
    } catch (e) {
      return fail(c, e);
    }
  });
  app.post("/api/builds/:id/preview", (c) => {
    if (!d.builds || !d.preview) return off(c);
    const b = d.builds.get(c.req.param("id"));
    if (!b) return c.json({ error: "no such build" }, 404);
    if (!b.branches.length) return c.json({ error: "the build has no branch to preview yet" }, 409);
    void d.preview(b);
    return c.json({ status: "building" }, 202);
  });

  // Preview files, by key (no token: the key is unguessable and only the owner's apps see it).
  app.get("/p/:key/*", (c) => {
    const b = d.builds?.byPreviewKey(c.req.param("key"));
    if (!b?.preview) return c.text("not found", 404);
    const rest = decodeURIComponent(c.req.path.split("/").slice(3).join("/"));
    if (rest === "app.apk") {
      if (!b.preview.apkFile || !existsSync(b.preview.apkFile)) return c.text("no APK", 404);
      return send(b.preview.apkFile, "application/vnd.android.package-archive", `${b.name.replace(/[^\w.-]+/g, "-")}-${b.id}.apk`);
    }
    if (rest.startsWith("files/")) {
      const name = rest.slice(6);
      if (!b.preview.filesRoot || !b.preview.files?.some((f) => f.name === name)) return c.text("no such file", 404);
      return send(join(b.preview.filesRoot, name), MIME[extname(name).toLowerCase()] ?? "application/octet-stream", name.replace(/[^\w.-]+/g, "-"));
    }
    const root = b.preview.webRoot;
    if (!root || !existsSync(root)) return c.text("no web preview", 404);
    let file = resolve(root, rest || "index.html");
    const rel = relative(realpathSync(root), existsSync(file) ? realpathSync(file) : file);
    if (rel.startsWith("..") || isAbsolute(rel)) return c.text("not found", 404);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    // single-page apps: unknown paths get index.html
    if (!existsSync(file)) file = extname(file) ? file : join(root, "index.html");
    if (!existsSync(file)) return c.text("not found", 404);
    return send(file, MIME[extname(file).toLowerCase()] ?? "application/octet-stream");
  });
  app.get("/p/:key", (c) => c.redirect(`/p/${c.req.param("key")}/`));
}

const ApkBody = z.object({ id: z.string().regex(/^[\w.-]{1,80}$/), remoteUrl: z.string().min(1).max(500), branch: z.string().regex(/^[\w./-]{1,200}$/), appDir: z.string().max(200).default(""), timeoutMs: z.number().optional() });

/**
 * The Android side of previews, on the device with the Android SDK (`builds.androidHere: true`, the
 * laptop): the hub sends the repo, branch and app folder; this builds the APK and streams progress
 * (a long Gradle build would otherwise look like a dead connection), then serves the file once.
 */
export function mountApkNode(app: Hono, d: { config: { dataDir: string; builds: { androidHere: boolean; apkTimeoutMinutes: number } }; exec?: Parameters<typeof buildApkHere>[1]["exec"] }) {
  const done = new Map<string, string>();
  app.post("/node/apk-build", async (c) => {
    if (!d.config.builds.androidHere) return c.json({ error: "this device does not build APKs (set builds.androidHere: true on the device with the Android SDK)" }, 403);
    const parsed = ApkBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid APK build", issues: parsed.error.issues }, 400);
    const req = parsed.data;
    if (/^(-|ext::)/.test(req.remoteUrl) || /\.\.(\/|\\|$)/.test(req.appDir) || isAbsolute(req.appDir)) return c.json({ error: "bad repo or folder" }, 400);
    c.header("Content-Type", "application/x-ndjson");
    return stream(c, async (s) => {
      const tick = setInterval(() => void s.write(JSON.stringify({ type: "progress", note: "building the APK…" }) + "\n"), 30_000);
      try {
        const r = await buildApkHere(req, { dataDir: resolve(d.config.dataDir), exec: d.exec, timeoutMs: d.config.builds.apkTimeoutMinutes * 60_000 });
        if (r.ok && r.apkFile) done.set(req.id, r.apkFile);
        await s.write(JSON.stringify({ type: "result", result: r }) + "\n");
      } finally {
        clearInterval(tick);
      }
    });
  });
  app.get("/node/apk-build/:id/app.apk", (c) => {
    const f = done.get(c.req.param("id"));
    if (!f || !existsSync(f)) return c.text("no APK", 404);
    return send(f, "application/vnd.android.package-archive", "app.apk");
  });
}

function send(file: string, type: string, download?: string) {
  const headers: Record<string, string> = { "Content-Type": type, "Content-Length": String(statSync(file).size), "Cache-Control": "no-store" };
  if (download) headers["Content-Disposition"] = `attachment; filename="${download}"`;
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers });
}
