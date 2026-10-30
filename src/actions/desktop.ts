import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { platform } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { runProcess } from "../providers/base.js";
import type { ActionContext, ActionDef, ActionResult } from "./registry.js";
import { insideRoots, redact, roots } from "./registry.js";

/**
 * Device control (Jarvis phase 3).
 * D1, the desktop: focus and close programs (close asks), a screenshot on request (asks: it shows
 * whatever is on the screen), and GUI-only apps through a computer-use agent the owner configured
 * (asks). D2, files across devices: search the index of every device, re-index this one, and copy a
 * file to another device (asks; the receiving device never replaces a file).
 *
 * This file defines its actions with its own `def` so the circular import with registry.ts only
 * touches function declarations (insideRoots, redact, roots), which exist before either module runs.
 */

const def = <A extends z.ZodTypeAny>(d: ActionDef<A>) => d as unknown as ActionDef;
const OS = () => platform();
/** Program names as people say them: letters, digits, spaces, dots, dashes. */
const AppName = z.string().min(1).max(80).regex(/^[\w .+-]+$/, "a program name (letters, digits, spaces, . + -)");

const ps = (script: string, ...args: string[]) => runProcess({ command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script, ...args], timeoutMs: 30_000 });
const done = (r: { code: number | null; stdout: string; stderr: string; spawnError?: string }, ok: string): ActionResult =>
  r.code === 0 && !r.spawnError ? { ok: true, output: ok } : { ok: false, output: redact(r.stderr.trim() || r.spawnError || r.stdout.trim() || "failed") };

