import { View, type ViewStyle } from "react-native";

/**
 * The footer's icons, drawn from plain views (no icon font or native package to add): a house,
 * a briefcase, a spark, a speech bubble and a laptop. Filled when the tab is the open one.
 */
export type TabIconName = "home" | "work" | "assistant" | "chats" | "devices";

export function TabIcon({ name, color, focused }: { name: TabIconName; color: string; focused: boolean }) {
  const line = 2;
  const fill = focused ? color : "transparent";
  const box = (s: ViewStyle): ViewStyle => ({ position: "absolute", borderColor: color, borderWidth: line, ...s });
  const shapes: Record<TabIconName, ViewStyle[]> = {
    // roof (a square turned 45°, its lower half hidden by the walls drawn over it) and walls
    home: [box({ width: 15, height: 15, top: 2, left: 4.5, transform: [{ rotate: "45deg" }], borderRadius: 2 }), box({ width: 16, height: 11, top: 10, left: 4, borderTopWidth: 0, backgroundColor: fill, borderBottomLeftRadius: 2, borderBottomRightRadius: 2 })],
    work: [box({ width: 8, height: 6, top: 3, left: 8, borderBottomWidth: 0, borderTopLeftRadius: 2, borderTopRightRadius: 2 }), box({ width: 20, height: 13, top: 8, left: 2, borderRadius: 3, backgroundColor: fill })],
    assistant: [box({ width: 12, height: 12, top: 6, left: 6, transform: [{ rotate: "45deg" }], borderRadius: 3, backgroundColor: fill }), box({ width: 5, height: 5, top: 1, left: 17, borderRadius: 3, borderWidth: 0, backgroundColor: color })],
    chats: [box({ width: 20, height: 14, top: 3, left: 2, borderRadius: 6, backgroundColor: fill }), box({ width: 6, height: 6, top: 15, left: 5, borderTopWidth: 0, borderRightWidth: 0, transform: [{ rotate: "-20deg" }], backgroundColor: fill })],
    devices: [box({ width: 16, height: 11, top: 4, left: 4, borderRadius: 2, backgroundColor: fill }), box({ width: 22, height: 3, top: 17, left: 1, borderWidth: 0, borderRadius: 2, backgroundColor: color })],
  };
  return (
    <View style={{ width: 44, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: focused ? `${color}22` : "transparent" }}>
      <View style={{ width: 24, height: 24 }}>
        {shapes[name].map((s, i) => (
          <View key={i} style={s} />
        ))}
      </View>
    </View>
  );
}
