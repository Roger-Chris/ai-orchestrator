import { afterEach, describe, expect, it, vi } from "vitest";
import { ONLY_WHEN_ASKED } from "../src/brain/capabilities.js";
import { parseConfig } from "../src/config.js";
import { HermesProvider } from "../src/providers/hermes.js";

const cfg = (over: Record<string, unknown> = {}) => parseConfig({ providers: { hermes: { apiKey: "hk", ...over } } }).providers.hermes;

afterEach(() => vi.unstubAllGlobals());

describe("Hermes", () => {
  it("runs through the API server and ignores its custom progress events", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const sse = [
        ": keepalive",
        "event: hermes.tool.progress",
        'data: {"tool":"web_search"}',
        'data: {"choices":[{"delta":{"content":"Done"}}]}',
        "data: [DONE]",
        "",
      ].join("\n");
      return new Response(sse, { status: 200 });
    });
    const r = await new HermesProvider(cfg()).run({ prompt: "Compare two laptops" });
    expect(r).toMatchObject({ ok: true, text: "Done", provider: "hermes", model: "hermes-agent" });
    expect(calls[0].url).toBe("http://127.0.0.1:8642/v1/chat/completions");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer hk");
  });

  it("is not set up without a key, and says how to start it when the container is down", async () => {
    const http = vi.fn(async () => { throw new Error("connection refused"); });
    vi.stubGlobal("fetch", http);
    const none = await new HermesProvider(cfg({ apiKey: undefined })).detect();
    expect(none).toMatchObject({ installed: false, authenticated: false });
    expect(none.detail).toMatch(/hermes\.sh/);
    expect(http).not.toHaveBeenCalled();
    const down = await new HermesProvider(cfg()).detect();
    expect(down).toMatchObject({ authenticated: false });
    expect(down.detail).toMatch(/docker start hermes/);
    expect(http).toHaveBeenCalledWith("http://127.0.0.1:8642/health", expect.anything());
  });

  it("is ready when the health check answers, and is never picked by a router on its own", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    expect(await new HermesProvider(cfg()).detect()).toMatchObject({ installed: true, authenticated: true });
    expect(ONLY_WHEN_ASKED).toContain("hermes");
  });
});