/** Where screenshots go: Screenshots/ in the first assistant folder that exists, so files.* and files.send can use them. */
export function screenshotFolder(ctx: ActionContext): string {
  const base = roots(ctx.config).find(existsSync) ?? roots(ctx.config)[0];
  const dir = join(base, "Screenshots");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const DESKTOP_ACTIONS: ActionDef[] = [
  def({
    name: "apps.focus",
    describe: "Bring a running program's window to the front (Windows, macOS; Linux needs wmctrl).",
    args: z.object({ app: AppName }),
    risk: () => "safe",
    summary: (a) => `Bring ${a.app} to the front`,
    run: async (a) => {
      if (OS() === "win32") return done(await ps("(New-Object -ComObject WScript.Shell).AppActivate($args[0]) | Out-String", a.app), `Brought ${a.app} to the front`);
      if (OS() === "darwin") return done(await runProcess({ command: "osascript", args: ["-e", `tell application "${a.app}" to activate`], timeoutMs: 20_000 }), `Brought ${a.app} to the front`);
      return done(await runProcess({ command: "wmctrl", args: ["-a", a.app], timeoutMs: 20_000 }), `Brought ${a.app} to the front`);
    },
  }),
  def({
    name: "apps.close",
    describe: "Close a program politely, as if its window's close button was clicked (it can still ask to save). Never kills it.",
    args: z.object({ app: AppName }),
    risk: () => "ask",
    summary: (a) => `Close ${a.app} (it may ask to save)`,
    run: async (a) => {
      if (OS() === "win32")
        return done(await ps("$p = Get-Process -Name $args[0] -ErrorAction Stop; $p | ForEach-Object { [void]$_.CloseMainWindow() }; \"closing $($p.Count) window(s)\"", a.app), `Asked ${a.app} to close`);
      if (OS() === "darwin") return done(await runProcess({ command: "osascript", args: ["-e", `tell application "${a.app}" to quit`], timeoutMs: 30_000 }), `Asked ${a.app} to quit`);
      return done(await runProcess({ command: "wmctrl", args: ["-c", a.app], timeoutMs: 20_000 }), `Asked ${a.app} to close`);
    },
  }),
  def({
    name: "screen.shot",
    describe: "Take a screenshot of this device's screen; saved as a PNG in Screenshots/ inside the assistant's first folder.",
    args: z.object({}).passthrough(),
    risk: () => "ask",
    summary: () => "Take a screenshot of the screen",
    run: async (_a, ctx) => {
      const file = join(screenshotFolder(ctx), `jarvis-${(ctx.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19)}.png`);
      let r;
      if (OS() === "win32") {
        r = await ps(
          "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = [System.Windows.Forms.SystemInformation]::VirtualScreen; $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height; $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $bmp.Save($args[0], [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()",
          file,
        );
      } else if (OS() === "darwin") r = await runProcess({ command: "screencapture", args: ["-x", file], timeoutMs: 30_000 });
      else {
        // whichever screenshot tool this Linux desktop has
        for (const [command, args] of [["gnome-screenshot", ["-f", file]], ["grim", [file]], ["scrot", ["-o", file]], ["import", ["-window", "root", file]]] as const) {
          r = await runProcess({ command, args: [...args], timeoutMs: 30_000 });
          if (!r.spawnError) break;
        }
      }
      if (!r || r.code !== 0 || !existsSync(file)) return { ok: false, output: redact(r?.stderr.trim() || r?.spawnError || "no screenshot tool worked (Linux: install gnome-screenshot, grim or scrot)") };
      return { ok: true, output: `Saved ${file} (${Math.round(statSync(file).size / 1024)} KB)`, data: { file } };
    },
  }),
  def({
    name: "gui.task",
    describe:
      "Do something in a program that has no command line, by looking at the screen and clicking (a computer-use agent the owner set up in actions.computerUse.command). Always asks first.",
    args: z.object({ goal: z.string().min(3).max(2000), app: z.string().max(80).optional() }),
    risk: () => "ask",
    summary: (a) => `Use the screen${a.app ? ` in ${a.app}` : ""}: ${a.goal.slice(0, 200)}`,
    run: async (a, ctx) => {
      const cu = ctx.config.actions.computerUse;
      if (!cu.command) return { ok: false, output: "No computer-use agent is set up on this device (actions.computerUse.command), so GUI-only apps can't be driven here." };
      const goal = a.app ? `In ${a.app}: ${a.goal}` : a.goal;
      // the goal is one argument, never pasted into a shell line
      const args = cu.args.map((x) => (x === "{goal}" ? goal : x));
      if (!cu.args.includes("{goal}")) args.push(goal);
      const r = await runProcess({ command: cu.command, args, timeoutMs: cu.timeoutMinutes * 60_000, signal: ctx.signal });
      const out = `${r.stdout}\n${r.stderr}`.trim();
      return { ok: r.code === 0 && !r.timedOut && !r.spawnError, output: redact(out.slice(-ctx.config.actions.outputChars) || r.spawnError || (r.timedOut ? "timed out" : "(no output)")) };
    },
  }),
  def({
    name: "files.everywhere",
    describe: "Search the file index of every device (names and folders, not contents). Words must all appear in the path.",
    args: z.object({ query: z.string().min(1).max(200), device: z.string().optional(), ext: z.string().max(10).optional(), limit: z.number().int().min(1).max(100).default(20) }),
    risk: () => "safe",
    summary: (a) => `Find files named like ${a.query} on every device`,
    run: async (a, ctx) => {
      if (!ctx.files) return { ok: false, output: "the file index is not reachable from this device" };
      const hits = await ctx.files.search(a.query, { node: a.device, ext: a.ext, limit: a.limit });
      const lines = hits.map((h) => `${h.node}: ${h.path} (${Math.max(1, Math.round(h.size / 1024))} KB, ${new Date(h.mtime).toISOString().slice(0, 10)})`);
      return { ok: true, output: lines.join("\n") || "Nothing in the index matches.", data: hits };
    },
  }),
  def({
    name: "files.index",
    describe: "Re-index this device's assistant folders now and send the list to the hub (names, sizes, dates only).",
    args: z.object({}).passthrough(),
    risk: () => "safe",
    summary: () => "Re-index this device's files",
    run: async (_a, ctx) => {
      if (!ctx.files) return { ok: false, output: "the file index is not reachable from this device" };
      const r = await ctx.files.reindex();
      return { ok: true, output: `Indexed ${r.files} files in ${r.roots.join(", ")}${r.truncated ? " (stopped at the limit)" : ""}.` };
    },
  }),
  def({
    name: "files.send",
    describe: "Copy a file from this device to another device's assistant folder. The other device never replaces a file: a name that exists gets \" (2)\".",
    args: z.object({ path: z.string().min(1), to: z.string().min(1), folder: z.string().max(500).optional() }),
    risk: () => "ask",
    summary: (a) => `Copy ${a.path} to ${a.to}${a.folder ? ` (${a.folder})` : ""}`,
    run: async (a, ctx) => {
      if (!ctx.sendFile) return { ok: false, output: "copying to other devices is not set up here" };
      const src = insideRoots(a.path, ctx.config);
      const st = statSync(src);
      if (!st.isFile()) return { ok: false, output: `${a.path} is not a file` };
      const max = ctx.config.actions.sendMaxMB * 1024 * 1024;
      if (st.size > max) return { ok: false, output: `${basename(src)} is ${Math.round(st.size / 1048576)} MB; the limit is ${ctx.config.actions.sendMaxMB} MB (actions.sendMaxMB)` };
      const dest = await ctx.sendFile(a.to, `${a.folder ? `${a.folder.replace(/[\\/]+$/, "")}/` : ""}${basename(src)}`, readFileSync(src));
      return { ok: true, output: `Copied ${basename(src)} to ${a.to}: ${dest}`, data: { node: a.to, path: dest } };
    },
  }),
];
