import type { ProviderStatus } from "../types.js";
import { OpenAICompatProvider } from "./openai-compat.js";

/**
 * A local model through Ollama (Jarvis R3): Ollama serves the OpenAI chat API at `<url>/v1`, so this
 * is the generic provider with no real key, and ready only when Ollama answers and has the model.
 */
export class LocalProvider extends OpenAICompatProvider {
  constructor(
    private url: string,
    model: string,
    private http: typeof fetch = fetch,
  ) {
    // Ollama ignores the key; the generic provider needs one to call at all.
    super("local", { baseUrl: `${url.replace(/\/+$/, "")}/v1`, apiKey: "ollama", model, deepModel: model }, "");
  }

  override async detect(): Promise<ProviderStatus> {
    const model = this.cfg.model;
    let names: string[];
    try {
      const res = await this.http(`${this.url.replace(/\/+$/, "")}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      names = (((await res.json()) as { models?: { name: string }[] }).models ?? []).map((m) => m.name);
    } catch {
      return { id: "local", installed: false, authenticated: false, detail: `Ollama is not running at ${this.url}` };
    }
    const have = names.some((n) => n === model || n === `${model}:latest`);
    return { id: "local", installed: true, authenticated: have, version: have ? model : undefined, detail: have ? `model ${model} (Ollama)` : `not pulled (ollama pull ${model})` };
  }
}
