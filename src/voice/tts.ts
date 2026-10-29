/**
 * Jarvis's voice: text in, audio out, from whichever speech service the hub has a key for.
 * OpenAI (`OPENAI_API_KEY`, gpt-4o-mini-tts), Gemini (`GEMINI_API_KEY`, the Interactions API's TTS
 * models) and Groq (the same keys as Whisper, Orpheus: 200 characters per request, so longer lines
 * are split at sentences and the WAVs joined). The phone uses its own TTS whenever this fails or
 * nothing is configured, so every error here is a reason to fall back, never a dead end.
 */

import type { Config } from "../config.js";

export const TTS_PROVIDERS = ["openai", "gemini", "groq"] as const;
export type TtsProviderId = (typeof TTS_PROVIDERS)[number];

export interface TtsVoiceInfo {
  id: string;
  label: string;
}

/** Voices offered in the app's Settings. Any other id the service accepts works too. */
export const VOICES: Record<TtsProviderId, TtsVoiceInfo[]> = {
  openai: [
    { id: "onyx", label: "Onyx (deep, male)" },
    { id: "ash", label: "Ash (calm, male)" },
    { id: "echo", label: "Echo (male)" },
    { id: "verse", label: "Verse (warm)" },
    { id: "alloy", label: "Alloy (neutral)" },
    { id: "sage", label: "Sage (female)" },
    { id: "coral", label: "Coral (bright, female)" },
    { id: "nova", label: "Nova (female)" },
    { id: "shimmer", label: "Shimmer (soft, female)" },
  ],
  gemini: [
    { id: "Charon", label: "Charon (informative, male)" },
    { id: "Kore", label: "Kore (firm, female)" },
    { id: "Puck", label: "Puck (upbeat, male)" },
    { id: "Fenrir", label: "Fenrir (excitable, male)" },
    { id: "Aoede", label: "Aoede (breezy, female)" },
    { id: "Zephyr", label: "Zephyr (bright, female)" },
  ],
  groq: [
    { id: "troy", label: "Troy (male)" },
    { id: "daniel", label: "Daniel (male)" },
    { id: "austin", label: "Austin (male)" },
    { id: "diana", label: "Diana (female)" },
    { id: "hannah", label: "Hannah (female)" },
    { id: "autumn", label: "Autumn (female)" },
  ],
};

export const PROVIDER_LABEL: Record<TtsProviderId, string> = { openai: "OpenAI", gemini: "Gemini", groq: "Groq (Orpheus)" };

export interface TtsOptions {
  /** "auto" tries every configured service in `order`; "off" leaves speaking to the phone. */
  provider: "auto" | "off" | TtsProviderId;
  order: TtsProviderId[];
  /** Longest text spoken in one request; longer text is cut at a sentence. */
  maxChars: number;
  openai: { apiKey?: string; baseUrl: string; model: string; voice: string; instructions?: string };
  gemini: { apiKey?: string; baseUrl: string; model: string; voice: string };
  groq: { keys: string[]; baseUrl: string; model: string; voice: string };
}

export interface Speech {
  audio: Uint8Array;
  mime: string;
  provider: TtsProviderId;
  voice: string;
}

export interface TtsStatus {
  enabled: boolean;
  /** The service and voice used when the app asks for none. */
  default: { provider: TtsProviderId; voice: string } | null;
  providers: { id: TtsProviderId; label: string; ready: boolean; restingUntil?: number; lastError?: string; voices: TtsVoiceInfo[]; voice: string }[];
}

export class TtsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const CACHE_SIZE = 24;

export class Tts {
  private resting = new Map<TtsProviderId, { until: number; error: string }>();
  private cache = new Map<string, Speech>();
  private groqNext = 0;

  constructor(
    private opts: TtsOptions,
    private http: typeof fetch = fetch,
    private now: () => number = Date.now,
    /** Called after every request to a service (for the tool registry's usage today). */
    private onUse?: (provider: TtsProviderId, ok: boolean, ms: number) => void,
  ) {}

