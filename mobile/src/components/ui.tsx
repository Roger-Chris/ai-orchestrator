import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, type TextInputProps, View, type ViewStyle } from "react-native";
import { type Colors, useColors } from "../lib/theme";

type Kind = "primary" | "ghost" | "danger";

export function Button({ title, onPress, kind = "ghost", disabled, busy, small }: { title: string; onPress: () => void; kind?: Kind; disabled?: boolean; busy?: boolean; small?: boolean }) {
  const c = useColors();
  const primary = kind === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: small ? 36 : 44,
        paddingHorizontal: small ? 12 : 16,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: primary ? c.accent : c.border,
        backgroundColor: primary ? c.accent : "transparent",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: 6,
        opacity: disabled ? 0.45 : pressed ? 0.7 : 1,
      })}
    >
      {busy && <ActivityIndicator size="small" color={primary ? c.accentInk : c.text} />}
      <Text style={{ color: primary ? c.accentInk : kind === "danger" ? c.err : c.text, fontWeight: primary ? "700" : "500", fontSize: small ? 14 : 15 }}>{title}</Text>
    </Pressable>
  );
}

export function Card({ children, style, attention }: { children: ReactNode; style?: ViewStyle; attention?: boolean }) {
  const c = useColors();
  return (
    <View style={[{ backgroundColor: attention ? c.warnSoft : c.surface, borderColor: attention ? c.warn : c.border, borderWidth: 1, borderRadius: 12, padding: 12, gap: 10 }, style]}>
      {children}
    </View>
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
          { color: c.text, backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, textAlignVertical: rest.multiline ? "top" : "center" },
          style,
        ]}
      />
    </View>
  );
}

export function Chip({ text, color }: { text: string; color?: string }) {
  const c = useColors();
  return (
    <View style={{ borderColor: c.border, borderWidth: 1, borderRadius: 999, paddingHorizontal: 9, paddingVertical: 2 }}>
      <Text style={{ color: color ?? c.muted, fontSize: 12, fontWeight: color ? "700" : "400" }}>{text}</Text>
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
