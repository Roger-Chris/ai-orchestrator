import { Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { KeyboardAvoidingView, Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Button, Card, Chip, ErrorText, Field, Muted, Row } from "../../components/ui";
import { Api, type WorkStatus, type WorkTask } from "../../lib/api";
import { type Colors, useColors } from "../../lib/theme";
import { openWhatsApp } from "../../lib/whatsapp";

type Page = Awaited<ReturnType<typeof Api.workPerson>>;

const LABEL: Record<WorkStatus, string> = { todo: "To give", sent: "Given", in_progress: "Started", blocked: "Stuck", done: "Done", cancelled: "Cancelled" };
const tint = (c: Colors, s: WorkStatus) => ({ todo: c.muted, sent: c.accent, in_progress: c.accent, blocked: c.warn, done: c.ok, cancelled: c.muted })[s];
const when = (ms: number) => new Date(ms).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const BY = { you: "You", me: "Your message", them: "Their message" } as const;

/** One person: their tasks (give, follow, close) and your WhatsApp chat with them, sent and received. */
export default function WorkPerson() {
  const c = useColors();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [page, setPage] = useState<Page>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [details, setDetails] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPage(await Api.workPerson(id));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);
  useFocusEffect(useCallback(() => void load(), [load]));

  const run = async (f: () => Promise<unknown>) => {
    try {
      await f();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const add = () =>
    run(async () => {
      await Api.addWorkTask({ personId: id, title: title.trim(), due: due.trim() || undefined, details: details.trim() || undefined });
      setTitle("");
      setDue("");
      setDetails("");
      setAdding(false);
    });

  /** Opens WhatsApp with the task written out; you press send. Marked given once your message arrives (or by hand). */
  const give = (t: WorkTask) =>
    run(async () => {
      const m = await Api.workMessage(t.id);
      await openWhatsApp(m.text, m.phone);
    });

  const chat = page?.chat ?? [];
  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <Stack.Screen options={{ title: page?.person.name ?? "Work" }} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={loading} onRefresh={load} colors={[c.accent]} />}>
        <ErrorText text={error} />
        {page?.person.role ? <Muted>{page.person.role}</Muted> : null}

        <Row style={{ justifyContent: "space-between" }}>
          <Text style={{ color: c.text, fontSize: 18, fontWeight: "700" }}>Tasks</Text>
          {!adding && <Button small kind="primary" title="+ Task" onPress={() => setAdding(true)} />}
        </Row>
        {adding && (
          <Card>
            <Field placeholder="What should they do?" value={title} onChangeText={setTitle} autoFocus />
            <Field placeholder="Due: 2026-11-02 or 2026-11-02T17:00 (optional)" value={due} onChangeText={setDue} autoCapitalize="none" />
            <Field placeholder="Details (optional)" value={details} onChangeText={setDetails} multiline />
            <Row>
              <Button kind="primary" title="Add task" disabled={!title.trim()} onPress={() => void add()} />
              <Button title="Cancel" onPress={() => setAdding(false)} />
            </Row>
          </Card>
        )}
        {page?.tasks.map((t) => (
          <Pressable key={t.id} onPress={() => setOpen(open === t.id ? undefined : t.id)}>
            <Card attention={t.overdue}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text style={{ color: t.status === "done" || t.status === "cancelled" ? c.muted : c.text, fontSize: 16, fontWeight: "600", flex: 1, textDecorationLine: t.status === "cancelled" ? "line-through" : "none" }}>{t.title}</Text>
                <Chip text={LABEL[t.status]} color={tint(c, t.status)} />
              </View>
              {t.due ? <Text style={{ color: t.overdue ? c.warn : c.muted, fontSize: 13 }}>{t.overdue ? "Late, was due " : "Due "}{t.due.replace("T", " ")}</Text> : null}
              {t.updates.length > 0 && (
                <Text style={{ color: c.muted, fontSize: 13 }} numberOfLines={open === t.id ? undefined : 1}>
                  {BY[t.updates.at(-1)!.by]}: {t.updates.at(-1)!.text || LABEL[t.updates.at(-1)!.status ?? t.status]}
                </Text>
              )}
              {open === t.id && (
                <View style={{ gap: 10 }}>
                  {t.details ? <Text style={{ color: c.text, fontSize: 14 }}>{t.details}</Text> : null}
                  <Row>
                    {t.status === "todo" && <Button small kind="primary" title="Give on WhatsApp" onPress={() => void give(t)} />}
                    {(["sent", "in_progress", "blocked", "done"] as WorkStatus[])
                      .filter((s) => s !== t.status)
                      .map((s) => (
                        <Button key={s} small title={LABEL[s]} onPress={() => void run(() => Api.updateWorkTask(t.id, { status: s }))} />
                      ))}
                    {t.status !== "cancelled" && t.status !== "done" && <Button small kind="danger" title="Cancel task" onPress={() => void run(() => Api.updateWorkTask(t.id, { status: "cancelled" }))} />}
                  </Row>
                  {t.updates.map((u, i) => (
                    <Text key={i} style={{ color: c.muted, fontSize: 13 }}>
                      {when(u.at)} · {BY[u.by]}
                      {u.status ? ` → ${LABEL[u.status]}` : ""}
                      {u.text ? `: ${u.text}` : ""}
                    </Text>
                  ))}
                </View>
              )}
            </Card>
          </Pressable>
        ))}
        {page && !page.tasks.length && !adding && <Muted>No tasks yet. Add one, then give it to them on WhatsApp.</Muted>}

        <Text style={{ color: c.text, fontSize: 18, fontWeight: "700", marginTop: 8 }}>WhatsApp</Text>
        {page && !page.person.chatId && <Muted>Not linked to a WhatsApp chat.</Muted>}
        {page?.person.chatId && !chat.length && <Muted>No messages with them yet. New ones appear here as they arrive.</Muted>}
        {chat.map((m, i) => (
          <View
            key={i}
            style={{ alignSelf: m.fromMe ? "flex-end" : "flex-start", maxWidth: "85%", backgroundColor: m.fromMe ? c.accentSoft : c.surface, borderColor: c.border, borderWidth: m.fromMe ? 0 : 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 }}
          >
            <Text style={{ color: c.text, fontSize: 15 }}>{m.text || (m.media ? `[${m.media}]` : "")}</Text>
            <Text style={{ color: c.muted, fontSize: 11, marginTop: 2, alignSelf: "flex-end" }}>{when(m.ts * 1000)}</Text>
          </View>
        ))}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
