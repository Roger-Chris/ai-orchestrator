import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Agent, Api, type RunOptions, type RunRecord, type Thread, Unauthorized } from "./api";
import { Composer } from "./Composer";
import { ago } from "./md";
import { RunCard } from "./RunCard";
import { Settings, TokenCard } from "./Settings";

type Route = { name: "home" } | { name: "thread"; id: string; run?: string } | { name: "run"; id: string } | { name: "settings" };

function parseHash(): Route {
  const h = location.hash.replace(/^#/, "");
  const [path, query] = h.split("?");
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "t" && parts[1]) return { name: "thread", id: parts[1], run: new URLSearchParams(query).get("run") ?? undefined };
  if (parts[0] === "r" && parts[1]) return { name: "run", id: parts[1] };
  if (parts[0] === "settings") return { name: "settings" };
  return { name: "home" };
}

export const go = (hash: string) => {
  location.hash = hash;
};

function useRoute(): Route {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

type Active = Awaited<ReturnType<typeof Api.active>>;

export function App() {
  const route = useRoute();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [active, setActive] = useState<Active>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [locked, setLocked] = useState(false);
  const [menu, setMenu] = useState(false);

  const load = useCallback(async () => {
    try {
      const [t, a] = await Promise.all([Api.threads(), Api.active()]);
      setThreads(t);
      setActive(a);
      setLocked(false);
    } catch (e) {
      if (e instanceof Unauthorized) setLocked(true);
    }
  }, []);

  useEffect(() => {
    void load();
    Api.agents().then(setAgents).catch(() => {});
    const t = window.setInterval(() => void load(), 8000);
    const onVisible = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  useEffect(() => setMenu(false), [route]);

  const needsYou = active.filter((r) => r.status === "waiting" || r.status === "awaiting_approval");
  const busyThreads = useMemo(() => new Map(active.map((r) => [r.threadId, r.status])), [active]);

  if (locked) {
    return (
      <div className="locked">
        <h1>
          <span className="logo">◈</span> Orchestrator
        </h1>
        <TokenCard onSaved={() => void load()} />
      </div>
    );
  }

  return (
    <div className={`shell ${menu ? "menu-open" : ""}`}>
      <aside className="side">
        <div className="side-top">
          <a className="brand" href="#/">
            <span className="logo">◈</span> Orchestrator
          </a>
          <a className="primary btn" href="#/">
            New
          </a>
        </div>
        <nav className="threads" aria-label="Conversations">
          {threads.map((t) => {
            const status = busyThreads.get(t.id);
            const current = route.name === "thread" && route.id === t.id;
            return (
              <a key={t.id} href={`#/t/${t.id}`} className={`thread ${current ? "current" : ""}`} aria-current={current ? "page" : undefined}>
                <span className={`dot ${status === "waiting" || status === "awaiting_approval" ? "warn" : status ? "busy" : "idle"}`} aria-hidden />
                <span className="t">{t.title}</span>
                <span className="muted small">{ago(t.updatedAt)}</span>
              </a>
            );
          })}
          {!threads.length && <p className="muted small pad">No conversations yet.</p>}
        </nav>
        <a className={`side-link ${route.name === "settings" ? "current" : ""}`} href="#/settings">
          ⚙ Settings &amp; devices
        </a>
      </aside>
      <div className="scrim" onClick={() => setMenu(false)} />

      <main className="main">
        <header className="topbar">
          <button className="ghost icon" onClick={() => setMenu(true)} aria-label="Conversations">
            ☰
          </button>
          <span className="topbar-title">
            {route.name === "thread" ? (threads.find((t) => t.id === route.id)?.title ?? "Conversation") : route.name === "settings" ? "Settings" : "New conversation"}
          </span>
        </header>

        {needsYou.length > 0 && !(route.name === "thread" && needsYou.every((r) => r.threadId === route.id)) && (
          <div className="banner">
            <b>{needsYou.length === 1 ? "An agent needs you" : `${needsYou.length} runs need you`}:</b>{" "}
            {needsYou.slice(0, 3).map((r) => (
              <a key={r.id} href={r.threadId ? `#/t/${r.threadId}?run=${r.id}` : `#/r/${r.id}`}>
                {r.task.slice(0, 60)}
              </a>
            ))}
          </div>
        )}

        {route.name === "settings" && <Settings onTokenSaved={() => void load()} />}
        {route.name === "home" && <Home agents={agents} onCreated={load} />}
        {route.name === "thread" && <ThreadView key={route.id} id={route.id} focusRun={route.run} agents={agents} onChange={load} />}
        {route.name === "run" && <SingleRun id={route.id} />}
      </main>
    </div>
  );
}

function Home({ agents, onCreated }: { agents: Agent[]; onCreated: () => void }) {
  const send = async (text: string, o: RunOptions) => {
    const t = await Api.newThread();
    await Api.send(t.id, text, o);
    onCreated();
    go(`#/t/${t.id}`);
  };
  return (
    <div className="convo">
      <div className="messages empty">
        <div className="hello">
          <h1>What should the agents work on?</h1>
          <p className="muted">The brain picks the right models and devices, asks you when it must, and you can step in at any point.</p>
          <div className="examples">
            {[
              "Design an ESP32-S3 sensor board with USB-C, then a 3D-printable enclosure for it",
              "@researcher Compare the three cheapest LiPo charger ICs with sources",
              "Review the auth code in my project for security problems",
            ].map((e) => (
              <button key={e} className="example" onClick={() => void send(e.replace(/^@(\S+)\s/, ""), e.startsWith("@") ? { agent: e.slice(1).split(" ")[0], mode: "direct", ask: true } : { ask: true })}>
                {e}
              </button>
            ))}
          </div>
        </div>
      </div>
      <Composer agents={agents} onSend={send} />
    </div>
  );
}

function ThreadView({ id, focusRun, agents, onChange }: { id: string; focusRun?: string; agents: Agent[]; onChange: () => void }) {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null);

  const load = useCallback(
    () =>
      Api.thread(id)
        .then((r) => setRuns(r.runs))
        .catch((e) => setError((e as Error).message)),
    [id],
  );
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (focusRun) document.getElementById(`run-${focusRun}`)?.scrollIntoView({ block: "start" });
    else end.current?.scrollIntoView({ block: "end" });
  }, [runs.length, focusRun]);

  const send = async (text: string, o: RunOptions) => {
    const run = await Api.send(id, text, o);
    setRuns((r) => [...r, run]);
    onChange();
  };

  return (
    <div className="convo">
      <div className="messages">
        {error && <div className="error">{error}</div>}
        {runs.map((r) => (
          <div key={r.id} id={`run-${r.id}`} className="turn">
            <div className="you">{r.task}</div>
            <RunCard initial={r} onSettled={onChange} />
          </div>
        ))}
        <div ref={end} />
      </div>
      <Composer agents={agents} onSend={send} />
    </div>
  );
}

function SingleRun({ id }: { id: string }) {
  const [run, setRun] = useState<RunRecord>();
  useEffect(() => {
    Api.run(id).then(setRun).catch(() => {});
  }, [id]);
  if (!run) return <div className="page muted">Loading…</div>;
  return (
    <div className="page">
      <div className="you">{run.task}</div>
      <RunCard initial={run} />
    </div>
  );
}
