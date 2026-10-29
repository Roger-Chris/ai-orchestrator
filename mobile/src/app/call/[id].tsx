import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from "expo-audio";
import { router, useLocalSearchParams } from "expo-router";
import { speak as say, stopSpeaking } from "../../lib/voice";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, Vibration, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, ErrorText, Field } from "../../components/ui";
import { Api, type BrainAlert, type CallTurn, Calls, NeedsText } from "../../lib/api";
import { useColors } from "../../lib/theme";

/**
 * The alarm and call screen for one brain alert.
 * - level 3 (alarm): rings; answer with Done / Snooze / Not important, or talk it through.
 * - level 4 (call), or "Call me about this" from Home: Answer / Decline, then a push-to-talk call.
 * Jarvis speaks with the voice chosen in Settings (the hub's, or the phone's own text-to-speech); you hold the mic to talk and release to send.
 * The hub hears it (Groq Whisper) and can only do safe things (src/calls/desk.ts).
 */

type Phase = "loading" | "ringing" | "connecting" | "talking" | "over" | "gone";
type Line = { who: "assistant" | "owner"; text: string };

/** Mono, 16 kHz AAC: small clips that Whisper reads well. */
const CLIP = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, sampleRate: 16_000, bitRate: 32_000 };
const RING = [0, 900, 600, 900, 600];

