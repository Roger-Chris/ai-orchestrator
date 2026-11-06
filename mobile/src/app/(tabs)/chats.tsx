import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { useTabSpace } from "../../components/FloatingTabs";
import { convo } from "../../lib/convo";
import { Button, Dot, ErrorText, Muted } from "../../components/ui";
import { type ActiveRun, Api, type Thread, Unauthorized } from "../../lib/api";
import { useColors } from "../../lib/theme";

function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return new Date(ts).toLocaleDateString();
}

/** All your conversations, newest first; a dot shows the ones that are busy or waiting for you. */
export default function Conversations() {
  const c = useColors();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [active, setActive] = useState<ActiveRun[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [t, a] = await Promise.all([Api.threads(), Api.active()]);
      setThreads(t);
      setActive(a);
      setError("");
    } catch (e) {
      if (e instanceof Unauthorized) router.replace("/connect");
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Refresh while this screen is showing.
  useFocusEffect(
    useCallback(() => {
      void load();
      const t = setInterval(load, 8000);
      return () => clearInterval(t);
    }, [load]),
  );

  const space = useTabSpace();
  const lastJarvis = convo.get().at(-1);
  const status = new Map(active.map((r) => [r.threadId, r.status]));

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={threads}
        keyExtractor={(t) => t.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} colors={[c.accent]} />}
        contentContainerStyle={{ padding: 16, paddingBottom: space, gap: 8, flexGrow: 1 }}
        ListHeaderComponent={
          <View style={{ gap: 8 }}>
            <ErrorText text={error} />
            {lastJarvis && (
              <Pressable accessibilityRole="link" onPress={() => router.navigate("/assistant")} style={({ pressed }) => ({ backgroundColor: c.surface, borderColor: c.border, borderWidth: 0.5, borderRadius: 16, padding: 14, gap: 2, opacity: pressed ? 0.7 : 1 })}>
                <Text style={{ color: c.text, fontSize: 16, fontWeight: "600" }}>Jarvis</Text>
                <Text style={{ color: c.muted, fontSize: 14 }} numberOfLines={1}>{lastJarvis.reply?.answer ?? lastJarvis.you}</Text>
              </Pressable>
            )}
          </View>
        }
        ListEmptyComponent={
          !error ? (
            <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
              <Text style={{ color: c.text, fontSize: 20, fontWeight: "700", textAlign: "center" }}>What should the agents work on?</Text>
              <Muted>The brain picks the right models and devices, asks you when it must, and you can step in at any point.</Muted>
              <Button kind="primary" title="Start a conversation" onPress={() => router.push("/t/new")} />
            </View>
          ) : undefined
        }
        renderItem={({ item }) => {
          const s = status.get(item.id);
          return (
            <Pressable
              accessibilityRole="link"
              onPress={() => router.push(`/t/${item.id}`)}
              style={({ pressed }) => ({ backgroundColor: c.surface, borderColor: c.border, borderWidth: 0.5, borderRadius: 16, padding: 14, flexDirection: "row", alignItems: "center", gap: 10, opacity: pressed ? 0.7 : 1 })}
            >
              <Dot color={s === "waiting" || s === "awaiting_approval" ? c.warn : s ? c.accent : c.border} />
              <Text style={{ color: c.text, fontSize: 16, flex: 1 }} numberOfLines={2}>
                {item.title}
              </Text>
              <Muted small>{ago(item.updatedAt)}</Muted>
            </Pressable>
          );
        }}
      />
    </View>
  );
}
