/**
 * The two Groq calls a phone call needs: Whisper to turn the owner's voice into text, and a chat
 * model in JSON mode to decide what to say and do. Both are on Groq's free tier and use the same
 * keys as the Groq provider (GROQ_API_KEY / GROQ_API_KEYS), rotating past a limited or rejected key.
 */

export interface GroqVoiceOptions {
  baseUrl: string;
  keys: string[];
  /** Chat model for the decision (JSON mode). */
  model: string;
  /** Speech-to-text model. */
  transcribeModel: string;
  /** Called after each transcription (the tool registry counts Whisper's use as `whisper:groq`). */
  onTranscribe?: (ok: boolean, ms: number) => void;
}

export class GroqError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class GroqVoice {
  private keys: string[];
  private next = 0;

  constructor(
    private opts: GroqVoiceOptions,
    private http: typeof fetch = fetch,
  ) {
    this.keys = [...new Set(opts.keys.map((k) => k.trim()).filter(Boolean))];
  }

  get configured(): boolean {
    return this.keys.length > 0;
  }

  /** Text of a voice clip (m4a, webm, wav, mp3, ogg…). */
  async transcribe(audio: Blob, filename: string): Promise<string> {
    const started = Date.now();
    try {
      const text = await this.transcribeOnce(audio, filename);
      this.opts.onTranscribe?.(true, Date.now() - started);
      return text;
    } catch (e) {
      this.opts.onTranscribe?.(false, Date.now() - started);
      throw e;
    }
  }

  private async transcribeOnce(audio: Blob, filename: string): Promise<string> {
    const res = await this.post("/audio/transcriptions", () => {
      const form = new FormData();
      form.append("file", audio, filename);
      form.append("model", this.opts.transcribeModel);
      form.append("response_format", "json");
      form.append("temperature", "0");
      return { body: form, timeoutMs: 60_000 };
    });
    const body = (await res.json()) as { text?: string };
    return (body.text ?? "").trim();
  }

  /** The model's answer as a JSON string (JSON mode, not streamed). */
  async decide(system: string, prompt: string): Promise<string> {
    const res = await this.post("/chat/completions", () => ({
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.opts.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
        temperature: 0.3,
        max_tokens: 600,
      }),
      timeoutMs: 30_000,
    }));
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content ?? "";
  }

  private async post(path: string, make: () => { body: BodyInit; headers?: Record<string, string>; timeoutMs: number }): Promise<Response> {
    if (!this.keys.length) throw new GroqError("no Groq key on this hub (GROQ_API_KEY)", 409);
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}${path}`;
    let last = "";
    for (let i = 0; i < this.keys.length; i++) {
      const k = this.keys[this.next++ % this.keys.length];
      const { body, headers, timeoutMs } = make();
      let res: Response;
      try {
        res = await this.http(url, { method: "POST", headers: { ...headers, Authorization: `Bearer ${k}` }, body, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        throw new GroqError(`Groq did not answer (${(e as Error).message})`, 502);
      }
      if (res.ok) return res;
      last = `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`;
      // A limit or a rejected key: try the next key. Anything else is about the request.
      if (![401, 403, 429].includes(res.status)) break;
    }
    throw new GroqError(`Groq ${path}: ${last}`, 502);
  }
}
