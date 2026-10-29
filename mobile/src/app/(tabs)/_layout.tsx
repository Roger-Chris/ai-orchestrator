import { router } from "expo-router";
import { Tabs } from "expo-router/js-tabs";
import { Button } from "../../components/ui";
import { useColors } from "../../lib/theme";

/** Home, Assistant, Chats, Insights and Devices, as plain text tabs along the bottom. */
export default function TabsLayout() {
  const c = useColors();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: c.bg },
        headerShadowVisible: false,
        headerTintColor: c.text,
        headerTitleStyle: { fontWeight: "600" },
        sceneStyle: { backgroundColor: c.bg },
        tabBarStyle: { backgroundColor: c.bg, borderTopColor: c.border },
        tabBarActiveTintColor: c.text,
        tabBarInactiveTintColor: c.muted,
        tabBarIconStyle: { display: "none" },
        tabBarLabelStyle: { fontSize: 14, fontWeight: "500" },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Home", headerShown: false }} />
      <Tabs.Screen
        name="assistant"
        options={{ title: "Assistant", headerRight: () => <Button small kind="primary" title="Talk" onPress={() => router.push("/talk" as never)} />, headerRightContainerStyle: { paddingRight: 12 } }}
      />
      <Tabs.Screen
        name="chats"
        options={{ title: "Chats", headerRight: () => <Button small kind="primary" title="New" onPress={() => router.push("/t/new")} />, headerRightContainerStyle: { paddingRight: 12 } }}
      />
      <Tabs.Screen name="insights" options={{ title: "Insights" }} />
      <Tabs.Screen name="devices" options={{ title: "Devices" }} />
    </Tabs>
  );
}
