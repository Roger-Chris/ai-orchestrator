import { describe, expect, it } from "vitest";
import { buildCapabilities } from "../src/brain/capabilities.js";
import { classify } from "../src/brain/classifier.js";
import { extractJson, normalizePlan } from "../src/brain/planner.js";
import { Router } from "../src/brain/router.js";
import { looksRateLimited, parseRetryAt } from "../src/providers/base.js";
import YAML from "yaml";
import { dropNulls, interpolateEnv, parseConfig } from "../src/config.js";
import { loadAgents } from "../src/agents/loader.js";
import { messagesToPrompt, modelToOptions } from "../src/server/app.js";
import { GeminiProvider } from "../src/providers/gemini.js";

const agents = loadAgents(["agents"]);

describe("classifier", () => {
  it.each([
    ["Design a KiCad schematic and PCB for an ESP32 board with USB-C", "pcb_design"],
    ["Make a parametric OpenSCAD enclosure I can 3D print", "cad_3d"],
    ["What is the latest news on solid-state batteries? cite sources", "research"],
    ["Fix this TypeError crash in my React app", "debugging"],
    ["Design the system architecture for a scalable chat backend", "system_design"],
    ["Create a wireframe and UX flow for onboarding", "ui_ux"],
    ["hi there", "quick"],
  ])("%s → %s", (task, kind) => {
    expect(classify(task).kind).toBe(kind);
  });

  it("marks multi-domain builds as complex", () => {
    const c = classify("Build a smart plant monitor device: design the PCB schematic, a 3D printed enclosure, and the mobile app UI, then research sensor prices");
    expect(c.complexity).toBe("complex");
    expect(c.alsoKinds.length).toBeGreaterThan(0);
  });
});

describe("router", () => {
  const router = new Router(buildCapabilities(), { localBias: 0.5, learn: true }, {
    feedbackStats: (kind) => (kind === "coding" ? { codex: { up: 20, down: 0 }, claude: { up: 0, down: 20 } } : {}),
  });
  const all = (["claude", "codex", "gemini", "perplexity"] as const).map((p) => ({ node: "me", provider: p, local: true, load: 0 }));

  it("sends research to Perplexity", () => {
    expect(router.rank({ kind: "research", needsWeb: true }, all)[0].provider).toBe("perplexity");
  });
  it("sends long context to Gemini", () => {
    expect(router.rank({ kind: "long_context" }, all)[0].provider).toBe("gemini");
  });
  it("never puts workspace steps on Perplexity or remote devices", () => {
    const cands = [...all, { node: "laptop", provider: "claude" as const, local: false, load: 0 }];
    const r = router.rank({ kind: "coding", needsWorkspace: true }, cands);
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((x) => x.provider !== "perplexity" && x.local)).toBe(true);
  });
  it("excludes the author's provider for cross-review", () => {
    expect(router.rank({ kind: "code_review", exclude: ["claude"] }, all).some((x) => x.provider === "claude")).toBe(false);
  });
  it("learns from ratings", () => {
    expect(router.rank({ kind: "coding" }, all)[0].provider).toBe("codex");
  });
  it("spreads load away from busy providers", () => {
    const busy = all.map((c) => (c.provider === "perplexity" ? { ...c, load: 3 } : c));
    expect(router.rank({ kind: "research", needsWeb: true }, busy)[0].provider).not.toBe("perplexity");
  });
  it("prefers a peer device when the local one is busy", () => {
    const cands = [
      { node: "me", provider: "claude" as const, local: true, load: 2 },
      { node: "laptop", provider: "claude" as const, local: false, load: 0 },
    ];
    expect(router.rank({ kind: "system_design" }, cands)[0].node).toBe("laptop");
  });
});

