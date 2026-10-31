import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from "expo-audio";
import { router, useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { Button, Card, ErrorText, Muted } from "../components/ui";
import { Api, type Convo } from "../lib/api";
import { useColors } from "../lib/theme";

/**
 * Record a live conversation (the app icon's long-press shortcut opens this, already recording).
 * It keeps recording with the screen locked. When you stop, the audio goes to the hub, the laptop's
 * Whisper transcribes it, and tasks to check and notes for Jarvis come back as a notice.
 */

const CLIP = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, sampleRate: 16_000, bitRate: 32_000 };

const STATUS: Record<Convo["status"], string> = {
  waiting: "Waiting for the laptop",
  transcribing: "Transcribing on the laptop",
  thinking: "Reading it",
  saving: "Saving",
  done: "Done",
  failed: "Could not finish",
};

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

export default function Record() {
  const c = useColors();
  const { start } = useLocalSearchParams<{ start?: string }>();
  const navigation = useNavigation() as unknown as { addListener(type: "beforeRemove", fn: (e: { preventDefault(): void }) => void): () => void };
  const recorder = useAudioRecorder(CLIP);
  const [on, setOn] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [items, setItems] = useState<Convo[]>();
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  /** A recording that could not be sent: kept so nothing said is lost. */
  const [unsent, setUnsent] = useState<{ uri: string; seconds: number }>();
  const [loading, setLoading] = useState(false);
  const started = useRef(false);
  const onRef = useRef(false);
  onRef.current = on;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await Api.convos());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));

  // Watch recordings still being worked on while this screen is open.
  useEffect(() => {
    if (!items?.some((x) => x.status !== "done" && x.status !== "failed")) return;
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [items, load]);

  useEffect(() => {
    if (!on) return;
    const from = Date.now();
    const t = setInterval(() => setSeconds(Math.round((Date.now() - from) / 1000)), 1000);
    return () => clearInterval(t);
  }, [on]);

  // Leaving the screen would end the recording: say so instead of losing it.
  useEffect(
    () =>
      navigation.addListener("beforeRemove", (e) => {
        if (!onRef.current) return;
        e.preventDefault();
        setError("Stop the recording first, so it is saved.");
      }),
    [navigation],
  );

  const begin = useCallback(async () => {
    setError("");
    try {
      const p = await requestRecordingPermissionsAsync();
      if (!p.granted) throw new Error("Allow the microphone for Orchestrator, then try again.");
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true, allowsBackgroundRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setSeconds(0);
      setOn(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [recorder]);

  const send = useCallback(
    async (uri: string, length: number) => {
      setSending(true);
      setError("");
      try {
        await Api.convoUpload(uri, length);
        setUnsent(undefined);
        await load();
      } catch (e) {
        setUnsent({ uri, seconds: length });
        setError(`${(e as Error).message} The recording is safe on this phone: tap Send again.`);
      } finally {
        setSending(false);
      }
    },
    [load],
  );

  const stop = async () => {
    const length = seconds;
    try {
      await recorder.stop();
      setOn(false);
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true, allowsBackgroundRecording: false });
      if (recorder.uri) await send(recorder.uri, length);
      else setError("The phone did not keep a recording.");
    } catch (e) {
      setOn(false);
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    if (start && !started.current) {
      started.current = true;
      void begin();
    }
  }, [start, begin]);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16, gap: 12 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}>
      <Card attention={on}>
        <Text style={{ color: c.text, fontSize: 40, fontWeight: "700", fontVariant: ["tabular-nums"] }}>{clock(on ? seconds : 0)}</Text>
        <Muted small>{on ? "Recording. You can lock the phone. Stay on this screen to keep it going." : "Records the conversation, transcribes it on your laptop, and adds tasks and notes for Jarvis. Let people know you are recording."}</Muted>
        <View style={{ marginTop: 12 }}>
          {on ? <Button kind="primary" title="Stop and send" onPress={() => void stop()} /> : <Button kind="primary" title="Start recording" busy={sending} onPress={() => void begin()} />}
        </View>
        {!!unsent && !on && (
          <View style={{ marginTop: 8 }}>
            <Button title="Send again" busy={sending} onPress={() => void send(unsent.uri, unsent.seconds)} />
          </View>
        )}
        <ErrorText text={error} />
      </Card>

      {items?.map((x) => (
        <Card key={x.id}>
          <Muted small>{`${new Date(x.createdAt).toLocaleString()}${x.durationSec ? ` · ${clock(Math.round(x.durationSec))}` : ""} · ${STATUS[x.status]}`}</Muted>
          {!!x.summary && <Text style={{ color: c.text, marginTop: 6 }}>{x.summary}</Text>}
          {!x.summary && x.status !== "done" && !!x.error && <Muted small>{x.error}</Muted>}
          {x.status === "failed" && <Button small title="Try again" onPress={() => void Api.convoRetry(x.id).then(load, (e: Error) => setError(e.message))} />}
          {x.tasks.length > 0 && <Button small title={`${x.tasks.length} task${x.tasks.length === 1 ? "" : "s"} to check`} onPress={() => router.push("/tasks")} />}
        </Card>
      ))}
    </ScrollView>
  );
}
