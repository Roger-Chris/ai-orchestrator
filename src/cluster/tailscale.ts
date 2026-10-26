import { runProcess } from "../providers/base.js";

export interface TailnetDevice {
  hostName: string;
  dnsName?: string;
  ips: string[];
  online: boolean;
  os?: string;
  self: boolean;
}

/** Lists devices on your tailnet via the local `tailscale` CLI. Empty if Tailscale is absent or logged out. */
export async function tailnetDevices(): Promise<TailnetDevice[]> {
  const r = await runProcess({ command: "tailscale", args: ["status", "--json"], timeoutMs: 8000 });
  if (r.spawnError || r.code !== 0) return [];
  let st: any;
  try {
    st = JSON.parse(r.stdout);
  } catch {
    return [];
  }
  if (st.BackendState && st.BackendState !== "Running") return [];
  const toDevice = (d: any, self: boolean): TailnetDevice => ({
    hostName: String(d.HostName ?? "").toLowerCase(),
    dnsName: d.DNSName ? String(d.DNSName).replace(/\.$/, "") : undefined,
    ips: d.TailscaleIPs ?? [],
    online: self || !!d.Online,
    os: d.OS,
    self,
  });
  const out: TailnetDevice[] = [];
  if (st.Self) out.push(toDevice(st.Self, true));
  for (const p of Object.values(st.Peer ?? {})) out.push(toDevice(p, false));
  return out;
}

/** This device's tailnet IPv4, for binding the server to the tailnet only. */
export async function tailscaleIPv4(): Promise<string | undefined> {
  const r = await runProcess({ command: "tailscale", args: ["ip", "-4"], timeoutMs: 8000 });
  if (r.spawnError || r.code !== 0) return undefined;
  return r.stdout.trim().split(/\s+/)[0] || undefined;
}
