import { BlurTargetView } from "expo-blur";
import { router } from "expo-router";
import { Tabs } from "expo-router/js-tabs";
import { type ComponentRef, useRef } from "react";
import { View } from "react-native";
import { FloatingTabs } from "../../components/FloatingTabs";
import { Button } from "../../components/ui";
import { useColors } from "../../lib/theme";

/**
 * Today, Jarvis, Chats, Work and More in a floating glass bar. The bar sits outside the navigator so
 * it can blur it (Android blurs only what is inside a BlurTargetView).
 */
export default function TabsLayout() {
  const c = useColors();
  const target = useRef<ComponentRef<typeof View>>(null);
  const action = (title: string, to: string) => ({
    headerRight: () => <Button small kind="primary" title={title} onPress={() => router.push(to as never)} />,
    headerRightContainerStyle: { paddingRight: 12 },
  });
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <BlurTargetView ref={target} style={{ flex: 1, backgroundColor: c.bg }}>
        <Tabs
          tabBar={() => null}
          screenOptions={{
            animation: "shift",
            headerStyle: { backgroundColor: c.bg },
            headerShadowVisible: false,
            headerTintColor: c.text,
            headerTitleAlign: "left",
            headerTitleStyle: { fontWeight: "700", fontSize: 28 },
            sceneStyle: { backgroundColor: c.bg },
          }}
        >
          <Tabs.Screen name="index" options={{ title: "Today", headerShown: false }} />
          <Tabs.Screen name="assistant" options={{ title: "Jarvis" }} />
          <Tabs.Screen name="chats" options={{ title: "Chats", ...action("New", "/t/new") }} />
          <Tabs.Screen name="work" options={{ title: "Work" }} />
          <Tabs.Screen name="more" options={{ title: "More" }} />
        </Tabs>
      </BlurTargetView>
      <FloatingTabs blurTarget={target} />
    </View>
  );
}