describe("planner parsing", () => {
  it("extracts JSON from fenced, chatty replies", () => {
    expect(extractJson('Sure!\n```json\n{"a": "b}"}\n```\nDone')).toEqual({ a: "b}" });
  });
  it("repairs plans: unknown agents, forward deps, duplicate ids", () => {
    const plan = normalizePlan(
      {
        steps: [
          { id: "a", title: "A", agent: "researcher", prompt: "p", dependsOn: ["b"] },
          { id: "b", title: "B", agent: "nope", kind: "cad_3d", prompt: "p", dependsOn: ["a"] },
          { id: "b", title: "B2", agent: "reviewer", prompt: "p", dependsOn: ["b"], differentFrom: ["b"] },
        ],
      },
      "t",
      classify("build a thing"),
      agents,
      8,
    );
    expect(plan.steps[0].dependsOn).toEqual([]); // forward dep dropped, so no cycle
    expect(plan.steps[1].agent).toBe("cad-modeler"); // unknown agent resolved by kind
    expect(plan.steps[1].dependsOn).toEqual(["a"]);
    expect(plan.steps[2].id).toBe("b_"); // duplicate id renamed
    expect(plan.steps[2].dependsOn).toEqual(["b"]);
    expect(plan.steps[2].differentFrom).toEqual(["b"]);
  });
});

describe("rate limits", () => {
  it("detects usage limits", () => {
    expect(looksRateLimited("You've hit your usage limit. Try again in 2 hours")).toBe(true);
    expect(looksRateLimited("syntax error")).toBe(false);
  });
  it("parses reset times", () => {
    const now = new Date("2026-01-01T10:00:00").getTime();
    expect(parseRetryAt("try again in 2 hours", now)).toBe(now + 2 * 3_600_000);
    expect(parseRetryAt("limit resets at 3pm", now)).toBe(new Date("2026-01-01T15:00:00").getTime());
  });
});

describe("config & API helpers", () => {
  it("interpolates env vars with defaults", () => {
    expect(interpolateEnv("a ${X} ${Y:-d}", { X: "1" })).toBe("a 1 d");
  });
  it("fills defaults; empty env secrets count as unset", () => {
    delete process.env.PERPLEXITY_API_KEY;
    delete process.env.ORC_TOKEN;
    const cfg = parseConfig({ server: { token: "" }, providers: { perplexity: { apiKey: "" } } });
    expect(cfg.server.port).toBe(4317);
    expect(cfg.server.token).toBeUndefined();
    expect(cfg.providers.perplexity.apiKey).toBeUndefined();
  });
  it("treats empty config values (unset ${VAR}) as not set", () => {
    const raw = YAML.parse(interpolateEnv("providers:\n  perplexity:\n    apiKey: ${NOPE_UNSET_KEY}\n", {}));
    expect(() => parseConfig(raw)).toThrow();
    expect(parseConfig(dropNulls(raw)).providers.perplexity.model).toBe("sonar-pro");
  });
  it("maps OpenAI model names", () => {
    expect(modelToOptions("gemini")).toEqual({ mode: "direct", provider: "gemini" });
    expect(modelToOptions("agent:pcb-designer")).toEqual({ mode: "direct", agent: "pcb-designer" });
    expect(modelToOptions("orchestrator")).toEqual({ mode: "auto" });
  });
  it("flattens chat history", () => {
    const r = messagesToPrompt([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: [{ type: "text", text: "again" }] },
    ]);
    expect(r.system).toBe("be brief");
    expect(r.prompt).toContain("User: again");
  });
  it("builds Antigravity CLI args per permission", () => {
    const g = new GeminiProvider(parseConfig({ providers: { gemini: { command: "agy" } } }).providers.gemini);
    expect(g.buildAgyArgs({ prompt: "x", permission: "read" })).not.toContain("--dangerously-skip-permissions");
    const edit = g.buildAgyArgs({ prompt: "x", permission: "edit", deep: true, timeoutMs: 90_000 });
    expect(edit[0]).toBe("-p=");
    expect(edit).toEqual(expect.arrayContaining(["--input-format", "stream-json", "--dangerously-skip-permissions", "--effort", "high"]));
    expect(edit.slice(edit.indexOf("--print-timeout"), edit.indexOf("--print-timeout") + 2)).toEqual(["--print-timeout", "2m"]);
  });
  it("loads all starter agents", () => {
    expect(agents.size).toBeGreaterThanOrEqual(15);
    expect(agents.get("pcb-designer")?.kind).toBe("pcb_design");
  });
});
