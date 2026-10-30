import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { insideRoots, roots } from "../actions/registry.js";
import type { Config } from "../config.js";
import type { MemoryReplica } from "../shared/replica.js";
import { type FileHit, FileIndex, type IndexedFile, scanRoots } from "./index.js";

/**
 * This device's side of the file index and file copies (Jarvis D2). On the hub (no
 * `sharedMemory.hub` set) the index lives here; every other device sends its list to the hub and
 * asks the hub when searching. Copies go straight to the other device (`/node/files/receive`).
 */

export interface FileClientDeps {
  config: Config;
  /** The hub's index; only on the hub. */
  index?: FileIndex;
  replica?: MemoryReplica;
  /** Online peers by name -> URL. */
  peers?: () => { name: string; url: string; online: boolean }[];
  fetchFn?: typeof fetch;
}

export class FileClient {
  private timer?: NodeJS.Timeout;
  constructor(private d: FileClientDeps) {}

  private get node() {
    return this.d.config.node.name;
  }
  private get hub() {
    return this.d.config.sharedMemory.hub?.replace(/\/$/, "");
  }
  private headers(json = true): Record<string, string> {
    const t = this.d.config.server.token;
    return { ...(json ? { "Content-Type": "application/json" } : {}), ...(t ? { Authorization: `Bearer ${t}` } : {}) };
  }
  private fetch() {
    return this.d.fetchFn ?? fetch;
  }

  async search(q: string, opts: { node?: string; ext?: string; limit?: number } = {}): Promise<FileHit[]> {
    if (this.d.index) return this.d.index.search(q, opts);
    if (!this.hub) throw new Error("no hub to search (sharedMemory.hub)");
    const qs = new URLSearchParams({ q, ...(opts.node ? { node: opts.node } : {}), ...(opts.ext ? { ext: opts.ext } : {}), limit: String(opts.limit ?? 30) });
    const res = await this.fetch()(`${this.hub}/api/files/search?${qs}`, { headers: this.headers(false), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`hub: HTTP ${res.status}`);
    return (await res.json()) as FileHit[];
  }

  /** Walks this device's roots and stores (hub) or sends (other devices) the list. */
  async reindex(): Promise<{ files: number; roots: string[]; truncated: boolean }> {
    const rs = roots(this.d.config).filter(existsSync);
    const { files, truncated } = scanRoots(rs, this.d.config.files.maxFiles);
    await this.receiveIndex(this.node, rs, files, truncated);
    return { files: files.length, roots: rs, truncated };
  }

  /** On the hub: a device's list arrived (or this hub's own). Elsewhere: send it to the hub. */
  async receiveIndex(node: string, rs: string[], files: IndexedFile[], truncated: boolean) {
    if (this.d.index) {
      this.d.index.replace(node, rs, files, truncated);
      // The shared memory knows each device's files at a glance; the full list stays in the hub's table.
      try {
        const uid = `device:${node.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
        const cur = this.d.replica?.get(uid);
        this.d.replica?.put({
          uid,
          kind: "device",
          title: cur?.title || node,
          body: cur?.body ?? "",
          data: { ...(cur?.data ?? {}), fileIndex: { files: files.length, roots: rs, indexedAt: new Date().toISOString(), truncated, searchOn: "hub /api/files/search" } },
          source: cur?.source ?? "orchestrator",
        });
      } catch {
        /* memory is best-effort */
      }
      return;
    }
    if (!this.hub) throw new Error("no hub to send the file list to (sharedMemory.hub)");
    const res = await this.fetch()(`${this.hub}/node/files/index`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ node, roots: rs, files, truncated }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`hub refused the file list: HTTP ${res.status}`);
  }

  /** Copies bytes to another device (or this one) under its first assistant folder. Returns the path written there. */
  async sendFile(node: string, relPath: string, bytes: Buffer): Promise<string> {
    if (node === this.node) return receiveFile(this.d.config, relPath, bytes);
    const peer = this.d.peers?.().find((p) => p.name === node);
    if (!peer) throw new Error(`device ${node} is not known`);
    if (!peer.online) throw new Error(`device ${node} is offline`);
    const res = await this.fetch()(`${peer.url}/node/files/receive?path=${encodeURIComponent(relPath)}`, {
      method: "POST",
      headers: { ...this.headers(false), "Content-Type": "application/octet-stream" },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(30 * 60_000),
    });
    const out = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
    if (!res.ok || !out.path) throw new Error(`${node} refused it: ${out.error ?? `HTTP ${res.status}`}`);
    return out.path;
  }

  start() {
    const h = this.d.config.files.indexHours;
    const go = () => void this.reindex().catch((e) => console.warn(`file index: ${(e as Error).message}`));
    setTimeout(go, 30_000).unref();
    if (h > 0) this.timer = setInterval(go, h * 3_600_000);
    this.timer?.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

/**
 * Writes a received file inside this device's first assistant folder. Never replaces anything:
 * an existing name becomes "name (2).ext", "name (3).ext"…
 */
export function receiveFile(config: Config, relPath: string, bytes: Buffer): string {
  const rel = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel || rel.split("/").includes("..")) throw new Error("bad path");
  const base = roots(config).find(existsSync) ?? roots(config)[0];
  let target = insideRoots(join(base, rel), config, false);
  const ext = extname(target);
  const stem = target.slice(0, target.length - ext.length);
  for (let n = 2; existsSync(target); n++) target = `${stem} (${n})${ext}`;
  insideRoots(target, config, false);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, { flag: "wx" });
  return target;
}

