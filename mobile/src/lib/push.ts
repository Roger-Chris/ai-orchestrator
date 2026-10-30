import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { Api, registerPushEverywhere } from "./api";
import { speakNotice } from "./voice";

/** Built with a google-services.json? Without Firebase there is no way to receive pushes. */
export const pushBuiltIn = !!Constants.expoConfig?.extra?.firebase;

export const CHANNEL = "orchestrator";
/** The brain's alarms (level 3) and calls (level 4). Same id as ALARM_CHANNEL in src/server/fcm.ts. */
export const ALARM_CHANNEL = "alarm";

/**
 * Creates the app's channels. Android fixes a channel's sound and vibration when it is first
 * created (later changes are ignored; only the owner can change them in Settings), so the alarm
 * channel is loud from the start: max importance, alarm audio, long vibration, over Do Not Disturb
 * when Android allows it, shown on the lock screen. No permission is needed to create channels.
 */
export async function ensureChannels(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(CHANNEL, { name: "Agents need you", importance: Notifications.AndroidImportance.HIGH });
  await Notifications.setNotificationChannelAsync(ALARM_CHANNEL, {
    name: "Alarms and calls",
    description: "When your assistant decides something can't wait: rings and vibrates until you look.",
    importance: Notifications.AndroidImportance.MAX,
    sound: "default",
    audioAttributes: { usage: Notifications.AndroidAudioUsage.ALARM, contentType: Notifications.AndroidAudioContentType.SONIFICATION },
    enableVibrate: true,
    vibrationPattern: [0, 800, 400, 800, 400, 800, 400, 1200],
    bypassDnd: true,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    lightColor: "#4F46E5",
  });
}

// While the app is open, still show the notification (it may be about another conversation).
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

// U1: with Settings → Voice → "Say notices aloud" on, a notice that arrives while the app is open is also spoken.
Notifications.addNotificationReceivedListener((n) => void speakNotice(n.request.content.title, n.request.content.body).catch(() => {}));

/**
 * Turns on notifications for this phone: creates the channel, asks permission, and gives the
 * hub this phone's FCM token. Returns a sentence describing what happened.
 */
export async function enablePush(): Promise<string> {
  if (!pushBuiltIn) return "This build has no Firebase config, so it can't receive notifications. See the README: add google-services.json and rebuild.";
  // Android 13+ only shows the permission prompt once a channel exists.
  await ensureChannels();
  const perm = await Notifications.requestPermissionsAsync();
  if (!perm.granted) return "Notifications are off for this app. Allow them in Android Settings → Apps → Orchestrator → Notifications.";
  const { enabled } = await Api.fcmStatus();
  if (!enabled) return "The hub has no Firebase key yet, so it can't send notifications. Put fcm-service-account.json in the hub's folder and restart it.";
  const token = await Notifications.getDevicePushTokenAsync();
  await Api.registerFcm(String(token.data));
  await registerPushEverywhere(String(token.data)); // the backup hubs too, for when this one is down
  return "Notifications are on for this phone.";
}

/**
 * Where a tapped notification wants to go: the hub sends `url` like "/#/t/<thread>?run=<run>",
 * or "/#/call/<alert>" for an alarm or a call.
 */
export function routeFor(response: Notifications.NotificationResponse | null | undefined): string | undefined {
  const data = response?.notification.request.content.data as { url?: string } | undefined;
  const call = data?.url?.match(/#\/call\/(\d+)/);
  if (call) return `/call/${call[1]}`;
  const m = data?.url?.match(/#\/t\/([\w-]+)/);
  if (m) return `/t/${m[1]}`;
  // Screens that link themselves: "/builds?id=b1", "/agents", "/phone"
  const screen = data?.url?.match(/^\/(builds|agents|phone)(\?[\w=&%-]*)?$/);
  return screen ? data!.url : undefined;
}
