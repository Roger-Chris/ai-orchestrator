import { authHeaders, connection, type RunEvent } from "./api";

/**
 * Follows a run's live events (Server-Sent Events). React Native's fetch can't stream, but
 * its XMLHttpRequest delivers text as it arrives, which is all SSE needs. Reconnects if the
 * connection drops (e.g. the phone switched networks) until the run ends or you leave.
 */
export function followRun(runId: string, onEvent: (ev: RunEvent) => void): () => void {
  let closed = false;
  let xhr: XMLHttpRequest | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastSeq = 0;

  const open = () => {
    const c = connection();
    if (!c || closed) return;
    let seen = 0;
    let buf = "";
    let ended = false;
    xhr = new XMLHttpRequest();
    xhr.open("GET", `${c.url}/api/runs/${runId}/events`);
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader("Accept", "text/event-stream");
    xhr.onprogress = () => {
      const text = xhr!.responseText;
      buf += text.slice(seen);
      seen = text.length;
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!data || data === "{}") continue;
        try {
          const ev = JSON.parse(data) as RunEvent;
          // After a reconnect the hub replays stored events: skip what we already had.
          if (ev.type !== "step.delta" && ev.seq <= lastSeq) continue;
          if (ev.type !== "step.delta") lastSeq = ev.seq;
          if (ev.type === "run.completed" || ev.type === "run.failed") ended = true;
          onEvent(ev);
        } catch {
          /* ignore a malformed frame */
        }
      }
    };
    const again = () => {
      if (!closed && !ended) retry = setTimeout(open, 3000);
    };
    xhr.onerror = again;
    xhr.onload = again;
    xhr.send();
  };

  open();
  return () => {
    closed = true;
    clearTimeout(retry);
    xhr?.abort();
  };
}
