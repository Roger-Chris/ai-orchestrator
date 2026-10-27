import * as Notifications from "expo-notifications";
import { Stack, router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { loadConnection } from "../lib/api";
import { routeFor } from "../lib/push";
import { useColors } from "../lib/theme";

export default function RootLayout() {
  const c = useColors();
  const [ready, setReady] = useState(false);
  const lastTap = Notifications.useLastNotificationResponse();

  useEffect(() => {
    loadConnection().then((conn) => {
      setReady(true);
      if (!conn) router.replace("/connect");
    });
  }, []);

  // Tapping a notification opens the conversation it is about.
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
        <Stack.Screen name="index" options={{ title: "Orchestrator" }} />
        <Stack.Screen name="connect" options={{ title: "Connect to your hub" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
        <Stack.Screen name="t/[id]" options={{ title: "Conversation" }} />
      </Stack>
    </SafeAreaProvider>
  );
}
