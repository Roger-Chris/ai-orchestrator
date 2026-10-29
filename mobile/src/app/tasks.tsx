import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { Button, ErrorText, Muted, Row } from "../components/ui";
import { Api, type BrainTask } from "../lib/api";
import { useColors } from "../lib/theme";

const SOURCE: Record<string, string> = { email: "Gmail", whatsapp: "WhatsApp", manual: "you" };

function due(t: BrainTask): string {
  if (!t.due_at) return "no date";
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(t.due_at) ? t.due_at : `${t.due_at}Z`); // the brain stores UTC
  return d.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/** Every task the brain holds: ones it found in your messages wait for Keep or Drop. */
export default function Tasks() {
  const c = useColors();
  const [tasks, setTasks] = useState<BrainTask[]>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setTasks(await Api.brainTasks());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));

  const act = async (t: BrainTask, action: "confirm" | "reject" | "done") => {
    setTasks((all) => all?.filter((x) => x.id !== t.id || action === "confirm").map((x) => (x.id === t.id ? { ...x, status: "open" } : x)));
    try {
      await Api.taskAction(t.id, action);
    } catch (e) {
      setError((e as Error).message);
    }
    void load();
  };

  const add = async () => {
    if (!title.trim()) return;
    try {
      await Api.addTask(title.trim());
      setTitle("");
      void load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toConfirm = tasks?.filter((t) => t.status === "pending_confirmation") ?? [];
  const open = tasks?.filter((t) => t.status === "open") ?? [];
  return (
    <ScrollView contentContainerStyle={{ padding: 20, gap: 8 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} colors={[c.accent]} />} keyboardShouldPersistTaps="handled">
      <ErrorText text={error} />
      {!tasks && !error && <ActivityIndicator color={c.accent} />}
      <Row style={{ flexWrap: "nowrap" }}>
        <TextInput
          value={title}
          onChangeText={setTitle}
          onSubmitEditing={() => void add()}
          placeholder="Add a task"
          placeholderTextColor={c.muted}
          style={{ flex: 1, color: c.text, borderBottomWidth: 1, borderBottomColor: c.border, paddingVertical: 8, fontSize: 16 }}
        />
        <Button small title="Add" disabled={!title.trim()} onPress={() => void add()} />
      </Row>

      {toConfirm.length > 0 && <Text style={{ color: c.muted, fontSize: 13, marginTop: 20 }}>{`Found in your messages · keep or drop (${toConfirm.length})`}</Text>}
      {toConfirm.map((t) => (
        <TaskRow key={t.id} t={t}>
          <Button small kind="primary" title="Keep" onPress={() => void act(t, "confirm")} />
          <Button small title="Not a task" onPress={() => void act(t, "reject")} />
        </TaskRow>
      ))}

      <Text style={{ color: c.muted, fontSize: 13, marginTop: 20 }}>{`Open (${open.length})`}</Text>
      {open.map((t) => (
        <TaskRow key={t.id} t={t}>
          <Button small title="Done" onPress={() => void act(t, "done")} />
        </TaskRow>
      ))}
      {tasks && !open.length && <Muted>Nothing open.</Muted>}
    </ScrollView>
  );
}

function TaskRow({ t, children }: { t: BrainTask; children: React.ReactNode }) {
  const c = useColors();
  const [more, setMore] = useState(false);
  return (
    <View style={{ paddingVertical: 12, borderTopWidth: 1, borderTopColor: c.border, gap: 4 }}>
      <Text style={{ color: c.muted, fontSize: 13 }}>
        {[due(t), t.kind !== "task" ? t.kind : "", t.priority !== "normal" ? t.priority : "", `from ${t.source_chat ?? SOURCE[t.source ?? "manual"] ?? t.source}`].filter(Boolean).join(" · ")}
      </Text>
      <Text style={{ color: c.text, fontSize: 16 }}>{t.title}</Text>
      {!!t.source_text && (
        <Text onPress={() => setMore(!more)} numberOfLines={more ? undefined : 2} style={{ color: c.muted, fontSize: 14, lineHeight: 20 }}>
          {`“${t.source_text}”`}
        </Text>
      )}
      <Row style={{ marginTop: 6 }}>{children}</Row>
    </View>
  );
}
