import { mkdirSync, writeFileSync } from "node:fs";
import type { ApkRequest, ApkResult } from "../builds/preview.js";
import type { Config } from "../config.js";
import type { Candidate } from "../brain/router.js";
import type { ProviderPool } from "../providers/registry.js";
import { dirname, resolve } from "node:path";
import type { BranchJob, BranchResult, ProviderId, ProviderRequest, ProviderResult } from "../types.js";
import { runBranchJob } from "./branchwork.js";
import { tailnetDevices } from "./tailscale.js";

export const VERSION = "0.1.0";

export interface NodeProviderInfo {
  id: ProviderId;
  ready: boolean;
  load: number;
  coolingDownUntil?: number;
  detail?: string;
}

export interface NodeInfo {
  name: string;
  version: string;
  providers: NodeProviderInfo[];
  /** Takes coding steps on git branches (node.acceptBranchWork). */
  branchWork?: boolean;
  /** win32 / darwin / linux, so the app can tell the Mac mini from the laptop (D4). */
  platform?: string;
  /** Device actions are on (actions.enabled). */
  actions?: boolean;
}

export interface PeerState extends NodeInfo {
  url: string;
  online: boolean;
  lastSeen?: number;
  error?: string;
  via: "tailscale" | "config";
}

/** Wire format for POST /node/exec (one JSON object per line). */
export type ExecLine = { type: "delta"; text: string } | { type: "progress"; note: string } | { type: "result"; result: ProviderResult };
/** Wire format for POST /node/branch-job. */
export type BranchLine = { type: "delta"; text: string } | { type: "progress"; note: string } | { type: "result"; result: BranchResult };

export interface StreamHandlers {
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  onProgress?: (note: string) => void;
}

/**
 * Every device runs the same server. Each one advertises which subscriptions
 * it has logged in; the device you submit a task to (the hub) can send steps
 * to any peer. Peers are found on your tailnet automatically.
 */
export class Cluster {
  readonly peers = new Map<string, PeerState>();
  private timer?: NodeJS.Timeout;

  constructor(
    private config: Config,
    private pool: ProviderPool,
  ) {}

  get name() {
    return this.config.node.name;
  }

  async localInfo(): Promise<NodeInfo> {
    const status = await this.pool.status();
    return {
      name: this.name,
      version: VERSION,
      branchWork: this.config.node.acceptBranchWork,
      platform: process.platform,
      actions: this.config.actions.enabled,
      providers: status.map((s) => ({
        id: s.id,
        ready: s.installed && s.authenticated && !s.coolingDownUntil,
        load: this.pool.load(s.id),
        coolingDownUntil: s.coolingDownUntil,
        detail: s.detail,
      })),
    };
  }

