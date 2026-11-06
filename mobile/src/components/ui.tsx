import type { ReactNode } from "react";
import { useRef } from "react";
import { ActivityIndicator, Animated, Pressable, type PressableProps, Switch, Text, TextInput, type TextInputProps, View, type ViewStyle } from "react-native";
import { feel } from "../lib/feel";
import { type Colors, useColors } from "../lib/theme";

type Kind = "primary" | "ghost" | "danger";

const SpringPressable = Animated.createAnimatedComponent(Pressable);

/** A press that answers at once: a small spring and a light tap you feel. */
export function Press({ style, onPress, haptic = "tap", shrink = 0.96, children, ...rest }: Omit<PressableProps, "style" | "children"> & { style?: ViewStyle; haptic?: keyof typeof feel; shrink?: number; children?: ReactNode }) {
  const scale = useRef(new Animated.Value(1)).current;
  const to = (value: number) => Animated.spring(scale, { toValue: value, speed: 40, bounciness: value === 1 ? 10 : 0, useNativeDriver: true }).start();
  return (
    <SpringPressable
      {...rest}
      onPressIn={() => to(shrink)}
      onPressOut={() => to(1)}
      onPress={(e) => {
        feel[haptic]();
        onPress?.(e);
      }}
      style={[style, { transform: [{ scale }] }]}
    >
      {children}
    </SpringPressable>
  );
}

export function Button({ title, onPress, kind = "ghost", disabled, busy, small }: { title: string; onPress: () => void; kind?: Kind; disabled?: boolean; busy?: boolean; small?: boolean }) {
  const c = useColors();
  const primary = kind === "primary";
  return (
    <Press
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      haptic={primary ? "firm" : "tap"}
      style={{
        minHeight: 44,
        paddingHorizontal: small ? 14 : 18,
        borderRadius: small ? 22 : 14,
        backgroundColor: primary ? c.accent : kind === "danger" ? `${c.err}1f` : c.accentSoft,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: 6,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {busy && <ActivityIndicator size="small" color={primary ? c.accentInk : c.accent} />}
      <Text style={{ color: primary ? c.accentInk : kind === "danger" ? c.err : c.accent, fontWeight: "600", fontSize: small ? 14 : 16 }}>{title}</Text>
    </Press>
  );
}

export function Card({ children, style, attention }: { children: ReactNode; style?: ViewStyle; attention?: boolean }) {
  const c = useColors();
  return (
    <View style={[{ backgroundColor: attention ? c.warnSoft : c.surface, borderColor: attention ? c.warn : c.border, borderWidth: attention ? 1 : 0.5, borderRadius: 16, padding: 14, gap: 10 }, style]}>
      {children}
    </View>
  );
}

/** A big screen title and an optional line under it. */
export function Title({ text, sub }: { text: string; sub?: string }) {
  const c = useColors();
  return (
    <View style={{ gap: 2 }}>
      <Text accessibilityRole="header" style={{ color: c.text, fontSize: 34, lineHeight: 41, fontWeight: "700" }}>{text}</Text>
      {!!sub && <Text style={{ color: c.muted, fontSize: 15, lineHeight: 20 }}>{sub}</Text>}
    </View>
  );
}

/** A heading over a group of rows. */
export function Heading({ text }: { text: string }) {
  const c = useColors();
  return <Text accessibilityRole="header" style={{ color: c.muted, fontSize: 14, fontWeight: "600", marginHorizontal: 16, marginTop: 10, marginBottom: -4 }}>{text}</Text>;
}

/** Rows in one rounded group, separated by thin lines. */
export function Group({ children }: { children: ReactNode }) {
  const c = useColors();
  return <View style={{ backgroundColor: c.surface, borderColor: c.border, borderWidth: 0.5, borderRadius: 16, overflow: "hidden" }}>{children}</View>;
}

/** One row of a Group. With onPress it shows a chevron; `right` replaces it. */
export function ListRow({ title, sub, value, icon, right, first, onPress }: { title: string; sub?: string; value?: string; icon?: ReactNode; right?: ReactNode; first?: boolean; onPress?: () => void }) {
  const c = useColors();
  const body = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 50, paddingHorizontal: 16, paddingVertical: 10 }}>
      {icon}
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={{ color: c.text, fontSize: 16 }}>{title}</Text>
        {!!sub && <Text style={{ color: c.muted, fontSize: 14, lineHeight: 19 }}>{sub}</Text>}
      </View>
      {!!value && <Text style={{ color: c.muted, fontSize: 15 }}>{value}</Text>}
      {right ?? (onPress ? <Text style={{ color: c.muted, fontSize: 20, lineHeight: 22 }}>›</Text> : null)}
    </View>
  );
  const line = first ? null : <View style={{ height: 0.5, backgroundColor: c.border, marginLeft: 16 }} />;
  if (!onPress) return <View>{line}{body}</View>;
  return (
    <View>
      {line}
      <Pressable accessibilityRole="button" onPress={() => { feel.tap(); onPress(); }} android_ripple={{ color: c.surface2 }} style={({ pressed }) => ({ backgroundColor: pressed ? c.surface2 : "transparent" })}>
        {body}
      </Pressable>
    </View>
  );
}

