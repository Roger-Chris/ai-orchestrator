import { resolve } from "node:path";
import type { Config } from "../config.js";
import { MemoryReplica, type Upstream } from "./replica.js";

/**
 * Where this device's replica syncs to. The machine running the brain talks to it directly
 * (127.0.0.1, BRAIN_TOKEN); every other device goes through that machine's hub.
 */
export function memoryUpstream(config: Config): Upstream | undefined {
  if (config.assistant.token) return { base: `${config.assistant.url.replace(/\/$/, "")}/memory`, token: config.assistant.token };
  if (config.sharedMemory.hub) return { base: `${config.sharedMemory.hub.replace(/\/$/, "")}/node/memory`, token: config.server.token };
  return undefined;
}

export function openReplica(config: Config): MemoryReplica | undefined {
  if (!config.sharedMemory.enabled) return undefined;
  return new MemoryReplica(resolve(config.dataDir, config.sharedMemory.file), config.node.name, memoryUpstream(config));
}
