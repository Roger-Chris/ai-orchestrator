import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import { Pressable, Switch, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Agent, RunOptions } from "../lib/api";
import { LABEL, useColors } from "../lib/theme";
import { ErrorText, Field } from "./ui";

const KEY = "orc.options";
const DEFAULTS: RunOptions = { mode: "auto", ask: true };

/** Tappable choice list (a native picker would need another library). */
function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  const c = useColors();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: c.muted, fontSize: 13 }}>{label}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {options.map(([v, l]) => (
          <Pressable
            key={v}
            accessibilityRole="radio"
            accessibilityState={{ selected: v === value }}
            onPress={() => onChange(v)}
            style={{ borderWidth: 1, borderColor: v === value ? c.accent : c.border, backgroundColor: v === value ? c.accentSoft : "transparent", borderRadius: 999, paddingHorizontal: 12, minHeight: 36, justifyContent: "center" }}
          >
            <Text style={{ color: c.text }}>{l}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  const c = useColors();
  return (
    <Pressable accessibilityRole="switch" accessibilityState={{ checked: value }} onPress={() => onChange(!value)} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 44 }}>
      <Text style={{ color: c.text, fontSize: 15, flex: 1 }}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: c.accent }} />
    </Pressable>
  );
}

/**
 * Where you talk to the agents. Start a message with @agent to send it to one specialist.
 * Options stick on this phone.
 */
export function Composer({ agents, onSend }: { agents: Agent[]; onSend: (text: string, o: RunOptions) => Promise<void> }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [opts, setOpts] = useState<RunOptions>(DEFAULTS);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    SecureStore.getItemAsync(KEY)
      .then((v) => v && setOpts({ ...DEFAULTS, ...JSON.parse(v) }))
      .catch(() => {});
  }, []);
  const set = <K extends keyof RunOptions>(k: K, v: RunOptions[K]) =>
    setOpts((o) => {
      const next = { ...o, [k]: v || undefined };
      SecureStore.setItemAsync(KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });

  const mention = text.match(/^@([\w-]+)\s/)?.[1];
  const mentioned = mention ? agents.find((a) => a.name === mention) : undefined;

  const send = async () => {
    const body = mentioned ? text.slice(mention!.length + 2).trim() : text.trim();
    if (!body || busy) return;
    setBusy(true);
    setError("");
    try {
      const o: RunOptions = { ...opts, ...(mentioned ? { agent: mentioned.name, mode: "direct" as const } : {}) };
      if (o.branches && (!o.permission || o.permission === "read")) o.permission = "edit";
      await onSend(body, o);
      setText("");
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const summary = [
    { auto: "brain decides", plan: "plan and split", direct: "one model", design: "design first" }[opts.mode ?? "auto"],
    opts.provider && LABEL[opts.provider],
    opts.permission === "edit" ? "can edit files" : opts.permission === "full" ? "full access" : "read-only",
    opts.ask && "may ask you",
    opts.checkpoints && "pauses after each step",
    opts.branches && "branches",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View style={{ borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8 + insets.bottom, gap: 6 }}>
      {open && (
        <View style={{ gap: 12, paddingBottom: 6 }}>
          <Choice label="How" value={opts.mode ?? "auto"} onChange={(v) => set("mode", v)} options={[["auto", "Brain decides"], ["plan", "Plan & split"], ["direct", "One model"], ["design", "Design first"]]} />
          <Choice
            label="Model"
            value={opts.provider ?? ""}
            onChange={(v) => set("provider", (v || undefined) as RunOptions["provider"])}
            options={[["", "Best for the job"], ...Object.entries(LABEL).map(([id, l]) => [id, l] as [string, string])]}
          />
          <Choice label="Access" value={opts.permission ?? ""} onChange={(v) => set("permission", (v || undefined) as RunOptions["permission"])} options={[["", "Read-only"], ["edit", "Edit files"], ["full", "Full"]]} />
          <Field label="Folder on the hub" value={opts.cwd ?? ""} onChangeText={(v) => set("cwd", v)} placeholder="e.g. C:\projects\my-app" autoCapitalize="none" autoCorrect={false} />
          <Toggle label="Agents may ask me" value={!!opts.ask} onChange={(v) => set("ask", v)} />
          <Toggle label="Pause after each step" value={!!opts.checkpoints} onChange={(v) => set("checkpoints", v)} />
          <Toggle label="Code on branches across devices" value={!!opts.branches} onChange={(v) => set("branches", v)} />
        </View>
      )}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Options" onPress={() => setOpen((v) => !v)} style={{ width: 44, height: 44, borderRadius: 10, borderWidth: 1, borderColor: open ? c.accent : c.border, alignItems: "center", justifyContent: "center" }}>
          <Text style={{ color: c.text, fontSize: 18 }}>⚙</Text>
        </Pressable>
        <TextInput
          value={text}
          onChangeText={setText}
          multiline
          placeholder="Message the agents. Start with @coder, @researcher…"
          placeholderTextColor={c.muted}
          style={{ flex: 1, color: c.text, backgroundColor: c.bg, borderColor: c.border, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, maxHeight: 160 }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          disabled={busy || !text.trim()}
          onPress={send}
          style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: c.accent, opacity: busy || !text.trim() ? 0.45 : 1, alignItems: "center", justifyContent: "center" }}
        >
          <Text style={{ color: c.accentInk, fontSize: 20, fontWeight: "700" }}>↑</Text>
        </Pressable>
      </View>
      <Text style={{ color: c.muted, fontSize: 12 }}>
        {mentioned ? `To @${mentioned.name} only · ` : ""}
        {summary}
      </Text>
      <ErrorText text={error} />
    </View>
  );
}
