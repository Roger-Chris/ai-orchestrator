import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Button, Chip, ErrorText, Muted, Row } from "../components/ui";
import { Api, type MemoryRecord } from "../lib/api";
import { useColors } from "../lib/theme";

const KINDS = ["", "person", "project", "decision", "fact", "note", "work", "task", "file"];

/** The shared memory every device and AI tool uses: search it, open anything, add to it. */
export default function Memory() {
  const c = useColors();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [hits, setHits] = useState<MemoryRecord[]>();
  const [about, setAbout] = useState<Awaited<ReturnType<typeof Api.memoryAbout>>>();
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  useFocusEffect(
    useCallback(() => {
      Promise.all([Api.memoryStatus(), Api.graph().catch(() => undefined)])
        .then(([s, g]) => {
          const people = g ? Object.entries(g.entities).map(([k, n]) => `${n} ${k}`).join(", ") : "";
          setStatus(`${s.records} records${s.pending ? `, ${s.pending} not synced yet` : ""}${s.ok ? "" : " · offline copy"}${people ? ` · graph: ${people}, ${g!.relations} links` : ""}`);
        })
        .catch((e) => setError((e as Error).message));
      if (!hits) Api.memoryRecent().then(setHits).catch(() => {});
    }, [hits]),
  );

  const search = async (k = kind) => {
    setAbout(undefined);
    setError("");
    try {
      setHits(query.trim() ? await Api.memorySearch(query.trim(), k || undefined) : await Api.memoryRecent());
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const open = async (r: MemoryRecord) => {
    try {
      setAbout(await Api.memoryAbout(r.uid));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remember = async () => {
    if (!note.trim()) return;
    try {
      const r = await Api.remember(note.trim());
      setNote("");
      setMsg(`Saved (${r.uid}). Every device will have it.`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 20, gap: 12 }} keyboardShouldPersistTaps="handled">
      {!!status && <Muted small>{status}</Muted>}
      <TextInput
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={() => void search()}
        returnKeyType="search"
        placeholder="Search people, projects, decisions, files…"
        placeholderTextColor={c.muted}
        style={{ color: c.text, backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 }}
      />
      <Row>
        {KINDS.map((k) => (
          <Pressable key={k || "all"} onPress={() => (setKind(k), void search(k))}>
            <Chip text={k || "all"} color={kind === k ? c.accent : undefined} />
          </Pressable>
        ))}
      </Row>
      <ErrorText text={error} />

      {about ? (
        <View style={{ gap: 8 }}>
          <Pressable onPress={() => setAbout(undefined)}>
            <Text style={{ color: c.accent }}>← Back to results</Text>
          </Pressable>
          <Record r={about.record} full />
          {about.relations.length > 0 && <Text style={{ color: c.muted, fontSize: 13, marginTop: 8 }}>Connections</Text>}
          {about.relations.map((r, i) => (
            <Text key={i} style={{ color: c.text, fontSize: 15 }}>{`· ${r.title}`}</Text>
          ))}
          {about.linked.length > 0 && <Text style={{ color: c.muted, fontSize: 13, marginTop: 8 }}>About it</Text>}
          {about.linked.map((r) => (
            <Record key={r.uid} r={r} onPress={() => void open(r)} />
          ))}
        </View>
      ) : (
        <View>
          {hits?.map((r) => (
            <Record key={r.uid} r={r} onPress={() => void open(r)} />
          ))}
          {hits && !hits.length && <Muted>Nothing matches.</Muted>}
        </View>
      )}

      <View style={{ gap: 8, marginTop: 16, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 16 }}>
        <Text style={{ color: c.text, fontWeight: "600" }}>Remember something</Text>
        <TextInput
          value={note}
          onChangeText={setNote}
          multiline
          placeholder="e.g. Jayesh prefers calls after 6 pm"
          placeholderTextColor={c.muted}
          style={{ color: c.text, backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 16, minHeight: 70, textAlignVertical: "top" }}
        />
        <Row>
          <Button kind="primary" title="Save" disabled={!note.trim()} onPress={() => void remember()} />
        </Row>
        {!!msg && <Muted small>{msg}</Muted>}
      </View>
    </ScrollView>
  );
}

function Record({ r, onPress, full }: { r: MemoryRecord; onPress?: () => void; full?: boolean }) {
  const c = useColors();
  return (
    <Pressable disabled={!onPress} onPress={onPress} style={({ pressed }) => ({ paddingVertical: 10, borderTopWidth: full ? 0 : 1, borderTopColor: c.border, opacity: pressed ? 0.6 : 1 })}>
      <Text style={{ color: c.muted, fontSize: 12 }}>{[r.kind, r.device && `from ${r.device}`, r.updated_at?.slice(0, 10)].filter(Boolean).join(" · ")}</Text>
      <Text style={{ color: c.text, fontSize: full ? 20 : 16, fontWeight: full ? "600" : "400", marginTop: 2 }}>{r.title}</Text>
      {!!r.body && (
        <Text selectable style={{ color: c.muted, fontSize: 14, lineHeight: 20, marginTop: 2 }} numberOfLines={full ? undefined : 3}>
          {r.body}
        </Text>
      )}
    </Pressable>
  );
}
