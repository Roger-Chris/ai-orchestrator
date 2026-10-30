import type { Config } from "../config.js";
import type { ProviderStatus } from "../types.js";
import { OpenAICompatProvider } from "./openai-compat.js";

type HermesConfig = Config["providers"]["hermes"];

/**
 * Hermes Agent (Nous Research) through its API server's `/v1/chat/completions`. Each request is a
 * full agent run with Hermes' own tools, inside its container (deploy/linux/hermes.sh). Commands
 * that need approval are denied there, because API sessions have nobody to ask. Hermes reaches the
 * owner's devices and memory only through `/mcp`, with its own outside-agent token and scopes.
 */
export class HermesProvider extends OpenAICompatProvider {
  constructor(private hermes: HermesConfig) {
    super("hermes", hermes, "Optional. Run deploy/linux/hermes.sh on the hub: it starts Hermes Agent in a container and sets HERMES_API_KEY.");
  }

  async detect(): Promise<ProviderStatus> {
    const status = await super.detect();
    if (!status.authenticated) return { ...status, installed: false };
    const url = `${this.hermes.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/health`;
    const running = await fetch(url, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
    return running ? status : { ...status, installed: false, authenticated: false, detail: `Hermes is not answering at ${url}: docker start hermes` };
  }
}
