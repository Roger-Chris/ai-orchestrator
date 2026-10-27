import { Api } from "./api";

/** Notifications need the app served over HTTPS (tailscale serve) and, on iPhone, added to the home screen. */
export function pushSupport(): { ok: boolean; why?: string } {
  if (!window.isSecureContext) return { ok: false, why: "Open the app over HTTPS (tailscale serve) to turn on notifications." };
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { ok: false, why: "This browser can't receive notifications here. On iPhone, add the app to your home screen first." };
  }
  return { ok: true };
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupport().ok) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function enablePush(): Promise<void> {
  const support = pushSupport();
  if (!support.ok) throw new Error(support.why);
  if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications are blocked for this site in your browser settings.");
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await Api.pushKey();
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
  await Api.pushSubscribe(sub.toJSON());
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await Api.pushUnsubscribe(sub.endpoint);
  await sub.unsubscribe();
}
