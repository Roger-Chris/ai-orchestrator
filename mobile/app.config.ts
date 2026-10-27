/// <reference types="node" />
import { existsSync } from "node:fs";
import type { ExpoConfig } from "expo/config";

// Notifications need Firebase Cloud Messaging. Put your project's google-services.json next
// to this file to switch them on; without it the app builds and works, just without push.
const firebase = existsSync("./google-services.json");

const config: ExpoConfig = {
  name: "Orchestrator",
  slug: "orchestrator",
  version: "1.0.0",
  scheme: "orchestrator",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  android: {
    package: "dev.rogerchris.orchestrator",
    adaptiveIcon: {
      backgroundColor: "#4F46E5",
      foregroundImage: "./assets/android-icon-foreground.png",
      monochromeImage: "./assets/android-icon-monochrome.png",
    },
    ...(firebase ? { googleServicesFile: "./google-services.json" } : {}),
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-notifications", { icon: "./assets/notification-icon.png", color: "#4F46E5", defaultChannel: "orchestrator" }],
    // The hub is reached at http://<pc>:4317 over Tailscale, which encrypts the traffic itself.
    ["expo-build-properties", { android: { usesCleartextTraffic: true } }],
  ],
  experiments: { typedRoutes: true },
  extra: { firebase },
};

export default config;
