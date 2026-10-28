import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

/** The parts of a Firebase service-account key file we use. */
interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export class FcmError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The device token is no longer valid (app uninstalled or token rotated): forget it. */
    readonly gone: boolean,
  ) {
    super(message);
  }
}

/** The app's channels (mobile/src/lib/push.ts creates them with the same ids). */
export const DEFAULT_CHANNEL = "orchestrator";
/** Max importance, alarm sound, strong vibration: for the brain's level 3 (alarm) and 4 (call) alerts. */
export const ALARM_CHANNEL = "alarm";

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/**
 * Sends notifications to the Android app through Firebase Cloud Messaging (HTTP v1).
 * Signs its own OAuth token from the service-account key, so no Firebase SDK is needed.
 */
export class Fcm {
  private sa: ServiceAccount;
  private token?: { value: string; until: number };

  constructor(
    keyFile: string,
    private http: typeof fetch = fetch,
  ) {
    this.sa = JSON.parse(readFileSync(keyFile, "utf8"));
    if (!this.sa.project_id || !this.sa.client_email || !this.sa.private_key) throw new Error(`${keyFile} is not a Firebase service-account key`);
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now() + 60_000) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const aud = this.sa.token_uri ?? "https://oauth2.googleapis.com/token";
    const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: this.sa.client_email, scope: SCOPE, aud, iat: now, exp: now + 3600 }))}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.sa.private_key);
    const res = await this.http(aud, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(signature)}` }),
    });
    const body = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !body.access_token) throw new FcmError(`Google sign-in for FCM failed: ${body.error_description ?? res.status}`, res.status, false);
    this.token = { value: body.access_token, until: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  /**
   * A notification message (shown by Android even when the app is closed) on the app's channel,
   * with `url` in the data so tapping it opens the right conversation. Data-only messages were
   * silently dropped on Xiaomi/HyperOS in testing; notification messages arrive reliably.
   */
  async send(deviceToken: string, p: { title: string; body: string; url: string; tag: string; channel?: string }): Promise<void> {
    const channel = p.channel ?? DEFAULT_CHANNEL;
    // Alarms and calls: the app's loud channel, shown at full priority and on the lock screen.
    const loud = channel === ALARM_CHANNEL ? { notification_priority: "PRIORITY_MAX", visibility: "PUBLIC" } : {};
    const res = await this.http(`https://fcm.googleapis.com/v1/projects/${this.sa.project_id}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          notification: { title: p.title, body: p.body },
          android: { priority: "high", ttl: "3600s", notification: { channel_id: channel, tag: p.tag, ...loud } },
          data: { url: p.url, tag: p.tag },
        },
      }),
    });
    if (res.ok) return;
    const err = (await res.json().catch(() => ({}))) as { error?: { message?: string; status?: string; details?: { errorCode?: string }[] } };
    const code = err.error?.details?.find((d) => d.errorCode)?.errorCode ?? err.error?.status;
    throw new FcmError(`FCM: ${err.error?.message ?? res.status}`, res.status, code === "UNREGISTERED" || res.status === 404);
  }
}
