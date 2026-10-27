import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { Api } from "./api";

/** Built with a google-services.json? Without Firebase there is no way to receive pushes. */
export const pushBuiltIn = !!Constants.expoConfig?.extra?.firebase;

export const CHANNEL = "orchestrator";

// While the app is open, still show the notification (it may be about another conversation).
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

/**
 * Turns on notifications for this phone: creates the channel, asks permission, and gives the
 * hub this phone's FCM token. Returns a sentence describing what happened.
 */
export async function enablePush(): Promise<string> {
  if (!pushBuiltIn) return "This build has no Firebase config, so it can't receive notifications. See the README: add google-services.json and rebuild.";
  if (Platform.OS === "android") {
    // Android 13+ only shows the permission prompt once a channel exists.
    await Notifications.setNotificationChannelAsync(CHANNEL, { name: "Agents need you", importance: Notifications.AndroidImportance.HIGH });
  }
  const perm = await Notifications.requestPermissionsAsync();
  if (!perm.granted) return "Notifications are off for this app. Allow them in Android Settings → Apps → Orchestrator → Notifications.";
  const { enabled } = await Api.fcmStatus();
  if (!enabled) return "The hub has no Firebase key yet, so it can't send notifications. Put fcm-service-account.json in the hub's folder and restart it.";
  const token = await Notifications.getDevicePushTokenAsync();
  await Api.registerFcm(String(token.data));
  return "Notifications are on for this phone.";
}

/** Where a tapped notification wants to go: the hub sends `url` like "/#/t/<thread>?run=<run>". */
export function routeFor(response: Notifications.NotificationResponse | null | undefined): string | undefined {
  const data = response?.notification.request.content.data as { url?: string } | undefined;
  const m = data?.url?.match(/#\/t\/([\w-]+)/);
  return m ? `/t/${m[1]}` : undefined;
}
