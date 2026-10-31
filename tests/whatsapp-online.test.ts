import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Store } from "../src/store/db.js";
import { WhatsAppLink } from "../src/whatsapp/link.js";
import { readMediaOnline, type OnlineMedia } from "../src/whatsapp/online.js";
import { WaStore, type WaMessage } from "../src/whatsapp/store.js";

const cleanup: (() => void)[] = [];
afterAll(() => cleanup.forEach((f) => f()));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "orc-wa-online-"));
  const store = new Store(dir);
  cleanup.push(() => (store.close(), rmSync(dir, { recursive: true, force: true })));
  return { dir, store, wa: new WaStore(store) };
}

const msg = (id: string, over: Partial<WaMessage> = {}): WaMessage => ({ id, chatId: "91@s.whatsapp.net", senderId: "91@s.whatsapp.net", fromMe: false, isGroup: false, text: "", ts: 100, ...over });

const media = (over: Partial<OnlineMedia> = {}): OnlineMedia => ({
  voice: { configured: true, transcribe: async () => "coming at five" },
  gemini: { apiKey: "k", baseUrl: "https://g.test/v1beta/", model: "m" },
  ...over,
});

describe("a device with no GPU reads live media online", () => {
  it("gets a voice note's words from Groq", async () => {
    const { dir, wa } = setup();
    const path = join(dir, "a.ogg");
    writeFileSync(path, "ogg");
    const m = msg("v", { mediaType: "audio", mediaPath: path });
    wa.save([m]);
    await readMediaOnline(wa, m, media());
    expect(wa.messages(m.chatId)[0].transcript).toBe("coming at five");
  });

  it("gets a photo's description from Gemini", async () => {
    const { dir, wa } = setup();
    const path = join(dir, "a.jpg");
    writeFileSync(path, "jpg");
    const m = msg("p", { mediaType: "image", mediaPath: path });
    wa.save([m]);
    const calls: { url: string; body: any }[] = [];
    const http = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "A  bill for\n₹500" }] } }] }));
    }) as unknown as typeof fetch;
    await readMediaOnline(wa, m, media(), http);
    expect(calls[0].url).toBe("https://g.test/v1beta/models/m:generateContent");
    expect(calls[0].body.contents[0].parts[1].inlineData.data).toBe(Buffer.from("jpg").toString("base64"));
    expect(wa.messages(m.chatId)[0].transcript).toBe("A bill for ₹500");
  });

  it("leaves the message unread when the service fails, so it goes on as [voice note] or [image]", async () => {
    const { dir, wa } = setup();
    const path = join(dir, "a.jpg");
    writeFileSync(path, "jpg");
    const m = msg("p", { mediaType: "image", mediaPath: path });
    wa.save([m]);
    const http = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    await expect(readMediaOnline(wa, m, media(), http)).rejects.toThrow(/Gemini 500/);
    await expect(readMediaOnline(wa, m, media({ gemini: { baseUrl: "x", model: "m" } }))).rejects.toThrow(/GEMINI_API_KEY/);
    expect(wa.messages(m.chatId)[0].transcript).toBeUndefined();
  });

  it("downloads history's voice notes only when told to, live ones always", () => {
    const { dir, wa } = setup();
    const base = { dataDir: dir, history: "recent" as const, voiceNotes: true, images: true, ignore: [], print: () => {} };
    const note = msg("v", { mediaType: "audio" });
    const online = new WhatsAppLink(wa, { ...base, historyVoice: false });
    expect(online.wantsMedia(note, false)).toBe(false);
    expect(online.wantsMedia(note, true)).toBe(true);
    expect(new WhatsAppLink(wa, base).wantsMedia(note, false)).toBe(true);
  });
});

describe("another device pulls what the link saved", () => {
  it("pages through messages in order, with names and numbers, and no hub paths", () => {
    const { wa } = setup();
    wa.save([msg("a", { chatId: "1@lid", senderId: "1@lid", chatName: "Varun", chatPhone: "919876543210", mediaPath: "/hub/a.ogg", transcript: "hi" }), msg("b", { ts: 101 }), msg("c", { ts: 102 })]);
    const first = wa.since(0, 2);
    expect(first.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(first.messages[0]).toMatchObject({ chatName: "Varun", chatPhone: "919876543210", transcript: "hi" });
    expect(first.messages[0].mediaPath).toBeUndefined();
    const second = wa.since(first.next, 2);
    expect(second.messages.map((m) => m.id)).toEqual(["c"]);
    expect(wa.since(second.next, 2)).toEqual({ messages: [], next: second.next });
  });

  it("saving a pulled message again keeps what this device already has", () => {
    const { wa } = setup();
    wa.save([msg("v", { mediaType: "audio", mediaPath: "/here/v.ogg" })]);
    wa.save([msg("v", { mediaType: "audio", transcript: "hello" })]);
    expect(wa.messages("91@s.whatsapp.net")[0]).toMatchObject({ mediaPath: "/here/v.ogg", transcript: "hello" });
  });
});