export default function CallScreen() {
  const c = useColors();
  const params = useLocalSearchParams<{ id: string; talk?: string }>();
  const alertId = Number(params.id);
  const [alert, setAlert] = useState<BrainAlert>();
  const [phase, setPhase] = useState<Phase>("loading");
  const [voice, setVoice] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [typed, setTyped] = useState("");
  const [err, setErr] = useState("");
  const recorder = useAudioRecorder(CLIP);
  const scroll = useRef<{ scrollToEnd: (o?: { animated?: boolean }) => void } | null>(null);
  const ended = useRef(false);

  const add = (who: Line["who"], text: string) => setLines((l) => [...l, { who, text }]);
  const speak = (text: string) => void say(text);

  // Load the alert. A call (level 4) rings; an alarm (level 3) shows its own buttons; "talk" skips ringing.
  useEffect(() => {
    let live = true;
    Calls.info(alertId)
      .then((info) => {
        if (!live) return;
        setAlert(info.alert);
        setVoice(info.voice);
        setLines(info.lines.map((l) => ({ who: l.who, text: l.text })));
        if (info.ended) setPhase("over");
        else if (params.talk) void answer();
        else setPhase("ringing");
      })
      .catch((e) => {
        if (!live) return;
        setErr((e as Error).message);
        setPhase("gone");
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertId]);

  // Vibrate while it rings; stop on any answer or on leaving the screen.
  useEffect(() => {
    if (phase === "ringing") Vibration.vibrate(RING, true);
    else Vibration.cancel();
    return () => Vibration.cancel();
  }, [phase]);

  useEffect(
    () => () => {
      stopSpeaking();
      if (!ended.current) Calls.end(alertId).catch(() => {});
    },
    [alertId],
  );

  const answer = useCallback(async () => {
    setPhase("connecting");
    setErr("");
    try {
      const r = await Calls.answer(alertId);
      setVoice(r.voice);
      if (r.voice) {
        const perm = await requestRecordingPermissionsAsync();
        if (!perm.granted) {
          setVoice(false);
          setErr("The microphone is off for this app, so type instead (or allow it in Android Settings).");
        } else await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      }
      setLines((l) => (l.length ? l : [{ who: "assistant", text: r.say }]));
      setPhase("talking");
      speak(r.say);
    } catch (e) {
      setErr((e as Error).message);
      setPhase("talking");
    }
  }, [alertId]);

  const finish = async (how: "end" | "done" | "snooze" | "dismiss") => {
    stopSpeaking();
    if (recording) await recorder.stop().catch(() => {});
    setBusy(true);
    setErr("");
    try {
      if (how === "end") await Calls.end(alertId).catch(() => {});
      else await Api.ackAlert(alertId, how);
      ended.current = true;
      if (router.canGoBack()) router.back();
      else router.replace("/");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handle = (t: CallTurn) => {
    if (t.transcript) add("owner", t.transcript);
    add("assistant", t.say);
    speak(t.say);
    if (t.done) {
      ended.current = true;
      setPhase("over");
    }
  };

  const startTalking = async () => {
    if (busy || phase !== "talking") return;
    setErr("");
    stopSpeaking();
    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecording(true);
    } catch (e) {
      setErr(`Couldn't start the microphone: ${(e as Error).message}`);
    }
  };

  const stopTalking = async () => {
    if (!recording) return;
    setRecording(false);
    setBusy(true);
    try {
      await recorder.stop();
      const uri = recorder.uri;
      if (!uri) throw new Error("Nothing was recorded.");
      handle(await Calls.voice(alertId, uri));
    } catch (e) {
      // The hub can't hear voice (no Groq key): type instead.
      if (e instanceof NeedsText) setVoice(false);
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sendTyped = async () => {
    const text = typed.trim();
    if (!text) return;
    setBusy(true);
    setErr("");
    try {
      handle(await Calls.say(alertId, text));
      setTyped("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const isCall = (alert?.level ?? 4) >= 4 || !!params.talk;
  const big = { color: c.text, fontSize: 24, fontWeight: "700" as const, textAlign: "center" as const };

  if (phase === "loading") {
    return (
      <SafeAreaView style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: c.bg }}>
        <ActivityIndicator color={c.accent} />
      </SafeAreaView>
    );
  }

  if (phase === "gone" || !alert) {
    return (
      <SafeAreaView style={{ flex: 1, padding: 24, gap: 16, justifyContent: "center", backgroundColor: c.bg }}>
        <Text style={big}>Nothing to answer</Text>
        <Text style={{ color: c.muted, textAlign: "center" }}>{err || "This alert is no longer open."}</Text>
        <Button title="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))} />
      </SafeAreaView>
    );
  }

  // Ringing: a call shows Answer / Decline; an alarm shows its answers and "Talk it through".
  if (phase === "ringing") {
    return (
      <SafeAreaView style={{ flex: 1, padding: 24, justifyContent: "space-between", backgroundColor: c.bg }}>
        <View style={{ gap: 12, marginTop: 40 }}>
          <Text style={{ color: c.muted, textAlign: "center", fontSize: 15 }}>{isCall ? "Your assistant is calling" : "Alarm"}</Text>
          <Text style={big}>{alert.title}</Text>
          {!!alert.body && <Text style={{ color: c.muted, textAlign: "center", fontSize: 16, lineHeight: 22 }}>{alert.body}</Text>}
        </View>
        {isCall ? (
          <View style={{ flexDirection: "row", justifyContent: "space-around", marginBottom: 40 }}>
            <RoundButton label="Decline" color={c.err} onPress={() => void finish("end")} />
            <RoundButton label="Answer" color={c.ok} onPress={() => void answer()} />
          </View>
        ) : (
          <View style={{ gap: 10, marginBottom: 24 }}>
            <Button title="Done" kind="primary" busy={busy} onPress={() => void finish("done")} />
            <Button title="Snooze 1 h" disabled={busy} onPress={() => void finish("snooze")} />
            <Button title="Not important" disabled={busy} onPress={() => void finish("dismiss")} />
            <Button title="Talk it through" disabled={busy} onPress={() => void answer()} />
            <ErrorText text={err} />
          </View>
        )}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ padding: 16, paddingBottom: 8, gap: 4 }}>
        <Text style={{ color: c.muted, fontSize: 13 }}>{phase === "over" ? "Call ended" : phase === "connecting" ? "Connecting…" : "On a call with your assistant"}</Text>
        <Text style={{ color: c.text, fontSize: 18, fontWeight: "700" }}>{alert.title}</Text>
      </View>
      <ScrollView ref={scroll as never} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })} contentContainerStyle={{ padding: 16, gap: 10 }}>
        {lines.map((l, i) => (
          <View
            key={i}
            style={{
              alignSelf: l.who === "owner" ? "flex-end" : "flex-start",
              maxWidth: "88%",
              backgroundColor: l.who === "owner" ? c.accentSoft : c.surface,
              borderColor: c.border,
              borderWidth: 1,
              borderRadius: 12,
              padding: 10,
            }}
          >
            <Text style={{ color: c.text, fontSize: 15, lineHeight: 21 }}>{l.text}</Text>
          </View>
        ))}
        {(phase === "connecting" || busy) && <ActivityIndicator color={c.accent} />}
      </ScrollView>

      <View style={{ padding: 16, gap: 12, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.surface }}>
        <ErrorText text={err} />
        {phase === "talking" &&
          (voice ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Hold to talk"
              onPressIn={() => void startTalking()}
              onPressOut={() => void stopTalking()}
              disabled={busy}
              style={{ height: 72, borderRadius: 36, alignItems: "center", justifyContent: "center", backgroundColor: recording ? c.err : c.accent, opacity: busy ? 0.5 : 1 }}
            >
              <Text style={{ color: c.accentInk, fontSize: 17, fontWeight: "700" }}>{recording ? "Listening… release to send" : busy ? "Thinking…" : "Hold to talk"}</Text>
            </Pressable>
          ) : (
            <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-end" }}>
              <View style={{ flex: 1 }}>
                <Field value={typed} onChangeText={setTyped} placeholder="Type your answer" multiline onSubmitEditing={() => void sendTyped()} />
              </View>
              <Button title="Send" kind="primary" busy={busy} disabled={!typed.trim()} onPress={() => void sendTyped()} />
            </View>
          ))}
        {/* Always here, whatever the model does. */}
        <View style={{ flexDirection: "row", gap: 8 }}>
          {phase !== "over" && (
            <>
              <View style={{ flex: 1 }}>
                <Button title="Done" small disabled={busy} onPress={() => void finish("done")} />
              </View>
              <View style={{ flex: 1 }}>
                <Button title="Snooze 1 h" small disabled={busy} onPress={() => void finish("snooze")} />
              </View>
            </>
          )}
          <View style={{ flex: 1 }}>
            <Button title={phase === "over" ? "Close" : "End call"} kind="danger" small disabled={busy && phase !== "over"} onPress={() => void finish("end")} />
          </View>
        </View>
      </View>
    </SafeAreaView>
  );
}

function RoundButton({ label, color, onPress }: { label: string; color: string; onPress: () => void }) {
  const c = useColors();
  return (
    <View style={{ alignItems: "center", gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => ({ width: 76, height: 76, borderRadius: 38, backgroundColor: color, opacity: pressed ? 0.7 : 1 })} />
      <Text style={{ color: c.text, fontSize: 15 }}>{label}</Text>
    </View>
  );
}
