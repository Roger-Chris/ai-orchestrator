import { useEffect, useState } from "react";
import { Api, getToken, LABEL, type NodeInfo, setToken } from "./api";
import { currentSubscription, disablePush, enablePush, pushSupport } from "./push";

export function Settings({ onTokenSaved }: { onTokenSaved: () => void }) {
  return (
    <div className="page">
      <h1>Settings</h1>
      <TokenCard onSaved={onTokenSaved} />
      <NotificationsCard />
      <DevicesCard />
      <UsageCard />
      <InstallCard />
    </div>
  );
}

export function TokenCard({ onSaved }: { onSaved: () => void }) {
  const [value, setValue] = useState(getToken());
  return (
    <section className="card">
      <h2>Access token</h2>
      <p className="muted small">Paste the ORC_TOKEN from the .env file on your hub PC. This device keeps it; other devices need it too.</p>
      <div className="row">
        <input type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="ORC_TOKEN" />
        <button
          className="primary"
          onClick={() => {
            setToken(value);
            onSaved();
          }}
        >
          Save
        </button>
      </div>
    </section>
  );
}

function NotificationsCard() {
  const support = pushSupport();
  const [on, setOn] = useState(false);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    currentSubscription().then((s) => setOn(!!s)).catch(() => {});
  }, []);
  const run = async (fn: () => Promise<unknown>, after: string) => {
    setMsg("");
    try {
      await fn();
      setMsg(after);
      setOn(!!(await currentSubscription()));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <section className="card">
      <h2>Notifications</h2>
      <p className="muted small">Get a notification on this device when an agent asks you something, a step is paused for you, a design needs approval, or a run finishes.</p>
      {!support.ok ? (
        <p className="small bad">{support.why}</p>
      ) : (
        <div className="actions">
          {on ? (
            <button className="ghost" onClick={() => run(disablePush, "Notifications are off on this device.")}>
              Turn off
            </button>
          ) : (
            <button className="primary" onClick={() => run(enablePush, "Notifications are on.")}>
              Turn on
            </button>
          )}
          <button className="ghost" disabled={!on} onClick={() => run(async () => Api.pushTest(), "Test sent.")}>
            Send a test
          </button>
        </div>
      )}
      {msg && <p className="small">{msg}</p>}
    </section>
  );
}

function DevicesCard() {
  const [nodes, setNodes] = useState<{ self: NodeInfo; peers: NodeInfo[] }>();
  const [error, setError] = useState("");
  const load = (refresh = false) =>
    Api.nodes(refresh)
      .then(setNodes)
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(t);
  }, []);
  return (
    <section className="card">
      <div className="row between">
        <h2>Devices &amp; models</h2>
        <button className="ghost small" onClick={() => load(true)}>
          Refresh
        </button>
      </div>
      {error && <p className="small bad">{error}</p>}
      {nodes && [nodes.self, ...nodes.peers].map((n, i) => <NodeRow key={n.name} node={n} self={i === 0} />)}
      {nodes && !nodes.peers.length && <p className="muted small">No other devices yet. Run the orchestrator on another computer on your tailnet with the same ORC_TOKEN.</p>}
    </section>
  );
}

function NodeRow({ node, self }: { node: NodeInfo; self: boolean }) {
  return (
    <div className="node">
      <div className="row between">
        <strong>{node.name}</strong>
        <span className="muted small">
          {self ? "hub" : node.online === false ? "offline" : `via ${node.via}`}
          {node.branchWork ? " · takes branch work" : ""}
        </span>
      </div>
      <div className="chips">
        {node.providers.map((p) => (
          <span key={p.id} className="chip" title={p.coolingDownUntil ? `usage limit, back at ${new Date(p.coolingDownUntil).toLocaleTimeString()}` : (p.detail ?? "")}>
            <span className={`dot ${p.ready ? "ok" : p.coolingDownUntil ? "warn" : "err"}`} />
            {LABEL[p.id] ?? p.id}
            {p.load > 0 ? ` · ${Math.round(p.load * 100)}%` : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

function UsageCard() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof Api.usage>>>([]);
  useEffect(() => {
    Api.usage().then(setRows).catch(() => {});
  }, []);
  return (
    <section className="card">
      <h2>Usage, last 7 days</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th>Model</th>
              <th>Device</th>
              <th>Calls</th>
              <th>Failed</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.day}${r.provider}${r.node}`}>
                <td>{r.day}</td>
                <td>{LABEL[r.provider] ?? r.provider}</td>
                <td>{r.node}</td>
                <td>{r.calls}</td>
                <td>{r.failed}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={5} className="muted">
                  No calls yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function InstallCard() {
  return (
    <section className="card">
      <h2>Put it on your home screen</h2>
      <ul className="small">
        <li>Android (Chrome): menu ⋮ → Install app.</li>
        <li>iPhone (Safari): Share → Add to Home Screen. Notifications on iPhone only work from the home-screen app.</li>
        <li>Both need the HTTPS address from <code>tailscale serve</code> on the hub.</li>
      </ul>
    </section>
  );
}
