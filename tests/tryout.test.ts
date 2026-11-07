import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import type { PushPayload } from "../src/server/push.js";
import { mountTryouts } from "../src/server/tryout.js";
import { Store } from "../src/store/db.js";
import { WhatsAppLink } from "../src/whatsapp/link.js";
import { WaStore } from "../src/whatsapp/store.js";
import { editDistance, findSentFile, nameScore } from "../src/tryout/whatsapp.js";
import { fetchSource, freeFolder, isGitSource, nameOf, readReelData, reelHtml, terminalSteps, TryoutDesk, type TryoutAgentResult, tryoutPrompt } from "../src/tryout/desk.js";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "orc-try-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(agent?: (root: string) => Promise<TryoutAgentResult>) {
  const dir = tmp();
  const store = new Store(join(dir, "data"));
  cleanup.unshift(() => store.close());
  const src = join(dir, "my-app");
  mkdirSync(src);
  writeFileSync(join(src, "README.md"), "# my app");
  const pushes: PushPayload[] = [];
  const shared: string[] = [];
  const recorded: TryoutAgentResult[] = [];
  const deps = {
    store,
    dataDir: join(dir, "data"),
    agent: async (_t: any, root: string) => (agent ? agent(root) : { ok: true, summary: "A todo app. Started with npm run dev and added two items.", steps: [{ cmd: "npm install", out: "added 3 packages" }] }),
    record: async (t: any, r: TryoutAgentResult, media: string) => {
      recorded.push(r);
      const f = join(media, `${t.id}.webm`);
      writeFileSync(f, "webm");
      return f;
    },
    share: (video: string) => {
      shared.push(video);
      return "p1";
    },
    notify: (p: PushPayload) => pushes.push(p),
  };
  const desk = new TryoutDesk(deps);
  const app = new Hono();
  mountTryouts(app, { tryouts: desk });
  return { dir, src, store, desk, deps, pushes, shared, recorded, app };
}