  configured(id: TtsProviderId): boolean {
    if (id === "openai") return !!this.opts.openai.apiKey;
    if (id === "gemini") return !!this.opts.gemini.apiKey;
    return this.opts.groq.keys.some((k) => k.trim());
  }

  /** Services to try, in order: the one asked for first, then (on auto) the rest that have a key. */
  candidates(asked?: TtsProviderId): TtsProviderId[] {
    if (this.opts.provider === "off") return [];
    const base = this.opts.provider === "auto" ? this.opts.order : [this.opts.provider];
    const list = asked ? [asked, ...base.filter((p) => p !== asked)] : base;
    return [...new Set(list)].filter((p) => this.configured(p));
  }

  status(): TtsStatus {
    const ready = this.candidates().filter((p) => !this.isResting(p));
    const first = ready[0] ?? this.candidates()[0];
    return {
      enabled: this.candidates().length > 0,
      default: first ? { provider: first, voice: this.opts[first].voice } : null,
      providers: TTS_PROVIDERS.map((id) => {
        const r = this.resting.get(id);
        const resting = r && r.until > this.now();
        return {
          id,
          label: PROVIDER_LABEL[id],
          ready: this.configured(id) && this.opts.provider !== "off" && !resting,
          ...(resting ? { restingUntil: r.until } : {}),
          ...(r ? { lastError: r.error } : {}),
          voices: VOICES[id],
          voice: this.opts[id].voice,
        };
      }),
    };
  }

  /** Audio for `text`. Tries the asked service, then the others; throws TtsError(409) when none can speak. */
  async speak(text: string, choice: { provider?: TtsProviderId; voice?: string; format?: "mp3" | "wav" } = {}): Promise<Speech> {
    const line = fitLength(text.trim(), this.opts.maxChars);
    if (!line) throw new TtsError("nothing to say", 400);
    const order = this.candidates(choice.provider);
    if (!order.length) throw new TtsError("no speech service is set up on the hub (OPENAI_API_KEY, GEMINI_API_KEY or Groq keys); the phone speaks instead", 409);
    const errors: string[] = [];
    // A resting service is skipped until its rest is over, so a dead key costs one slow line, not every line.
    const ranked = order.filter((p) => !this.isResting(p));
    if (!ranked.length) throw new TtsError(`every speech service is resting after errors (${order.map((p) => `${PROVIDER_LABEL[p]}: ${this.resting.get(p)?.error}`).join("; ")}); the phone speaks instead`, 503);
    for (const provider of ranked) {
      // The asked voice belongs to the asked service; the others use their own default.
      const voice = provider === choice.provider && choice.voice ? choice.voice : this.opts[provider].voice;
      const format = choice.format ?? "mp3";
      const key = `${provider}|${voice}|${format}|${line}`;
      const hit = this.cache.get(key);
      if (hit) {
        this.cache.delete(key);
        this.cache.set(key, hit);
        return hit;
      }
      const started = this.now();
      try {
        const speech = await this.call(provider, voice, line, format);
        this.onUse?.(provider, true, this.now() - started);
        this.resting.delete(provider);
        this.cache.set(key, speech);
        if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
        return speech;
      } catch (e) {
        const err = e as TtsError;
        this.onUse?.(provider, false, this.now() - started);
        this.rest(provider, err);
        errors.push(`${PROVIDER_LABEL[provider]}: ${err.message}`);
      }
    }
    throw new TtsError(errors.join("; "), 502);
  }

  private isResting(p: TtsProviderId): boolean {
    return (this.resting.get(p)?.until ?? 0) > this.now();
  }

  /** A limit rests the service a minute; a rejected key or unknown model an hour; anything else 30 s. */
  private rest(p: TtsProviderId, e: TtsError) {
    const s = e.status ?? 502;
    const ms = s === 429 ? 60_000 : [400, 401, 403, 404].includes(s) ? 3_600_000 : 30_000;
    this.resting.set(p, { until: this.now() + ms, error: e.message.slice(0, 200) });
  }

