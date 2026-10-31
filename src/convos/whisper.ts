import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

/** One recording through the laptop's Whisper (tools/transcribe.py, the same script as voice notes). */
export async function whisperFile(path: string, o: { uv: string; whisperModel: string; whisperLanguage: string }, root: string): Promise<{ text: string; language?: string }> {
  const args = ["run", resolve(root, "tools", "transcribe.py"), "--model", o.whisperModel];
  if (o.whisperLanguage) args.push("--language", o.whisperLanguage);
  const child = spawn(o.uv, args, { stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<number | null>((ok, no) => {
    child.on("error", no);
    child.on("close", ok);
  });
  child.stdin.end(JSON.stringify([{ id: "convo", path }]));
  let err = "";
  child.stderr.on("data", (d) => (err = `${err}${d}`.slice(-600)));
  let out: { text?: string; language?: string; error?: string } | undefined;
  for await (const line of createInterface({ input: child.stdout })) {
    try {
      out = JSON.parse(line);
    } catch {
      /* not one of ours */
    }
  }
  const code = await closed;
  if (out?.error) throw new Error(`Whisper: ${out.error}`);
  if (!out || code !== 0) throw new Error(`Whisper exited with code ${code}: ${err.trim()}`);
  return { text: out.text ?? "", language: out.language };
}
