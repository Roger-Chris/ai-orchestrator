import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { Card, Chip, ErrorText, Muted } from "../components/ui";
import { Api, type LearnStatus, type Lesson, type LessonStatus } from "../lib/api";
import { useColors } from "../lib/theme";

/**
 * What the assistant has learnt from working with you (the brain's learning harness, learn.py):
 * lessons waiting for you, on trial, in use and off; your own new lessons; and the nightly runs
 * (reflection, and the evaluation that promotes trial lessons or rolls them back).
 */

const GROUPS: { status: LessonStatus; title: string; hint: string }[] = [
  { status: "proposed", title: "Waiting for you", hint: "Found in your feedback. Keep to use them." },
  { status: "trial", title: "On trial", hint: "In use; tonight's evaluation keeps them or rolls them back." },
  { status: "active", title: "In use", hint: "Taught by you, kept by you, or passed the evaluation." },
  { status: "off", title: "Off", hint: "Turned off by you, by too many 'Not right', or rolled back." },
];
const KIND: Record<Lesson["kind"], string> = { preference: "preference", fact: "fact", skill: "how to", rule: "rule", voice: "voice" };

export default function LearningScreen() {
  const c = useColors();
  const [st, setSt] = useState<LearnStatus>();
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<number | "run" | "add">();
  const [text, setText] = useState("");
  const [voice, setVoice] = useState(false);
  const [showOff, setShowOff] = useState(false);
  const [ran, setRan] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, l] = await Promise.all([Api.learnStatus(), Api.lessons()]);
      setSt(s);
      setLessons(l);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));

  const set = async (l: Lesson, status: "active" | "off") => {
    setBusy(l.id);
    try {
      await Api.setLesson(l.id, status);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const add = async () => {
    if (!text.trim()) return;
    setBusy("add");
    try {
      await Api.addLesson(text.trim(), voice ? "voice" : "preference");
      setText("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const runNow = async () => {
    setBusy("run");
    setRan("");
    try {
      const r = await Api.learnNow();
      const rf = (r.reflect ?? {}) as { added?: string[]; episodes?: number; note?: string };
      const ev = r.evaluate as { passed?: number; total?: number; promoted?: number[]; rolled_back?: number[] } | undefined;
      setRan(
        [
          rf.note ?? `Read ${rf.episodes ?? 0} answers, learnt ${rf.added?.length ?? 0} new thing(s).`,
          ev && `Evaluation ${ev.passed}/${ev.total}: ${ev.rolled_back ? `rolled back ${ev.rolled_back.length}` : `kept ${ev.promoted?.length ?? 0}`}.`,
        ]
          .filter(Boolean)
          .join(" "),
      );
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const link = (title: string, onPress: () => void, color = c.accent) => (
    <Pressable onPress={onPress} hitSlop={8}>
      <Text style={{ color, fontSize: 15, fontWeight: "600" }}>{title}</Text>
    </Pressable>
  );
  const h2 = { color: c.text, fontSize: 17, fontWeight: "700" as const };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} colors={[c.accent]} />}>
      <ErrorText text={error} />
      {st && (
        <Card>
          <Text style={h2}>How it's going</Text>
          <Muted>
            {`${st.episodes} answers so far: ${st.good} good, ${st.bad} not right${st.waiting ? `, ${st.waiting} to learn from tonight` : ""}. ` +
              `${st.cases} check${st.cases === 1 ? "" : "s"} made from mistakes.` +
              (st.last_eval ? ` Last evaluation: ${st.last_eval.passed}/${st.last_eval.total} passed.` : "")}
          </Muted>
          {!st.enabled && <Text style={{ color: c.warn, marginTop: 6 }}>Learning is off on the brain (LEARN_ENABLED).</Text>}
          <View style={{ flexDirection: "row", gap: 16, alignItems: "center", marginTop: 10 }}>
            {busy === "run" ? <ActivityIndicator color={c.accent} /> : link("Learn now", () => void runNow())}
            <Muted small>Runs by itself every night.</Muted>
          </View>
          {!!ran && <Text style={{ color: c.text, marginTop: 6 }}>{ran}</Text>}
        </Card>
      )}

      <Card>
        <Text style={h2}>Teach me something</Text>
        <Muted small>Or just say it: "from now on…", "next time…". Nothing here can change what needs your approval.</Muted>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={voice ? "e.g. When you speak, keep it to two sentences" : "e.g. Give due dates before task names"}
          placeholderTextColor={c.muted}
          multiline
          style={{ color: c.text, borderColor: c.border, borderWidth: 1, borderRadius: 12, padding: 10, fontSize: 15, marginTop: 8 }}
        />
        <View style={{ flexDirection: "row", gap: 18, alignItems: "center", marginTop: 8 }}>
          {busy === "add" ? <ActivityIndicator color={c.accent} /> : link("Save", () => void add())}
          {link(voice ? "For spoken answers ✓" : "For spoken answers", () => setVoice(!voice), voice ? c.accent : c.muted)}
        </View>
      </Card>

      {GROUPS.filter((g) => g.status !== "off" || showOff).map((g) => {
        const items = lessons.filter((l) => l.status === g.status);
        if (!items.length && g.status !== "active") return null;
        return (
          <Card key={g.status}>
            <Text style={h2}>{`${g.title} (${items.length})`}</Text>
            <Muted small>{g.hint}</Muted>
            {!items.length && <Muted>Nothing yet. Use Good / Not right under answers, or teach me above.</Muted>}
            {items.map((l, i) => (
              <View key={l.id} style={{ borderTopWidth: i ? 1 : 0, borderTopColor: c.border, paddingTop: i ? 10 : 6 }}>
                <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <Chip text={KIND[l.kind]} />
                  {!!l.when && <Muted small>{`when: ${l.when}`}</Muted>}
                  {l.uses > 0 && <Muted small>{`used ${l.uses}× · good ${l.wins} · not right ${l.losses}`}</Muted>}
                </View>
                <Text style={{ color: c.text, fontSize: 15, marginTop: 4 }}>{l.text}</Text>
                {!!l.note && <Muted small>{l.note}</Muted>}
                <View style={{ flexDirection: "row", gap: 20, marginTop: 6, alignItems: "center" }}>
                  {busy === l.id ? (
                    <ActivityIndicator color={c.accent} />
                  ) : (
                    <>
                      {l.status !== "active" && link(l.status === "off" ? "Turn on" : "Keep", () => void set(l, "active"))}
                      {l.status !== "off" && link("Turn off", () => void set(l, "off"), c.muted)}
                    </>
                  )}
                </View>
              </View>
            ))}
          </Card>
        );
      })}
      {link(showOff ? "Hide lessons that are off" : `Show lessons that are off (${lessons.filter((l) => l.status === "off").length})`, () => setShowOff(!showOff), c.muted)}

      {!!st?.runs.length && (
        <Card>
          <Text style={h2}>Recent runs</Text>
          {st.runs.map((r) => (
            <Muted key={r.id} small>
              {`${new Date(r.at).toLocaleString()} · ${r.kind === "reflect" ? "reflection" : `evaluation ${r.passed}/${r.total}`}${r.ok ? "" : " · did not finish or rolled back"}`}
            </Muted>
          ))}
        </Card>
      )}
    </ScrollView>
  );
}
