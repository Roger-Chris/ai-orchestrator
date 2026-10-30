import { type AudioPlayer, createAudioPlayer } from "expo-audio";
import * as SecureStore from "expo-secure-store";
import * as Speech from "expo-speech";
import { api, authHeaders, connection } from "./api";

/**
 * How Jarvis sounds. "auto" uses the hub's speech service (OpenAI / Gemini / Groq, `GET /api/tts`)
 * when it has one and the phone's own voice otherwise; "hub" and "phone" pin one. Whatever the hub
 * can't say (no key, a limit, no network) is said by the phone instead, so speech never just stops.
 */
export interface VoiceChoice {
  engine: "auto" | "hub" | "phone";
  /** Hub service and voice; empty = the hub's default. */
  provider?: string;
  voice?: string;
  /** An Android TTS voice identifier; empty = the phone's default. */
  phoneVoice?: string;
  /** Listen for "Hey Jarvis" while the app is open (lib/wake.ts). */
  wakeWord?: boolean;
  /** Say notifications aloud while the app is open (approvals, builds ready, alerts). */
  speakNotices?: boolean;
}

/** What a notice says aloud: its title and text, without the hub's emoji. */
export function noticeLine(title?: string | null, body?: string | null): string {
  return [title, body]
    .filter(Boolean)
    .join(". ")
    .replace(/\p{Extended_Pictographic}\uFE0F?/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

/** Speaks a notice that arrived while the app is open, when Settings → Voice → Say notices aloud is on. */
export async function speakNotice(title?: string | null, body?: string | null) {
  await load();
  if (!choice.speakNotices) return;
  const line = noticeLine(title, body);
  if (line) await speak(line);
}

export interface HubTts {
  enabled: boolean;
  default: { provider: string; voice: string } | null;
  providers: { id: string; label: string; ready: boolean; restingUntil?: number; lastError?: string; voices: { id: string; label: string }[]; voice: string }[];
}

export const SPEAK_LANG = "en-IN";
const KEY = "orc.voice";
const HUB_TIMEOUT_MS = 12_000;

let choice: VoiceChoice = { engine: "auto" };
const voiceWatchers = new Set<(v: VoiceChoice) => void>();

export function watchVoice(fn: (v: VoiceChoice) => void): () => void {
  voiceWatchers.add(fn);
  return () => void voiceWatchers.delete(fn);
}
let loaded: Promise<void> | null = null;
let hubStatus: { at: number; tts: HubTts | null } | null = null;
let player: AudioPlayer | null = null;
let stopCurrent: (() => void) | null = null;
/** Bumped by every speak/stop, so a line still being prepared when you interrupt is never played. */
let generation = 0;

function load(): Promise<void> {
  loaded ??= SecureStore.getItemAsync(KEY)
    .then((raw) => {
      if (raw) choice = { ...choice, ...(JSON.parse(raw) as VoiceChoice) };
    })
    .catch(() => {});
  return loaded;
}

export async function getVoiceChoice(): Promise<VoiceChoice> {
  await load();
  return choice;
}

export async function setVoiceChoice(next: VoiceChoice) {
  choice = next;
  voiceWatchers.forEach((w) => w(next));
  await SecureStore.setItemAsync(KEY, JSON.stringify(next));
}

/** What the hub can say (cached a minute; `fresh` re-asks). Null when the hub is too old or unreachable. */
export async function hubTts(fresh = false): Promise<HubTts | null> {
  if (!fresh && hubStatus && Date.now() - hubStatus.at < 60_000) return hubStatus.tts;
  const tts = await api<HubTts>("/api/tts", { timeoutMs: 8_000 }).catch(() => null);
  hubStatus = { at: Date.now(), tts };
  return tts;
}

/** English voices installed on the phone, Indian English first. */
export async function phoneVoices(): Promise<{ id: string; label: string }[]> {
  const all = await Speech.getAvailableVoicesAsync().catch(() => []);
  return all
    .filter((v) => v.language?.toLowerCase().startsWith("en"))
    .sort((a, b) => Number(b.language === SPEAK_LANG) - Number(a.language === SPEAK_LANG) || a.language.localeCompare(b.language) || a.name.localeCompare(b.name))
    .map((v) => ({ id: v.identifier, label: `${v.name} (${v.language})` }));
}

function phoneSay(text: string): Promise<void> {
  return new Promise((done) => {
    stopCurrent = () => void Speech.stop().catch(() => {});
    Speech.speak(text, { language: SPEAK_LANG, voice: choice.phoneVoice || undefined, rate: 1.0, onDone: () => done(), onStopped: () => done(), onError: () => done() });
  });
}

/** Plays the hub's audio for `text`. Resolves "done" or "stopped"; "failed" means the phone should say it. */
function hubSay(text: string): Promise<"done" | "stopped" | "failed"> {
  const conn = connection();
  if (!conn) return Promise.resolve("failed");
  const q = new URLSearchParams({ text });
  if (choice.provider) q.set("provider", choice.provider);
  if (choice.provider && choice.voice) q.set("voice", choice.voice);
  return new Promise((done) => {
    let settled = false;
    const p = createAudioPlayer({ uri: `${conn.url}/api/tts/audio?${q}`, headers: authHeaders() });
    player = p;
    const finish = (how: "done" | "stopped" | "failed") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sub.remove();
      try {
        p.remove();
      } catch {
        /* already gone */
      }
      if (player === p) player = null;
      done(how);
    };
    // Nothing loaded in time (hub slow, service down): let the phone say it rather than wait.
    const timer = setTimeout(() => finish("failed"), HUB_TIMEOUT_MS);
    const sub = p.addListener("playbackStatusUpdate", (s) => {
      if (s.error) return finish("failed");
      if (s.isLoaded) clearTimeout(timer);
      if (s.didJustFinish) finish("done");
    });
    stopCurrent = () => finish("stopped");
    p.play();
  });
}

/** Says `text` aloud with the chosen voice; anything still being said is cut off first. Resolves when it ends or is stopped. */
export async function speak(text: string): Promise<void> {
  stopSpeaking();
  const mine = generation;
  if (!text.trim()) return;
  await load();
  const useHub = choice.engine === "hub" || (choice.engine === "auto" && !!(await hubTts())?.providers.some((p) => p.ready));
  if (mine !== generation) return;
  if (useHub) {
    const r = await hubSay(text);
    if (r !== "failed" || mine !== generation) return;
    hubStatus = null; // re-check next time; this line goes to the phone
  }
  await phoneSay(text);
}

export function stopSpeaking() {
  generation++;
  const stop = stopCurrent;
  stopCurrent = null;
  stop?.();
  Speech.stop().catch(() => {});
}
