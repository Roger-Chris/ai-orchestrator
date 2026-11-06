import { BlurView } from "expo-blur";
import { router, usePathname } from "expo-router";
import { type ComponentRef, type RefObject, useEffect, useState } from "react";
import { Keyboard, Platform, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useColors, useIsDark } from "../lib/theme";
import { TabIcon, type TabIconName } from "./TabIcon";
import { Press } from "./ui";

const TABS: { href: string; label: string; icon: TabIconName }[] = [
  { href: "/", label: "Today", icon: "home" },
  { href: "/assistant", label: "Jarvis", icon: "assistant" },
  { href: "/chats", label: "Chats", icon: "chats" },
  { href: "/work", label: "Work", icon: "work" },
  { href: "/more", label: "More", icon: "more" },
];

const BAR = 64;
const GAP = 12;

function useKeyboardOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => setOpen(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setOpen(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return open;
}

/**
 * How far the keyboard covers this view. KeyboardAvoidingView left the message box behind the keyboard
 * on edge-to-edge Android; this measures the view against where the keyboard really starts, so it is
 * also right on a phone that resizes the window.
 */
export function useKeyboardLift(view: RefObject<ComponentRef<typeof View> | null>): number {
  const [lift, setLift] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", (e) => view.current?.measureInWindow((_x, y, _w, h) => setLift(Math.max(0, y + h - e.endCoordinates.screenY))));
    const hide = Keyboard.addListener("keyboardDidHide", () => setLift(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [view]);
  return lift;
}

/** Room a tab screen leaves at its bottom so its last row can scroll clear of the floating bar. */
export function useTabSpace(): number {
  const insets = useSafeAreaInsets();
  return useKeyboardOpen() ? 0 : BAR + GAP + insets.bottom + 12;
}

/** The floating glass pill. Screens scroll underneath it; it steps aside while you type. */
export function FloatingTabs({ blurTarget }: { blurTarget: RefObject<ComponentRef<typeof View> | null> }) {
  const c = useColors();
  const isDark = useIsDark();
  const insets = useSafeAreaInsets();
  const path = usePathname();
  if (useKeyboardOpen()) return null;
  return (
    <View
      accessibilityRole="tablist"
      style={{ position: "absolute", left: 16, right: 16, bottom: insets.bottom + GAP, height: BAR, borderRadius: BAR / 2, boxShadow: "0 10px 30px rgba(40, 25, 5, 0.22)" }}
    >
      <BlurView
        blurTarget={blurTarget}
        blurMethod={Platform.OS === "android" ? "dimezisBlurView" : "none"}
        intensity={70}
        tint={isDark ? "dark" : "light"}
        style={{ flex: 1, flexDirection: "row", padding: 6, gap: 2, borderRadius: BAR / 2, overflow: "hidden", borderWidth: 0.5, borderColor: c.border, backgroundColor: `${c.surface}a6` }}
      >
        {TABS.map((t) => {
          const on = t.href === path;
          return (
            <Press
              key={t.href}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={t.label}
              haptic="tick"
              onPress={() => router.navigate(t.href as never)}
              style={{ flex: 1, borderRadius: 26, alignItems: "center", justifyContent: "center", backgroundColor: on ? c.accentSoft : "transparent" }}
            >
              <TabIcon name={t.icon} color={on ? c.accent : c.muted} focused={on} />
              <Text style={{ color: on ? c.accent : c.muted, fontSize: 11, fontWeight: on ? "600" : "500" }}>{t.label}</Text>
            </Press>
          );
        })}
      </BlurView>
    </View>
  );
}