  /** `format` only matters to OpenAI; Gemini and Groq always answer WAV (players that can't decode mp3 ask for wav). */
  private call(p: TtsProviderId, voice: string, text: string, format: "mp3" | "wav"): Promise<Speech> {
    if (p === "openai") return this.openai(voice, text, format);
    if (p === "gemini") return this.gemini(voice, text);
    return this.groq(voice, text);
  }

  private async post(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 30_000): Promise<Response> {
    let res: Response;
    try {
      res = await this.http(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new TtsError(`did not answer (${(e as Error).message})`, 502);
    }
    if (!res.ok) throw new TtsError(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`, res.status);
    return res;
  }

  private async openai(voice: string, text: string, format: "mp3" | "wav"): Promise<Speech> {
    const o = this.opts.openai;
    const res = await this.post(`${trim(o.baseUrl)}/audio/speech`, { Authorization: `Bearer ${o.apiKey}` }, {
      model: o.model,
      voice,
      input: text,
      response_format: format,
      ...(o.instructions ? { instructions: o.instructions } : {}),
    });
    return { audio: new Uint8Array(await res.arrayBuffer()), mime: format === "wav" ? "audio/wav" : "audio/mpeg", provider: "openai", voice };
  }

  /** Gemini's Interactions API: the audio comes back base64 in the model_output step (WAV, or raw 24 kHz PCM). */
  private async gemini(voice: string, text: string): Promise<Speech> {
    const g = this.opts.gemini;
    const res = await this.post(`${trim(g.baseUrl)}/interactions`, { "x-goog-api-key": g.apiKey! }, {
      model: g.model,
      input: [{ type: "user_input", content: [{ type: "text", text }] }],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice }] },
    });
    const body = (await res.json()) as GeminiReply;
    const b64 = geminiAudio(body);
    if (!b64) throw new TtsError("no audio in the answer", 502);
    const bytes = new Uint8Array(Buffer.from(b64, "base64"));
    return { audio: isWav(bytes) ? bytes : wavFromPcm([bytes]), mime: "audio/wav", provider: "gemini", voice };
  }

  /** Groq Orpheus takes 200 characters at a time: speak each piece and join the WAVs. */
  private async groq(voice: string, text: string): Promise<Speech> {
    const g = this.opts.groq;
    const keys = [...new Set(g.keys.map((k) => k.trim()).filter(Boolean))];
    const pcm: Uint8Array[] = [];
    let format: WavFormat | undefined;
    for (const piece of splitForLimit(text, 200)) {
      let res: Response | undefined;
      let last: TtsError | undefined;
      for (let i = 0; i < keys.length && !res; i++) {
        const k = keys[this.groqNext++ % keys.length];
        try {
          res = await this.post(`${trim(g.baseUrl)}/audio/speech`, { Authorization: `Bearer ${k}` }, { model: g.model, voice, input: piece, response_format: "wav" });
        } catch (e) {
          last = e as TtsError;
          if (![401, 403, 429].includes(last.status)) break; // only a limit or a bad key is worth the next key
        }
      }
      if (!res) throw last ?? new TtsError("no Groq key", 409);
      const wav = parseWav(new Uint8Array(await res.arrayBuffer()));
      if (!wav) throw new TtsError("Groq sent audio that isn't WAV", 502);
      format ??= wav.format;
      pcm.push(wav.data);
    }
    return { audio: wavFromPcm(pcm, format), mime: "audio/wav", provider: "groq", voice };
  }
}

interface GeminiReply {
  steps?: { type?: string; content?: { type?: string; data?: string }[] }[];
  candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[];
}

/** The last audio block of the model's output (Interactions API), or generateContent's inlineData. */
export function geminiAudio(body: GeminiReply): string | undefined {
  const blocks = (body.steps ?? []).filter((s) => s.type === "model_output").flatMap((s) => s.content ?? []).filter((c) => c.type === "audio" && c.data);
  if (blocks.length) return blocks[blocks.length - 1].data;
  return body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
}

const trim = (u: string) => u.replace(/\/+$/, "");

/** At most `max` characters, cut at the end of a sentence when there is one in the second half. */
export function fitLength(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return end > max / 2 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : max);
}

/** Pieces of at most `limit` characters: whole sentences where they fit, then words, then hard cuts. */
export function splitForLimit(text: string, limit: number): string[] {
  const sentences = text.match(/[^.!?]+(?:[.!?]+|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const out: string[] = [];
  let cur = "";
  const push = () => {
    if (cur) out.push(cur);
    cur = "";
  };
  for (const s of sentences) {
    if (s.length > limit) {
      push();
      for (const w of s.split(/\s+/)) {
        if (w.length > limit) {
          push();
          for (let i = 0; i < w.length; i += limit) out.push(w.slice(i, i + limit));
        } else if (!cur) cur = w;
        else if (cur.length + 1 + w.length <= limit) cur += ` ${w}`;
        else (push(), (cur = w));
      }
      push();
    } else if (!cur) cur = s;
    else if (cur.length + 1 + s.length <= limit) cur += ` ${s}`;
    else (push(), (cur = s));
  }
  push();
  return out;
}

export interface WavFormat {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
}

const GEMINI_PCM: WavFormat = { channels: 1, sampleRate: 24_000, bitsPerSample: 16 };

const isWav = (b: Uint8Array) => b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WAVE";
const ascii = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

/** The format and sample data of a PCM WAV file (walks the chunks; streaming WAVs may say size 0 or -1 for data). */
export function parseWav(b: Uint8Array): { format: WavFormat; data: Uint8Array } | undefined {
  if (!isWav(b)) return undefined;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let format: WavFormat | undefined;
  for (let at = 12; at + 8 <= b.length; ) {
    const id = ascii(b, at, 4);
    let size = v.getUint32(at + 4, true);
    if (id === "fmt ") format = { channels: v.getUint16(at + 10, true), sampleRate: v.getUint32(at + 12, true), bitsPerSample: v.getUint16(at + 22, true) };
    if (id === "data") {
      if (size === 0 || size === 0xffffffff || at + 8 + size > b.length) size = b.length - at - 8;
      return format ? { format, data: b.subarray(at + 8, at + 8 + size) } : undefined;
    }
    at += 8 + size + (size % 2);
  }
  return undefined;
}

/** One WAV file from raw PCM pieces of the same format. */
export function wavFromPcm(pieces: Uint8Array[], f: WavFormat = GEMINI_PCM): Uint8Array {
  const len = pieces.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(44 + len);
  const v = new DataView(out.buffer);
  const w = (at: number, s: string) => [...s].forEach((ch, i) => (out[at + i] = ch.charCodeAt(0)));
  const blockAlign = (f.channels * f.bitsPerSample) / 8;
  w(0, "RIFF");
  v.setUint32(4, 36 + len, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, f.channels, true);
  v.setUint32(24, f.sampleRate, true);
  v.setUint32(28, f.sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, f.bitsPerSample, true);
  w(36, "data");
  v.setUint32(40, len, true);
  let at = 44;
  for (const p of pieces) (out.set(p, at), (at += p.length));
  return out;
}

/** The hub's Tts from config (keys from .env through parseConfig; Groq shares the provider's keys). */
export function ttsFromConfig(config: Config, http?: typeof fetch, onUse?: (provider: TtsProviderId, ok: boolean, ms: number) => void): Tts {
  const t = config.tts;
  const groq = config.providers.groq;
  return new Tts(
    {
      provider: t.provider,
      order: t.order,
      maxChars: t.maxChars,
      openai: t.openai,
      gemini: t.gemini,
      groq: { keys: [...groq.apiKeys, groq.apiKey ?? ""], baseUrl: groq.baseUrl, model: t.groq.model, voice: t.groq.voice },
    },
    http,
    Date.now,
    onUse,
  );
}
