import * as IntentLauncher from "expo-intent-launcher";
import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import { Api, type PhoneAction } from "./api";

/**
 * Doing a phone action from the assistant (Jarvis D3) when the owner taps Do it. Android only lets a
 * visible app start these. Calls and texts open the dialer or the composer filled in; the owner
 * presses call or send there. Nothing is dialled or sent from here.
 */

/** Common app names -> Android package; anything else needs `package`. */
const PACKAGES: Record<string, string> = {
  whatsapp: "com.whatsapp", youtube: "com.google.android.youtube", maps: "com.google.android.apps.maps", "google maps": "com.google.android.apps.maps",
  chrome: "com.android.chrome", gmail: "com.google.android.gm", spotify: "com.spotify.music", calendar: "com.google.android.calendar",
  "google calendar": "com.google.android.calendar", photos: "com.google.android.apps.photos", drive: "com.google.android.apps.docs",
  telegram: "org.telegram.messenger", instagram: "com.instagram.android", clock: "com.google.android.deskclock", orchestrator: "dev.rogerchris.orchestrator",
};

export function packageFor(app: string, pkg?: string): string | undefined {
  return pkg ?? PACKAGES[app.trim().toLowerCase()];
}

export async function doPhoneAction(p: PhoneAction): Promise<void> {
  const a = p.action;
  switch (a.kind) {
    case "alarm":
      await IntentLauncher.startActivityAsync("android.intent.action.SET_ALARM", {
        extra: { "android.intent.extra.alarm.HOUR": a.hour, "android.intent.extra.alarm.MINUTES": a.minute, "android.intent.extra.alarm.MESSAGE": a.label ?? "Jarvis", "android.intent.extra.alarm.SKIP_UI": true },
      });
      break;
    case "reminder": {
      const at = new Date(a.at);
      if (Number.isNaN(at.getTime()) || at.getTime() < Date.now()) throw new Error("That time has already passed.");
      await Notifications.scheduleNotificationAsync({ content: { title: "Reminder", body: a.text }, trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, channelId: "orchestrator" } });
      break;
    }
    case "open_app": {
      const pkg = packageFor(a.app, a.package);
      if (!pkg) throw new Error(`I don't know ${a.app}'s Android package name; ask with its package (e.g. com.example.app).`);
      IntentLauncher.openApplication(pkg);
      break;
    }
    case "call":
      await Linking.openURL(`tel:${a.number.replace(/[^\d+]/g, "")}`);
      break;
    case "sms":
      await Linking.openURL(`sms:${a.number.replace(/[^\d+]/g, "")}?body=${encodeURIComponent(a.text)}`);
      break;
    case "file":
      await Linking.openURL(Api.hubUrl(`/f/${p.fileKey}`));
      break;
  }
  await Api.phoneDone(p.id);
}
