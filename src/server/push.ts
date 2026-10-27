import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";
import type { Store } from "../store/db.js";
import { type Fcm, FcmError } from "./fcm.js";
import type { RunEventType, RunRecord, StepRecord } from "../types.js";

/** Push services want a contact for the sender; any https URL or mailto: works. */
const CONTACT = "https://github.com/Roger-Chris/ai-orchestrator";

export interface PushPayload {
  title: string;
  body: string;
  /** Where the app opens when you tap the notification. */
  url: string;
  tag: string;
}

/**
 * Phone notifications (Web Push) for when something needs you. Keys are made once
 * per hub and kept in the data folder; subscriptions come from the app.
 */
export class Notifier {
  readonly publicKey: string;

  constructor(
    private store: Store,
    dataDir: string,
    private send: (sub: webpush.PushSubscription, payload: string) => Promise<unknown> = (sub, payload) => webpush.sendNotification(sub, payload, { TTL: 3600 }),
    /** The Android app's channel; absent until a Firebase service-account key is configured. */
    readonly fcm?: Pick<Fcm, "send">,
  ) {
    const file = join(dataDir, "vapid.json");
    let keys: { publicKey: string; privateKey: string };
    if (existsSync(file)) keys = JSON.parse(readFileSync(file, "utf8"));
    else {
      keys = webpush.generateVAPIDKeys();
      writeFileSync(file, JSON.stringify(keys), { mode: 0o600 });
    }
    webpush.setVapidDetails(CONTACT, keys.publicKey, keys.privateKey);
    this.publicKey = keys.publicKey;
  }

  subscribe(sub: webpush.PushSubscription) {
    this.store.addPushSub(sub.endpoint, sub);
  }

  unsubscribe(endpoint: string) {
    this.store.removePushSub(endpoint);
  }

  /** The Android app registers its FCM device token here. */
  subscribeFcm(token: string) {
    this.store.addPushSub(`fcm:${token}`, { type: "fcm", token });
  }

  async notify(p: PushPayload): Promise<number> {
    let sent = 0;
    for (const { endpoint, sub } of this.store.pushSubs()) {
      try {
        if (sub.type === "fcm") {
          if (!this.fcm) continue;
          await this.fcm.send(sub.token, p);
        } else await this.send(sub, JSON.stringify(p));
        sent++;
      } catch (e) {
        // Gone or no longer valid: the phone unsubscribed or the app was removed.
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410 || (e instanceof FcmError && e.gone)) this.store.removePushSub(endpoint);
        else console.warn(`notification not sent: ${(e as Error).message}`);
      }
    }
    return sent;
  }

  /** The orchestrator's "needs you" hook. */
  attention = (run: RunRecord, step: StepRecord | undefined, type: RunEventType) => {
    const p = payloadFor(run, step, type);
    if (p) void this.notify(p);
  };
}

export function payloadFor(run: RunRecord, step: StepRecord | undefined, type: RunEventType): PushPayload | undefined {
  const url = run.threadId ? `/#/t/${run.threadId}?run=${run.id}` : `/#/r/${run.id}`;
  const task = run.task.length > 80 ? `${run.task.slice(0, 79)}…` : run.task;
  const base = { url, tag: `${run.id}:${step?.id ?? type}` };
  switch (type) {
    case "step.question":
      return { ...base, title: `${step?.agent ?? "An agent"} has a question`, body: step?.question?.slice(0, 200) ?? task };
    case "step.review":
      return { ...base, title: `Check: ${step?.title ?? "a step"}`, body: `Paused for you. Continue, edit or redo. (${task})` };
    case "design.review_ready":
      return { ...base, title: "Design ready for your decision", body: task };
    case "run.completed":
      return { ...base, title: "Done", body: task };
    case "run.failed":
      return { ...base, title: "Run failed", body: `${task}: ${run.error?.slice(0, 120) ?? ""}` };
    default:
      return undefined;
  }
}
