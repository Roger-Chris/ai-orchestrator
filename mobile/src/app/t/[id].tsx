import { Stack, router, useLocalSearchParams } from "expo-router";
import { type ComponentRef, useCallback, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, ScrollView, Text, View } from "react-native";
import { Composer } from "../../components/Composer";
import { RunCard } from "../../components/RunCard";
import { ErrorText, Muted } from "../../components/ui";
import { type Agent, Api, type RunOptions, type RunRecord } from "../../lib/api";
import { useColors } from "../../lib/theme";

/** A conversation: your messages, what the agents did, and the box to say more. `new` starts one. */
export default function Conversation() {
  const c = useColors();
  const { id } = useLocalSearchParams<{ id: string }>();
  const isNew = id === "new";
  const [title, setTitle] = useState(isNew ? "New conversation" : "");
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [error, setError] = useState("");
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);

  const load = useCallback(async () => {
    if (isNew) return;
    try {
      const r = await Api.thread(id);
      setTitle(r.thread.title);
      setRuns(r.runs);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id, isNew]);

  useEffect(() => {
    void load();
    Api.agents().then(setAgents).catch(() => {});
  }, [load]);

  const send = async (text: string, o: RunOptions) => {
    if (isNew) {
      const t = await Api.newThread();
      await Api.send(t.id, text, o);
      router.replace(`/t/${t.id}`);
      return;
    }
    const run = await Api.send(id, text, o);
    setRuns((r) => [...r, run]);
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }} keyboardVerticalOffset={90}>
      <Stack.Screen options={{ title: title || "Conversation" }} />
      <ScrollView ref={scroll} contentContainerStyle={{ padding: 12, gap: 16, flexGrow: 1 }} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })} keyboardShouldPersistTaps="handled">
        <ErrorText text={error} />
        {isNew && (
          <View style={{ flex: 1, justifyContent: "center", gap: 10, padding: 12 }}>
            <Text style={{ color: c.text, fontSize: 22, fontWeight: "700" }}>What should the agents work on?</Text>
            <Muted>Tap ⚙ to choose how it runs: one model or a plan, design first, access to files, whether agents may ask you, and pausing after each step.</Muted>
          </View>
        )}
        {runs.map((r) => (
          <View key={r.id} style={{ gap: 8 }}>
            <View style={{ alignSelf: "flex-end", maxWidth: "88%", backgroundColor: c.accent, borderRadius: 16, borderBottomRightRadius: 4, paddingHorizontal: 14, paddingVertical: 10 }}>
              <Text style={{ color: c.accentInk, fontSize: 15 }} selectable>
                {r.task}
              </Text>
            </View>
            <RunCard initial={r} />
          </View>
        ))}
      </ScrollView>
      <Composer agents={agents} onSend={send} />
    </KeyboardAvoidingView>
  );
}
