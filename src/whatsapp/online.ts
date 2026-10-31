import { readFileSync } from "node:fs";
import type { GroqVoice } from "../calls/groq.js";
import type { WaMessage, WaStore } from "./store.js";

/**
 * Reads a live voice note or photo with online services, for a device with no GPU
 * (`whatsapp.media: online`): Groq's Whisper hears voice notes, Gemini looks at photos. Only the one
 * message being forwarded is sent; history stays on the device that learns the style.
 */

const PHOTO_PROMPT =
  "Someone sent me this photo on WhatsApp. In one or two short sentences, say what it shows so I can reply to it: what or who is in it, and any short visible text copied exactly (prices, times, names). Plain text only.";

export interface OnlineMedia {
  voice: Pick<GroqVoice, "configured" | "transcribe">;
  gemini: { apiKey?: string; baseUrl: string; model: string };
}

export async function readMediaOnline(store: WaStore, m: WaMessage, o: OnlineMedia, http: typeof fetch = fetch): Promise<void> {
  if (!m.mediaPath) return;
  const bytes = readFileSync(m.mediaPath);
  if (m.mediaType === "image") return store.setTranscript(m.id, await describePhoto(bytes, o.gemini, http));
  if (!o.voice.configured) throw new Error("no Groq key for Whisper");
  store.setTranscript(m.id, await o.voice.transcribe(new Blob([bytes], { type: "audio/ogg" }), "voice.ogg"));
}

async function describePhoto(bytes: Buffer, g: OnlineMedia["gemini"], http: typeof fetch): Promise<string> {
  if (!g.apiKey) throw new Error("no GEMINI_API_KEY for photos");
  const res = await http(`${g.baseUrl.replace(/\/$/, "")}/models/${g.model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": g.apiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: PHOTO_PROMPT }, { inlineData: { mimeType: "image/jpeg", data: bytes.toString("base64") } }] }] }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join(" ").replace(/\s+/g, " ").trim();
  if (!text) throw new Error("Gemini saw nothing to say about the photo");
  return text.slice(0, 400);
}
