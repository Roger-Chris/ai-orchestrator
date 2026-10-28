import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { WaStore } from "./store.js";

/**
 * The two local models that read your chats on this device, so the raw messages never go to an
 * online service while your style is being learnt:
 * - Whisper (faster-whisper via tools/transcribe.py, run with uv) turns voice notes into text;
 * - an Ollama model (qwen3:8b by default) reads conversations and writes the style notes.
 */

export interface LocalModelOptions {
  ollamaUrl: string;
  model: string;
  whisperModel: string;
  /** Whisper language code, e.g. "ta"; empty detects it per voice note. */
  whisperLanguage: string;
  /** How to run the transcriber; "uv" needs uv on PATH (https://docs.astral.sh/uv/). */
  uv: string;
}

/** Asks the local model for JSON and parses it; undefined if the answer is not JSON. */
export async function ollamaJson<T>(o: Pick<LocalModelOptions, "ollamaUrl" | "model">, system: string, prompt: string, http: typeof fetch = fetch): Promise<T | undefined> {
  const res = await http(`${o.ollamaUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: o.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      format: "json",
      stream: false,
      think: false, // qwen3 would otherwise spend minutes thinking before every card
      // 8k context keeps qwen3:8b wholly on an 8 GB GPU; the cap stops a JSON answer that loops forever.
      options: { temperature: 0.2, num_ctx: 8192, num_predict: 1000 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${(await res.text()).slice(0, 200)}${res.status === 404 ? ` (run \`ollama pull ${o.model}\`)` : ""}`);
  const body = (await res.json()) as { message?: { content?: string } };
  return parseJson<T>(body.message?.content ?? "");
}

/** The JSON object in a model's answer, tolerating prose or code fences around it. */
export function parseJson<T>(text: string): T | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return undefined;
  }
}

/** Why the local model can't be used yet, or undefined when it can. */
export async function ollamaProblem(o: Pick<LocalModelOptions, "ollamaUrl" | "model">, http: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const res = await http(`${o.ollamaUrl.replace(/\/$/, "")}/api/tags`);
    const tags = ((await res.json()) as { models?: { name: string }[] }).models ?? [];
    const want = o.model.includes(":") ? o.model : `${o.model}:latest`;
    return tags.some((t) => t.name === want) ? undefined : `the model ${o.model} is not downloaded: run \`ollama pull ${o.model}\``;
  } catch {
    return `Ollama is not running at ${o.ollamaUrl} (install it from ollama.com and start it)`;
  }
}

/** Transcribes every downloaded voice note that has no transcript yet. */
export async function transcribe(store: WaStore, o: LocalModelOptions, log: (s: string) => void, root: string): Promise<{ done: number; failed: number }> {
  const notes = store.untranscribed().map((m) => ({ id: m.id, path: m.mediaPath! }));
  if (!notes.length) return { done: 0, failed: 0 };
  log(`Transcribing ${notes.length} voice note(s) with Whisper ${o.whisperModel} (the first run downloads the model)…`);
  const args = ["run", resolve(root, "tools", "transcribe.py"), "--model", o.whisperModel];
  if (o.whisperLanguage) args.push("--language", o.whisperLanguage);
  const child = spawn(o.uv, args, { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(JSON.stringify(notes));
  child.stderr.on("data", (d) => {
    for (const line of String(d).split(/\r?\n/)) if (line.startsWith("whisper:")) log(line);
  });
  let done = 0;
  let failed = 0;
  for await (const line of createInterface({ input: child.stdout })) {
    const r = parseJson<{ id: string; text?: string; error?: string }>(line);
    if (!r?.id) continue;
    if (r.error || r.text === undefined) failed++;
    else {
      store.setTranscript(r.id, r.text);
      done++;
      if (done % 25 === 0) log(`  ${done} of ${notes.length} transcribed`);
    }
  }
  const code = await new Promise<number>((r) => (child.exitCode !== null ? r(child.exitCode) : child.on("close", (c) => r(c ?? 1))));
  if (code !== 0 && !done) throw new Error(`the transcriber exited with code ${code}; run \`uv run tools/transcribe.py\` by hand to see why`);
  return { done, failed };
}