  start() {
    if (!this.config.cluster.enabled) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.config.cluster.pollSeconds * 1000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  private headers(): Record<string, string> {
    return this.config.server.token ? { Authorization: `Bearer ${this.config.server.token}` } : {};
  }

  /** Discovers peers (tailnet + configured URLs) and refreshes their health. */
  async refresh(): Promise<void> {
    const targets = new Map<string, PeerState["via"]>();
    for (const u of this.config.cluster.peers) targets.set(u.replace(/\/$/, ""), "config");
    if (this.config.cluster.tailscale) {
      for (const d of await tailnetDevices()) {
        if (d.self || !d.online) continue;
        const ip = d.ips.find((i) => i.includes(".")) ?? d.ips[0];
        if (ip) targets.set(`http://${ip}:${this.config.server.port}`, "tailscale");
      }
    }

    await Promise.all(
      [...targets].map(async ([url, via]) => {
        try {
          const res = await fetch(`${url}/node/info`, { headers: this.headers(), signal: AbortSignal.timeout(4000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const info = (await res.json()) as NodeInfo;
          if (info.name === this.name) return; // ourselves via another address
          this.peers.set(info.name, { ...info, url, via, online: true, lastSeen: Date.now() });
        } catch (e) {
          // Tailnet devices that don't run the orchestrator are simply not peers.
          const known = [...this.peers.values()].find((p) => p.url === url);
          if (known) Object.assign(known, { online: false, error: (e as Error).message });
        }
      }),
    );
  }

  /** Every (device, provider) pair that can take work right now. */
  async candidates(): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const local = await this.pool.available();
    // The device you submit from can always do branch work: you asked it to.
    for (const p of local) out.push({ node: this.name, provider: p, local: true, load: this.pool.load(p), branchWork: true });
    for (const peer of this.peers.values()) {
      if (!peer.online) continue;
      for (const p of peer.providers) {
        if (p.ready) out.push({ node: peer.name, provider: p.id, local: false, load: p.load, branchWork: !!peer.branchWork });
      }
    }
    return out;
  }

  /** Runs a provider call on this device or a peer. */
  async run(node: string, provider: ProviderId, req: ProviderRequest): Promise<ProviderResult> {
    if (node === this.name) return this.pool.run(provider, req);
    const peer = this.peers.get(node);
    if (!peer?.online) return { ok: false, text: "", provider, durationMs: 0, error: `device ${node} is offline` };
    // Optimistic local view of the peer's load until the next poll.
    const slot = peer.providers.find((p) => p.id === provider);
    if (slot) slot.load += 0.5;
    try {
      return await this.runRemote(peer, provider, req);
    } finally {
      if (slot) slot.load = Math.max(0, slot.load - 0.5);
    }
  }

  /** Runs a coding step on its own git branch, on this device or a peer. */
  async runBranch(node: string, job: BranchJob, h: StreamHandlers = {}): Promise<BranchResult> {
    const failed = (error: string): BranchResult => ({ ok: false, branch: job.branch, base: job.base, changedFiles: [], diffStat: "", diff: "", pushed: false, durationMs: 0, error });
    if (node === this.name) {
      return runBranchJob(job, {
        pool: this.pool,
        workRoot: resolve(this.config.node.workRoot),
        nodeName: this.name,
        testTimeoutMs: this.config.branches.testTimeoutMinutes * 60_000,
        fixAttempts: this.config.branches.fixAttempts,
        ...h,
      });
    }
    const peer = this.peers.get(node);
    if (!peer?.online) return failed(`device ${node} is offline`);
    if (!peer.branchWork) return failed(`device ${node} does not accept branch work (node.acceptBranchWork)`);
    const slot = peer.providers.find((p) => p.id === job.provider);
    if (slot) slot.load += 0.5;
    try {
      const r = await this.stream<BranchResult>(peer, "/node/branch-job", job, h);
      return "error" in r && !("branch" in r) ? failed(r.error) : (r as BranchResult);
    } finally {
      if (slot) slot.load = Math.max(0, slot.load - 0.5);
    }
  }

  /**
   * Builds an Android APK on a peer that has the Android SDK (POST /node/apk-build, streamed so a
   * long Gradle build keeps the connection alive), then copies the APK to `dest` on this device.
   */
  async buildApk(node: string, req: ApkRequest, dest: string): Promise<ApkResult> {
    const peer = this.peers.get(node);
    if (!peer?.online) return { ok: false, error: `device ${node} is offline (the APK is built there)`, log: "" };
    const r = await this.stream<ApkResult>(peer, "/node/apk-build", req, {});
    if (!("ok" in r)) return { ok: false, error: r.error, log: "" };
    if (!r.ok) return r;
    try {
      const res = await fetch(`${peer.url}/node/apk-build/${encodeURIComponent(req.id)}/app.apk`, { headers: this.headers(), signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok) return { ...r, ok: false, error: `copying the APK from ${node}: HTTP ${res.status}` };
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      return { ...r, apkFile: dest };
    } catch (e) {
      return { ...r, ok: false, error: `copying the APK from ${node}: ${(e as Error).message}` };
    }
  }

  /** POSTs to a peer and reads its NDJSON stream of deltas, progress notes and one result. */
  private async stream<T>(peer: PeerState, path: string, body: unknown, h: StreamHandlers): Promise<T | { error: string }> {
    let res: Response;
    try {
      res = await fetch(`${peer.url}${path}`, {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: h.signal,
      });
    } catch (e) {
      peer.online = false;
      return { error: `device ${peer.name}: ${(e as Error).message}` };
    }
    if (!res.ok || !res.body) return { error: `device ${peer.name}: HTTP ${res.status}` };
    let result: T | undefined;
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as { type: string; text?: string; note?: string; result?: T };
          if (msg.type === "delta") h.onDelta?.(msg.text!);
          else if (msg.type === "progress") h.onProgress?.(msg.note!);
          else if (msg.type === "result") result = msg.result;
        }
      }
    } catch (e) {
      return { error: `device ${peer.name} stream: ${(e as Error).message}` };
    }
    return result ?? { error: `device ${peer.name} sent no result` };
  }

  private async runRemote(peer: PeerState, provider: ProviderId, req: ProviderRequest): Promise<ProviderResult> {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(`${peer.url}/node/exec`, {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          prompt: req.prompt,
          system: req.system,
          model: req.model,
          deep: req.deep,
          permission: req.permission,
          timeoutMs: req.timeoutMs,
        }),
        signal: req.signal,
      });
    } catch (e) {
      peer.online = false;
      return { ok: false, text: "", provider, durationMs: Date.now() - started, error: `device ${peer.name}: ${(e as Error).message}` };
    }
    if (!res.ok || !res.body) {
      return { ok: false, text: "", provider, durationMs: Date.now() - started, error: `device ${peer.name}: HTTP ${res.status}` };
    }

    let result: ProviderResult | undefined;
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          const msg = JSON.parse(line) as ExecLine;
          if (msg.type === "delta") req.onDelta?.(msg.text);
          else if (msg.type === "progress") req.onProgress?.(msg.note);
          else if (msg.type === "result") result = msg.result;
        }
      }
    } catch (e) {
      return { ok: false, text: "", provider, durationMs: Date.now() - started, error: `device ${peer.name} stream: ${(e as Error).message}` };
    }
    if (result?.rateLimited) {
      const slot = peer.providers.find((p) => p.id === provider);
      if (slot) slot.ready = false;
    }
    return result ?? { ok: false, text: "", provider, durationMs: Date.now() - started, error: `device ${peer.name} sent no result` };
  }

  list(): PeerState[] {
    return [...this.peers.values()];
  }
}