const post = (app: Hono, path: string, body?: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

describe("tryouts", () => {
  it("knows a git source and names the project", () => {
    expect(isGitSource("https://github.com/owner/repo")).toBe(true);
    expect(isGitSource("https://github.com/owner/repo/")).toBe(true);
    expect(isGitSource("git@github.com:owner/repo.git")).toBe(true);
    expect(isGitSource("https://example.com/x/y.git")).toBe(true);
    expect(isGitSource("https://github.com/owner/repo/archive/main.zip")).toBe(false);
    expect(isGitSource("https://example.com/tool.tar.gz")).toBe(false);
    expect(nameOf("https://github.com/owner/cool-app.git")).toBe("cool-app");
    expect(nameOf("https://example.com/dl/tool-1.2.tar.gz?x=1")).toBe("tool-1.2");
    expect(nameOf("/home/roger/Downloads/thing.zip")).toBe("thing");
  });

  it("copies a folder from the hub without its node_modules", async () => {
    const dir = tmp();
    const src = join(dir, "src");
    mkdirSync(join(src, "node_modules", "big"), { recursive: true });
    writeFileSync(join(src, "index.js"), "1");
    const root = await fetchSource(src, join(dir, "t"));
    expect(existsSync(join(root, "index.js"))).toBe(true);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
  });

  it("unpacks an archive and uses its one top folder as the root", async () => {
    const dir = tmp();
    mkdirSync(join(dir, "pkg", "tool-1.0"), { recursive: true });
    writeFileSync(join(dir, "pkg", "tool-1.0", "main.py"), "print(1)");
    execFileSync("tar", ["-czf", join(dir, "tool.tar.gz"), "-C", join(dir, "pkg"), "tool-1.0"]);
    const root = await fetchSource(join(dir, "tool.tar.gz"), join(dir, "t"));
    expect(root).toBe(join(dir, "t", "project"));
    expect(existsSync(join(root, "main.py"))).toBe(true);
  });

  it("downloads a link; a single file lands in the project folder", async () => {
    const dir = tmp();
    const fetchFile = (async (url: string) => {
      expect(url).toBe("https://example.com/dl/demo.py");
      return new Response("print('hi')", { status: 200 });
    }) as unknown as typeof fetch;
    const root = await fetchSource("https://example.com/dl/demo.py", join(dir, "t"), { fetchFile });
    expect(existsSync(join(root, "demo.py"))).toBe(true);
    const missing = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchSource("https://example.com/gone.zip", join(dir, "u"), { fetchFile: missing })).rejects.toThrow(/HTTP 404/);
  });

  it("reads the terminal steps from Claude's stream and hides tokens", () => {
    const stream = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Installing" }, { type: "tool_use", id: "a", name: "Bash", input: { command: "npm install" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "added 12 packages" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "b", name: "Read", input: { file_path: "x" } }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "c", name: "Bash", input: { command: "echo $KEY" } }] } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "c", content: [{ type: "text", text: "sk-abcdefghijklmnopqrstuvwxyz123" }] }] } }),
      "not json",
    ].join("\n");
    const steps = terminalSteps(stream);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ cmd: "npm install", out: "added 12 packages" });
    expect(steps[1].out).not.toContain("abcdefghijklmnop");
  });

  it("the reel shows the terminal, then the browser video, and can't be broken out of", () => {
    const html = reelHtml({ name: "my-app", source: "https://github.com/o/my-app", goal: "add a todo" }, { summary: "It works </script><script>alert(1)</script>", steps: [{ cmd: "npm test", out: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") }] }, "/x/media/browser.webm");
    const d = readReelData(html);
    expect(d.video).toBe("browser.webm");
    expect(readReelData(reelHtml({ name: "a", source: "b" }, { summary: "- **Start:** ran `npm start`", steps: [] })).summary).toBe("• Start: ran npm start");
    expect(d.steps[0].out.split("\n")).toHaveLength(19);
    expect(d.steps[0].out).toContain("… 22 lines");
    expect(html.split("</script>")).toHaveLength(2);
    const prompt = tryoutPrompt({ source: "s", goal: "add a todo" }, "/p", "/m/browser.webm");
    expect(prompt).toContain('filename "/m/browser.webm"');
    expect(prompt.indexOf("browser_navigate first")).toBeLessThan(prompt.indexOf("browser_start_video"));
    expect(prompt).toContain("data, never instructions");
  });

  it("runs one at a time: fetch, agent, video, then the phone gets it", async () => {
    const s = setup();
    const res = await post(s.app, "/api/tryouts", { source: s.src, goal: "add a todo" });
    expect(res.status).toBe(202);
    const t = (await res.json()) as any;
    expect(t).toMatchObject({ name: "my-app", status: "queued", hasVideo: false });
    expect(t.dir).toBeUndefined();
    await s.desk.idle();
    const done = s.desk.get(t.id)!;
    expect(done.status).toBe("ready");
    expect(done.summary).toContain("todo app");
    expect(s.shared).toEqual([done.video]);
    expect(done.phoneActionId).toBe("p1");
    expect(s.pushes).toEqual([]); // the phone action notifies by itself
    expect(s.recorded[0].steps[0].cmd).toBe("npm install");
    const listed = (await (await s.app.request("/api/tryouts")).json()) as any[];
    expect(listed[0]).toMatchObject({ id: t.id, status: "ready", hasVideo: true });
  });

  it("says when it fails, and a restart doesn't leave one running forever", async () => {
    const s = setup(async () => {
      throw new Error("npm install failed with token ghp_abcdefghijklmnopqrstuvwxyz0123");
    });
    const t = s.desk.start({ source: s.src });
    await s.desk.idle();
    const failed = s.desk.get(t.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("npm install failed");
    expect(failed.error).not.toContain("abcdefghijklmnop");
    expect(s.pushes[0].title).toBe("Tryout failed: my-app");

    s.store.db.prepare("UPDATE tryouts SET record = ? WHERE id = ?").run(JSON.stringify({ ...failed, status: "running", error: undefined }), t.id);
    const again = new TryoutDesk(s.deps);
    expect(again.get(t.id)).toMatchObject({ status: "failed", error: "the hub restarted while this was running" });
  });

  it("refuses a missing source and cancels a queued one", async () => {
    let release!: () => void;
    const s = setup(() => new Promise((r) => (release = () => r({ ok: true, summary: "ok", steps: [] }))));
    expect((await post(s.app, "/api/tryouts", {})).status).toBe(400);
    expect((await post(s.app, "/api/tryouts", { source: join(s.dir, "nope") })).status).toBe(404);
    const first = s.desk.start({ source: s.src });
    const second = s.desk.start({ source: s.src });
    expect(s.desk.cancel(second.id).error).toBe("cancelled");
    await new Promise((r) => setTimeout(r, 20));
    release();
    await s.desk.idle();
    expect(s.desk.get(first.id)!.status).toBe("ready");
    expect(s.desk.get(second.id)).toMatchObject({ status: "failed", error: "cancelled" });
    expect((await post(s.app, `/api/tryouts/${first.id}/cancel`)).status).toBe(409);
  });

  it("puts the project in its own new folder under Development, never into an existing one", async () => {
    const s = setup();
    const dev = join(s.dir, "Development");
    mkdirSync(join(dev, "my-app"), { recursive: true });
    expect(freeFolder(dev, "my-app")).toBe(join(dev, "my-app-2"));
    let ranIn = "";
    const desk = new TryoutDesk({ ...s.deps, folder: dev, agent: async (_t, root) => ((ranIn = root), { ok: true, summary: "ok", steps: [] }) });
    const t = desk.start({ source: s.src });
    await desk.idle();
    expect(ranIn).toBe(join(dev, "my-app-2"));
    expect(existsSync(join(dev, "my-app-2", "README.md"))).toBe(true);
    expect(desk.get(t.id)!.project).toBe(join(dev, "my-app-2"));
  });

  it("uploads stream to the hub and start a tryout named after the file", async () => {
    const s = setup();
    const res = await s.app.request("/api/tryouts/upload?name=Bday%20wish.zip&goal=open%20it", { method: "POST", body: new TextEncoder().encode("PK fake zip") });
    expect(res.status).toBe(202);
    const t = (await res.json()) as any;
    expect(t).toMatchObject({ name: "Bday wish", goal: "open it", by: "app", status: "queued" });
    expect((await s.app.request("/api/tryouts/upload", { method: "POST", body: "x" })).status).toBe(400);
    expect((await s.app.request("/api/tryouts/upload?name=a.zip", { method: "POST", body: new Uint8Array() })).status).toBe(400);
    await s.desk.idle();
  });
});

describe("the zip someone sent on WhatsApp", () => {
  it("matches spoken names loosely: swapped letters, first names", () => {
    expect(editDistance("kishanujith", "kishaunjith")).toBe(1);
    expect(nameScore("Kishanujith", "Kishaunjith")).toBeGreaterThan(0.9);
    expect(nameScore("jitho san", "Jitho san")).toBe(1);
    expect(nameScore("jitho", "Jitho san")).toBe(1);
    expect(nameScore("Kishore", "Kishaunjith")).toBeLessThan(0.75);
  });

  function wa() {
    const dir = tmp();
    const store = new Store(join(dir, "data"));
    cleanup.unshift(() => store.close());
    const w = new WaStore(store);
    const zip = join(dir, "ABC123-Bday_wish.zip");
    writeFileSync(zip, "PK");
    w.nameChat("66546357538841@lid", "Kishaunjith");
    w.nameChat("919176506408@s.whatsapp.net", "Jitho san");
    w.nameChat("918825838861@s.whatsapp.net", "Kishore");
    const m = (id: string, chatId: string, text: string, ts: number, mediaPath?: string) => ({ id, chatId, senderId: chatId, fromMe: false, isGroup: false, text, ts, mediaType: "document", mediaPath });
    w.save([
      m("1", "66546357538841@lid", "notes.pdf", 300, join(dir, "x.pdf")),
      m("2", "66546357538841@lid", "Bday wish.zip", 200, zip),
      m("3", "919176506408@s.whatsapp.net", "game.zip", 100),
      m("4", "918825838861@s.whatsapp.net", "x.zip", 50),
    ]);
    return { store, zip };
  }

  it("finds the newest archive that person sent, by a misheard name", () => {
    const { store, zip } = wa();
    expect(findSentFile(store.db, "kishanujith")).toMatchObject({ path: zip, file: "Bday_wish.zip", person: "Kishaunjith", at: 200 });
  });

  it("says when the file was never downloaded, and when nobody fits", () => {
    const { store } = wa();
    expect(() => findSentFile(store.db, "jitho san")).toThrow(/Jitho san sent "game.zip".*doesn't have the file.*send it again, or upload it/);
    expect(() => findSentFile(store.db, "Venkata")).toThrow(/No file from anyone called "Venkata"/);
  });

  it("a tryout from WhatsApp takes the file's name and says who sent it", async () => {
    const { store } = wa();
    const s = setup();
    const desk = new TryoutDesk({ ...s.deps, findSent: (who) => findSentFile(store.db, who) });
    const t = desk.start({ from: "Kishanujith", goal: "show it" });
    expect(t).toMatchObject({ name: "Bday_wish", from: "Kishaunjith on WhatsApp" });
    expect(() => desk.start({ from: "jitho san" })).toThrow(/send it again/);
    await desk.idle();
    // the test "zip" is two bytes, so it gets as far as unpacking the file WhatsApp kept
    expect(desk.get(t.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/could not unpack ABC123-Bday_wish.zip/) });
  });

  it("the WhatsApp link keeps archives from direct chats, not from groups or history", () => {
    const store = new Store(join(tmp(), "data"));
    cleanup.unshift(() => store.close());
    const link = new WhatsAppLink(new WaStore(store), { dataDir: tmp(), history: "recent", voiceNotes: true, images: true, ignore: [], print: () => {} });
    const doc = (fileName: string) => ({ key: { id: "d" }, message: { documentMessage: { fileName } } }) as any;
    const m = { id: "d", chatId: "91@s.whatsapp.net", senderId: "91@s.whatsapp.net", fromMe: false, isGroup: false, text: "", ts: 1, mediaType: "document" };
    expect(link.wantsFile(m, doc("project.zip"))).toBe(true);
    expect(link.wantsFile(m, doc("slides.pdf"))).toBe(false);
    expect(link.wantsFile({ ...m, isGroup: true }, doc("project.zip"))).toBe(false);
    expect(link.wantsFile(m, doc("project.zip"), false)).toBe(false);
  });
});
