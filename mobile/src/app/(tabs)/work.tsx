import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Button, Chip, ErrorText, Muted } from "../../components/ui";
import { Api, type WorkPersonView } from "../../lib/api";
import { useColors } from "../../lib/theme";

const ago = (ts?: number) => {
  if (!ts) return "";
  const m = Math.round((Date.now() / 1000 - ts) / 60);
  return m < 60 ? `${Math.max(m, 1)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/** The people you give tasks to: who is late, who has work open, and the last word in your WhatsApp chat. */
export default function Work() {
  const c = useColors();
  const [people, setPeople] = useState<WorkPersonView[]>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPeople((await Api.work()).people);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));

  const late = people?.reduce((n, p) => n + p.overdue, 0) ?? 0;
  const open = people?.reduce((n, p) => n + p.open, 0) ?? 0;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} colors={[c.accent]} />}>
      <ErrorText text={error} />
      {people && people.length > 0 && (
        <Text style={{ color: late ? c.warn : c.muted, fontSize: 15 }}>
          {late ? `${late} late · ` : ""}
          {open} open with {people.length} {people.length === 1 ? "person" : "people"}
        </Text>
      )}
      {people?.map((p) => (
        <Pressable
          key={p.id}
          onPress={() => router.push(`/work/${p.id}` as never)}
          style={({ pressed }) => ({ backgroundColor: c.surface, borderColor: p.overdue ? c.warn : c.border, borderWidth: 1, borderRadius: 14, padding: 14, gap: 6, opacity: pressed ? 0.75 : 1 })}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text style={{ color: c.text, fontSize: 17, fontWeight: "600", flex: 1 }} numberOfLines={1}>
              {p.name}
            </Text>
            {p.overdue > 0 && <Chip text={`${p.overdue} late`} color={c.warn} />}
            {p.open > 0 && <Chip text={`${p.open} open`} color={c.accent} />}
            {p.done > 0 && <Chip text={`${p.done} done`} />}
          </View>
          {p.role ? <Muted small>{p.role}</Muted> : null}
          {p.last ? (
            <Text style={{ color: c.muted, fontSize: 14 }} numberOfLines={2}>
              {p.lastFromMe ? "You: " : ""}
              {p.last} · {ago(p.lastTs)}
            </Text>
          ) : (
            <Muted small>{p.chatId ? "No WhatsApp messages yet" : "Not linked to a WhatsApp chat"}</Muted>
          )}
        </Pressable>
      ))}
      {people && !people.length && (
        <View style={{ gap: 12, paddingTop: 24 }}>
          <Text style={{ color: c.text, fontSize: 18, fontWeight: "600" }}>Give people tasks and follow them here</Text>
          <Muted>Add someone from your WhatsApp chats. What you send them and what they reply keeps their tasks up to date: "done", "started", "stuck".</Muted>
          <Button kind="primary" title="+ Add a person" onPress={() => router.push("/work-add" as never)} />
        </View>
      )}
    </ScrollView>
  );
}
