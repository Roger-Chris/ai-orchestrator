import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { PROVIDER_IDS, type ProviderId, TASK_KINDS } from "../types.js";

export const AgentSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase-with-dashes"),
  description: z.string(),
  kind: z.enum(TASK_KINDS),
  /** Providers this agent works best on, best first. The router still decides. */
  prefer: z.array(z.enum(PROVIDER_IDS as [ProviderId, ...ProviderId[]])).default([]),
  permission: z.enum(["read", "edit", "full"]).optional(),
  /** Use the provider's deep model (if configured). */
  deep: z.boolean().default(false),
  system: z.string(),
});
export type Agent = z.infer<typeof AgentSchema> & { file?: string };

/** Loads every agents/*.yaml; later directories override earlier ones by name. */
export function loadAgents(dirs: string[]): Map<string, Agent> {
  const agents = new Map<string, Agent>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((n) => /\.ya?ml$/i.test(n)).sort()) {
      const file = join(dir, f);
      try {
        const agent = AgentSchema.parse(YAML.parse(readFileSync(file, "utf8")));
        agents.set(agent.name, { ...agent, file });
      } catch (e) {
        console.warn(`[agents] skipping ${file}: ${(e as Error).message.split("\n")[0]}`);
      }
    }
  }
  return agents;
}

export function agentCatalog(agents: Map<string, Agent>): string {
  return [...agents.values()].map((a) => `- ${a.name} (${a.kind}): ${a.description}`).join("\n");
}
