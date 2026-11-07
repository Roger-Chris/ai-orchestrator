import * as DocumentPicker from "expo-document-picker";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, Linking, RefreshControl, ScrollView, Text, View } from "react-native";
import { Button, Card, Chip, ErrorText, Field, Muted, Row } from "../components/ui";
import { Api, type TryoutView } from "../lib/api";
import { useColors } from "../lib/theme";

const WORKING: TryoutView["status"][] = ["queued", "fetching", "running", "recording"];
const LABEL: Record<TryoutView["status"], string> = {
  queued: "waiting its turn",
  fetching: "downloading",
  running: "setting up and using it",
  recording: "making the video",
  ready: "video ready",
  failed: "failed",
};

/**
 * Try a project: give the hub a zip or other file from this phone, a git or download link, or the
 * name of whoever sent it on WhatsApp. The hub puts it in its own folder in Development, sets it up,
 * runs it headless, uses it in a recorded browser or terminal, and the video comes back here.
 * It runs with full access on the hub, so only try projects you trust.
 */
export default function Tryouts() {
  const c = useColors();
  const [items, setItems] = useState<TryoutView[]>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [source, setSource] = useState("");
  const [from, setFrom] = useState("");
  const [goal, setGoal] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await Api.tryouts());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));
  // While one is working, check every 10 s; the hub also sends a notification when the video is ready.
  const working = !!items?.some((t) => WORKING.includes(t.status));
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [working, load]);

  const go = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await f();
      setSource("");
      setFrom("");
      setGoal("");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const pick = async () => {
    const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    if (r.canceled || !r.assets?.[0]) return;
    const f = r.assets[0];
    await go("upload", () => Api.tryoutUpload(f.uri, f.name, goal.trim() || undefined));
  };

  const start = () => {
    if (!source.trim() && !from.trim()) return setError("Give a link or path, or who sent it on WhatsApp, or pick a file.");
    void go("start", () => Api.tryoutStart({ source: source.trim() || undefined, from: source.trim() ? undefined : from.trim(), goal: goal.trim() || undefined }));
  };

  const cancel = (t: TryoutView) =>
    Alert.alert(`Stop trying ${t.name}?`, "What it has done so far stays in its folder.", [
      { text: "Keep going", style: "cancel" },
      { text: "Stop", style: "destructive", onPress: () => void go(t.id, () => Api.tryoutCancel(t.id)) },
    ]);

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={loading} onRefresh={load} colors={[c.accent]} />}>
      <Card>
        <Text style={{ color: c.text, fontSize: 16, fontWeight: "600" }}>Try a project</Text>
        <Muted small>The hub makes it a folder in Development, sets it up, runs it headless and records itself using it. You get the video. It runs with full access, so only try what you trust.</Muted>
        <Field label="What to show (optional)" placeholder="e.g. add a task and mark it done" value={goal} onChangeText={setGoal} />
        <Button kind="primary" title="Pick a file from this phone" busy={busy === "upload"} disabled={!!busy} onPress={() => void pick()} />
        <Field label="Or a git link, download link or path on the hub" placeholder="https://github.com/…" autoCapitalize="none" autoCorrect={false} value={source} onChangeText={setSource} />
        <Field label="Or who sent it on WhatsApp" placeholder="e.g. Kishaunjith" value={from} onChangeText={setFrom} />
        <Button title="Start" busy={busy === "start"} disabled={!!busy || (!source.trim() && !from.trim())} onPress={start} />
      </Card>
      <ErrorText text={error} />
      {items?.map((t) => (
        <Card key={t.id} attention={t.status === "ready"}>
          <Row>
            <Text style={{ color: c.text, fontSize: 16, flex: 1 }} numberOfLines={1}>{t.name}</Text>
            <Chip text={LABEL[t.status]} />
          </Row>
          {!!t.from && <Muted small>From {t.from}</Muted>}
          {!!t.goal && <Muted small>To show: {t.goal}</Muted>}
          {!!t.project && <Muted small>Folder: {t.project}</Muted>}
          {!!t.summary && <Text style={{ color: c.text }} numberOfLines={8}>{t.summary.replace(/\*\*|`/g, "")}</Text>}
          {!!t.error && <Text style={{ color: c.err }}>{t.error}</Text>}
          <Row>
            {!!t.videoUrl && <Button kind="primary" small title="Watch the video" onPress={() => void Linking.openURL(Api.hubUrl(t.videoUrl!))} />}
            {t.status === "ready" && !t.videoUrl && <Muted small>The video's link has expired; it is still on the hub.</Muted>}
            {WORKING.includes(t.status) && <Button small title="Stop" busy={busy === t.id} onPress={() => cancel(t)} />}
          </Row>
        </Card>
      ))}
      {items && !items.length && (
        <View style={{ gap: 4 }}>
          <Muted>Nothing tried yet.</Muted>
          <Muted small>You can also tell Jarvis: "Kishaunjith sent me a zip on WhatsApp, run it".</Muted>
        </View>
      )}
    </ScrollView>
  );
}
