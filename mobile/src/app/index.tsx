import { Link, Stack, router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import { Button, Dot, ErrorText, Muted } from "../components/ui";
import { type ActiveRun, Api, type Thread, Unauthorized } from "../lib/api";
import { useColors } from "../lib/theme";

function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return new Date(ts).toLocaleDateString();
}

/** Your conversations, with the ones that need you on top. */
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

  const status = new Map(active.map((r) => [r.threadId, r.status]));
  const needsYou = active.filter((r) => r.status === "waiting" || r.status === "awaiting_approval");

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button small title="Settings" onPress={() => router.push("/settings")} />
              <Button small kind="primary" title="New" onPress={() => router.push("/t/new")} />
            </View>
          ),
        }}
      />
      {needsYou.length > 0 && (
        <View style={{ backgroundColor: c.warnSoft, borderBottomColor: c.warn, borderBottomWidth: 1, padding: 12, gap: 4 }}>
          <Text style={{ color: c.text, fontWeight: "700" }}>{needsYou.length === 1 ? "An agent needs you" : `${needsYou.length} runs need you`}</Text>
          {needsYou.slice(0, 3).map((r) => (
            <Link key={r.id} href={r.threadId ? `/t/${r.threadId}` : "/"} style={{ color: c.accent, paddingVertical: 4 }}>
              {r.task.slice(0, 70)}
            </Link>
          ))}
        </View>
      )}
      <FlatList
        data={threads}
        keyExtractor={(t) => t.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} colors={[c.accent]} />}
        contentContainerStyle={{ padding: 12, gap: 8, flexGrow: 1 }}
        ListHeaderComponent={<ErrorText text={error} />}
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
              style={({ pressed }) => ({ backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: 12, padding: 14, flexDirection: "row", alignItems: "center", gap: 10, opacity: pressed ? 0.7 : 1 })}
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
