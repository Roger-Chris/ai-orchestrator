import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { ErrorText, Field, Muted } from "../components/ui";
import { Api, type PersonSummary } from "../lib/api";
import { useColors } from "../lib/theme";

const FORMALITY = ["", "very casual", "casual", "in between", "polite", "formal"];

/** The people your WhatsApp replies are written for (the style book `orc style push` sends): what the drafts call them and how they sound. */
export default function People() {
  const c = useColors();
  const [all, setAll] = useState<PersonSummary[]>();
  const [builtAt, setBuiltAt] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await Api.people();
      setAll(r.people);
      setBuiltAt(r.builtAt);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));

  const shown = all?.filter((p) => !q.trim() || `${p.name} ${p.relationship}`.toLowerCase().includes(q.trim().toLowerCase()));
  const line = (label: string, value?: string) => (value ? <Text style={{ color: c.text, fontSize: 14 }}><Text style={{ color: c.muted }}>{label} </Text>{value}</Text> : null);

  return (
    <ScrollView contentContainerStyle={{ padding: 20, gap: 4 }} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={loading} onRefresh={load} colors={[c.accent]} />}>
      <Muted small>{builtAt ? `Learnt from your chats on ${new Date(builtAt).toLocaleDateString()}. Run orc style learn and orc style push on the laptop to refresh.` : "Who your reply drafts are written for."}</Muted>
      <Field placeholder="Search people" value={q} onChangeText={setQ} />
      <ErrorText text={error} />
      {shown?.map((p) => (
        <Pressable key={p.chatId} onPress={() => setOpen(open === p.chatId ? undefined : p.chatId)} style={{ paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border }}>
          <Text style={{ color: c.text, fontSize: 16 }} numberOfLines={1}>{p.name}</Text>
          <Text style={{ color: c.muted, fontSize: 13 }} numberOfLines={1}>
            {[p.relationship, p.addressAs.length ? `you call them ${p.addressAs.join(", ")}` : "", `${p.mine} sent`].filter(Boolean).join(" · ")}
          </Text>
          {open === p.chatId && (
            <View style={{ gap: 2, marginTop: 6 }}>
              {line("They call you", p.theyCallMe.join(", "))}
              {line("Language", p.language)}
              {line("Tone", [p.tone, p.formality ? FORMALITY[p.formality] : ""].filter(Boolean).join(", "))}
              {line("Topics", p.topics.join(", "))}
              {line("Notes", p.notes)}
              {line("Studied", `${p.mine} of your messages, ${p.theirs} of theirs; newest ${new Date(p.lastTs * 1000).toLocaleDateString()}`)}
              {!p.relationship && <Muted small>Not studied yet: drafts borrow from people like them until orc style learn runs.</Muted>}
            </View>
          )}
        </Pressable>
      ))}
      {all && !all.length && <Muted>No style book on this hub yet: run orc style push on the laptop.</Muted>}
    </ScrollView>
  );
}