/** Switch between a few views of one screen. */
export function Segments<T extends string>({ options, value, onChange }: { options: readonly { id: T; label: string }[]; value: T; onChange: (id: T) => void }) {
  const c = useColors();
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", backgroundColor: c.surface2, borderRadius: 12, padding: 3 }}>
      {options.map((o) => (
        <Pressable
          key={o.id}
          accessibilityRole="tab"
          accessibilityState={{ selected: o.id === value }}
          onPress={() => {
            if (o.id !== value) feel.tick();
            onChange(o.id);
          }}
          style={{ flex: 1, minHeight: 40, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: o.id === value ? c.accentSoft : "transparent" }}
        >
          <Text style={{ color: o.id === value ? c.accent : c.text, fontSize: 14, fontWeight: o.id === value ? "600" : "400" }}>{o.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export function Toggle({ value, onChange, label }: { value: boolean; onChange: (on: boolean) => void; label: string }) {
  const c = useColors();
  return (
    <Switch
      accessibilityLabel={label}
      value={value}
      onValueChange={(on) => {
        feel.tick();
        onChange(on);
      }}
      thumbColor="#ffffff"
      trackColor={{ true: c.accent, false: c.border }}
    />
  );
}

export function Field(props: TextInputProps & { label?: string }) {
  const c = useColors();
  const { label, style, ...rest } = props;
  return (
    <View style={{ gap: 4 }}>
      {label && <Text style={{ color: c.muted, fontSize: 13 }}>{label}</Text>}
      <TextInput
        placeholderTextColor={c.muted}
        {...rest}
        style={[
          { color: c.text, backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 11, fontSize: 16, textAlignVertical: rest.multiline ? "top" : "center" },
          style,
        ]}
      />
    </View>
  );
}

export function Chip({ text, color }: { text: string; color?: string }) {
  const c = useColors();
  return (
    <View style={{ backgroundColor: color ? `${color}1f` : c.surface2, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 2 }}>
      <Text style={{ color: color ?? c.muted, fontSize: 12, fontWeight: color ? "600" : "400" }}>{text}</Text>
    </View>
  );
}

export function Dot({ color, size = 9 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }, style]}>{children}</View>;
}

export function ErrorText({ text }: { text?: string }) {
  const c = useColors();
  return text ? <Text style={{ color: c.err, fontSize: 14 }}>{text}</Text> : null;
}

export function Muted({ children, small }: { children: ReactNode; small?: boolean }) {
  const c = useColors();
  return <Text style={{ color: c.muted, fontSize: small ? 13 : 15 }}>{children}</Text>;
}

export const statusColor = (c: Colors, status: string) =>
  ({ done: c.ok, failed: c.err, cancelled: c.err, skipped: c.muted, waiting: c.warn, review: c.warn, awaiting_approval: c.warn, pending: c.border })[status] ?? c.accent;
