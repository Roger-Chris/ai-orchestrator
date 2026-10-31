import { deleteAsync, documentDirectory, getInfoAsync, makeDirectoryAsync, moveAsync, readAsStringAsync, writeAsStringAsync } from "expo-file-system/legacy";
import { AppState } from "react-native";
import { Api, onHubChange } from "./api";
import { sendAll, type Waiting } from "./sendqueue";

/**
 * Recordings waiting to reach the hub. A finished recording moves out of the recorder's temporary
 * file into the app's own folder and is listed in queue.json first, so closing the app, a dead
 * Tailscale or a restart loses nothing. It is sent again while the app is open, and the local copy goes
 * only after the hub said it has it. The id travels with it, so a retry after a lost answer is not a duplicate.
 */

const RETRY_MS = 30_000;
const dir = () => `${documentDirectory}recordings/`;
const index = () => `${dir()}queue.json`;

let waiting: Waiting[] = [];
let loaded = false;
let sending: Promise<void> | undefined;
const listeners = new Set<(w: Waiting[]) => void>();

function publish(next: Waiting[]) {
  waiting = next;
  for (const f of listeners) f(waiting);
}

async function save(next: Waiting[]) {
  await writeAsStringAsync(index(), JSON.stringify(next));
  publish(next);
}

async function load() {
  if (loaded) return;
  if (!(await getInfoAsync(dir())).exists) await makeDirectoryAsync(dir(), { intermediates: true });
  const info = await getInfoAsync(index());
  if (info.exists) {
    try {
      publish(JSON.parse(await readAsStringAsync(index())) as Waiting[]);
    } catch {
      publish([]); // an unreadable list: the files stay in the folder
    }
  }
  loaded = true;
}

/** Called with the list now and whenever it changes; returns how to stop listening. */
export function watchWaiting(f: (w: Waiting[]) => void): () => void {
  listeners.add(f);
  f(waiting);
  return () => void listeners.delete(f);
}

/** Keeps a finished recording safe, then tries to send it. */
export async function keepRecording(uri: string, seconds: number): Promise<void> {
  await load();
  const id = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const kept = `${dir()}${id}.${uri.split(".").pop() || "m4a"}`;
  await moveAsync({ from: uri, to: kept });
  await save([...waiting, { id, uri: kept, seconds, at: Date.now() }]);
  void sendWaiting();
}

export function sendWaiting(): Promise<void> {
  sending ??= (async () => {
    await load();
    if (!waiting.length) return;
    await sendAll(
      waiting,
      async (w) => {
        await Api.convoUpload(w.uri, w.seconds, w.id);
        await deleteAsync(w.uri, { idempotent: true }).catch(() => undefined);
      },
      save,
    );
  })()
    .catch(() => undefined)
    .finally(() => {
      sending = undefined;
    });
  return sending;
}

/** Runs for as long as the app is open (the root layout starts it). */
export function startSender(): () => void {
  void sendWaiting();
  const timer = setInterval(() => void sendWaiting(), RETRY_MS);
  const app = AppState.addEventListener("change", (s) => {
    if (s === "active") void sendWaiting();
  });
  const hub = onHubChange(() => void sendWaiting());
  return () => {
    clearInterval(timer);
    app.remove();
    hub();
  };
}
