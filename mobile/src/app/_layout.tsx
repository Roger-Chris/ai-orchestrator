import * as Notifications from "expo-notifications";
import { Stack, router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { loadConnection } from "../lib/api";
import { useWakeWord } from "../lib/wake";
import { ensureChannels, routeFor } from "../lib/push";
import { useColors } from "../lib/theme";

export default function RootLayout() {
  const c = useColors();
  const [ready, setReady] = useState(false);
  const lastTap = Notifications.useLastNotificationResponse();
  useWakeWord(); // "Hey Jarvis" while the app is open, when turned on in Settings → Voice

  useEffect(() => {
    // The alarm channel must exist before the first alarm arrives, also on phones that turned
    // notifications on before it was added.
    ensureChannels().catch(() => {});
    loadConnection().then((conn) => {
      setReady(true);
      if (!conn) router.replace("/connect");
    });
  }, []);

  // Tapping a notification opens the conversation it is about (or the call screen for an alarm).
  useEffect(() => {
    if (!ready || !lastTap || lastTap.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const to = routeFor(lastTap);
    if (to) router.push(to as never);
    Notifications.clearLastNotificationResponseAsync().catch(() => {});
  }, [ready, lastTap]);

  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.bg }}>
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: c.surface },
          headerTintColor: c.text,
          headerTitleStyle: { fontWeight: "700" },
          contentStyle: { backgroundColor: c.bg },
        }}
      >
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="connect" options={{ title: "Connect to your hub" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
        <Stack.Screen name="tasks" options={{ title: "Tasks" }} />
        <Stack.Screen name="memory" options={{ title: "Memory" }} />
        <Stack.Screen name="wa-chats" options={{ title: "WhatsApp chats" }} />
        <Stack.Screen name="ai-hub" options={{ title: "AI hub" }} />
        <Stack.Screen name="builds" options={{ title: "Builds" }} />
        <Stack.Screen name="phone" options={{ title: "Phone" }} />
        <Stack.Screen name="agents" options={{ title: "Outside agents" }} />
        <Stack.Screen name="update" options={{ title: "Update this app" }} />
        <Stack.Screen name="t/[id]" options={{ title: "Conversation" }} />
        <Stack.Screen name="talk" options={{ headerShown: false, animation: "fade" }} />
        <Stack.Screen name="call/[id]" options={{ headerShown: false, gestureEnabled: false, animation: "fade" }} />
      </Stack>
    </SafeAreaProvider>
  );
}
