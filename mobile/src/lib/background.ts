import * as Battery from "expo-battery";
import Constants from "expo-constants";
import * as IntentLauncher from "expo-intent-launcher";
import { Platform } from "react-native";

/**
 * Notifications only arrive while the app is closed if Android lets it start in the background.
 * Android asks about battery optimization with a real dialog; Xiaomi/Redmi/POCO also have an
 * "Autostart" switch that no app can request, so we open that screen for you instead.
 */
const PACKAGE = Constants.expoConfig?.android?.package ?? "dev.rogerchris.orchestrator";

const constants = Platform.constants as { Manufacturer?: string; Brand?: string };
export const isXiaomi = Platform.OS === "android" && /xiaomi|redmi|poco/i.test(`${constants.Manufacturer ?? ""} ${constants.Brand ?? ""}`);

/** True when Android may stop the app in the background (and drop notifications). */
export async function batteryRestricted(): Promise<boolean> {
  if (Platform.OS !== "android") return false;
  try {
    return await Battery.isBatteryOptimizationEnabledAsync();
  } catch {
    return false;
  }
}

/** Shows Android's "Let app always run in background?" dialog. */
export async function askBatteryExemption(): Promise<void> {
  try {
    await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, { data: `package:${PACKAGE}` });
  } catch {
    // Some phones hide the dialog: fall back to the list where you can pick the app.
    await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
  }
}

/** Opens Xiaomi's Autostart list (turn Orchestrator on there), or the app's settings elsewhere. */
export async function openAutostart(): Promise<void> {
  const screens = [
    { packageName: "com.miui.securitycenter", className: "com.miui.permcenter.autostart.AutoStartManagementActivity" },
    { packageName: "com.miui.securitycenter", className: "com.miui.powercenter.PowerSettings" },
  ];
  for (const s of screens) {
    try {
      await IntentLauncher.startActivityAsync("android.intent.action.MAIN", s);
      return;
    } catch {
      /* not on this phone: try the next */
    }
  }
  await openAppSettings();
}

export async function openAppSettings(): Promise<void> {
  await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.APPLICATION_DETAILS_SETTINGS, { data: `package:${PACKAGE}` });
}
