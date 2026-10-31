import type { Cluster } from "../cluster/cluster.js";
import type { Config } from "../config.js";
import type { ProviderPool } from "../providers/registry.js";
import type { Notifier } from "../server/push.js";
import type { MemoryReplica } from "../shared/replica.js";
import type { Store } from "../store/db.js";
import { ActionLog } from "./log.js";
import type { ActionContext } from "./registry.js";
import { ActionHub, type ActRequest, type ActResponse, ActionRunner, type ApprovalCheck, ApprovalDesk } from "./desk.js";

/** Actions on this device, approvals kept here, and calls to peers over the tailnet. */
export function buildActions(
  config: Config,
  d: { store: Store; pool?: ProviderPool; replica?: MemoryReplica; cluster?: Cluster; notifier?: Notifier; fetchFn?: typeof fetch; extra?: Pick<ActionContext, "files" | "sendFile"> },
): ActionHub {
  const fetchFn = d.fetchFn ?? fetch;
  const headers = { "Content-Type": "application/json", ...(config.server.token ? { Authorization: `Bearer ${config.server.token}` } : {}) };
  const desk = new ApprovalDesk(d.store.db, config, (title, body, id) => {
    void d.notifier?.notify({ title, body, url: "/", tag: `approval:${id}` }).catch(() => undefined);
  });
  // An approval is checked where it was made: here, on the Linux hub (sharedMemory.hub), or with no hub set, on the online peers.
  const check: ApprovalCheck = async (id, action, hash, node) => {
    if (desk.get(id)) return desk.claim(id, action, hash, node);
    const hub = config.sharedMemory.hub?.replace(/\/$/, "");
    const holders = hub ? [hub] : (d.cluster?.list() ?? []).filter((p) => p.online).map((p) => p.url.replace(/\/$/, ""));
    for (const at of holders) {
      const res = await fetchFn(`${at}/node/approvals/${encodeURIComponent(id)}/claim`, {
        method: "POST",
        headers,
        body: JSON.stringify({ action, hash, node }),
        signal: AbortSignal.timeout(15_000),
      }).catch(() => undefined);
      if (res?.ok && ((await res.json()) as { valid: boolean }).valid === true) return true;
    }
    return false;
  };
  const runner = new ActionRunner(config, { pool: d.pool, replica: d.replica, check, extra: d.extra });
  const peer = async (node: string, req: ActRequest): Promise<ActResponse> => {
    const p = d.cluster?.list().find((x) => x.name === node);
    if (!p) return { status: "refused", node, action: req.action, error: `device ${node} is not known (is \`orc serve\` running there?)` };
    if (!p.online) return { status: "refused", node, action: req.action, error: `device ${node} is offline` };
    const res = await fetchFn(`${p.url}/node/act`, { method: "POST", headers, body: JSON.stringify(req), signal: AbortSignal.timeout(35 * 60_000) });
    if (!res.ok) return { status: "refused", node, action: req.action, error: `HTTP ${res.status} from ${node}` };
    return (await res.json()) as ActResponse;
  };
  return new ActionHub(runner, desk, peer, new ActionLog(d.store));
}
