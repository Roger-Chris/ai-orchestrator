import { router } from "expo-router";
import { Tabs } from "expo-router/js-tabs";
import type { ColorValue } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TabIcon, type TabIconName } from "../../components/TabIcon";
import { Button } from "../../components/ui";
import { useColors } from "../../lib/theme";

/**
 * Home, Work, Assistant, Chats and Devices along the bottom, each with an icon and a label; the open
 * one is filled and tinted. Insights is still a screen, opened from Home.
 */
export default function TabsLayout() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  // the theme's colors are hex strings, which TabIcon tints with an alpha suffix
  const icon = (name: TabIconName) => ({ color, focused }: { color: ColorValue; focused: boolean }) => <TabIcon name={name} color={String(color)} focused={focused} />;
  const action = (title: string, to: string) => ({
    headerRight: () => <Button small kind="primary" title={title} onPress={() => router.push(to as never)} />,
    headerRightContainerStyle: { paddingRight: 12 },
  });
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: c.bg },
        headerShadowVisible: false,
        headerTintColor: c.text,
        headerTitleStyle: { fontWeight: "700", fontSize: 20 },
        sceneStyle: { backgroundColor: c.bg },
        tabBarStyle: { backgroundColor: c.surface, borderTopColor: c.border, height: 64 + insets.bottom, paddingTop: 6, paddingBottom: insets.bottom + 6 },
        tabBarActiveTintColor: c.accent,
        tabBarInactiveTintColor: c.muted,
        tabBarLabelStyle: { fontSize: 12, fontWeight: "600", marginTop: 2 },
        tabBarItemStyle: { minHeight: 52 },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Home", headerShown: false, tabBarIcon: icon("home") }} />
      <Tabs.Screen name="work" options={{ title: "Work", tabBarIcon: icon("work"), ...action("+ Person", "/work-add") }} />
      <Tabs.Screen name="assistant" options={{ title: "Assistant", tabBarIcon: icon("assistant"), ...action("Talk", "/talk") }} />
      <Tabs.Screen name="chats" options={{ title: "Chats", tabBarIcon: icon("chats"), ...action("New", "/t/new") }} />
      <Tabs.Screen name="devices" options={{ title: "Devices", tabBarIcon: icon("devices") }} />
      <Tabs.Screen name="insights" options={{ title: "Insights", href: null }} />
    </Tabs>
  );
}
