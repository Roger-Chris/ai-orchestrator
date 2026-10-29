import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from "expo-audio";
import { router } from "expo-router";
import { type ComponentRef, useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ErrorText } from "../components/ui";
import { Api, type PendingApproval, type TalkReply } from "../lib/api";
import { convo, type Turn } from "../lib/convo";
import { canListen, speak, stopSpeaking, useListen } from "../lib/listen";
import { useColors } from "../lib/theme";

/**
 * Talk to Jarvis, hands-free: it listens, you speak, it stops when you pause, thinks with the full
 * assistant (memory, tasks, devices), says a short answer and listens again. Tap the circle to
 * interrupt it or to stop listening. Anything that changes something still waits for a tap on
 * Approve, here on screen. "Bye" or "that's all" ends the conversation.
 *
 * Phones without speech recognition (or an APK built before it was added) record a clip instead:
 * hold the circle to talk, release to send; the hub transcribes it (needs its Groq key).
 */

type Phase = "idle" | "listening" | "thinking" | "speaking";

const CLIP = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, sampleRate: 16_000, bitRate: 32_000 };
const GOODBYE = /^(ok(ay)?\s+)?(bye|goodbye|bye bye|that'?s all|that is all|stop|stop listening|thanks?,? that'?s all|thank you,? that'?s all|end( the)? call)[.!]?$/i;

export default function Talk() {
  const c = useColors();
  const listenable = useRef(canListen()).current;
  const [phase, setPhase] = useState<Phase>("idle");
  const [handsFree, setHandsFree] = useState(listenable);
  const [turns, setTurns] = useState<Turn[]>(convo.get());
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [err, setErr] = useState("");
  const [recording, setRecording] = useState(false);
  const recorder = useAudioRecorder(CLIP);
  const quiet = useRef(0); // listens in a row that heard nothing
  const alive = useRef(true);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);

  useEffect(() => convo.subscribe(setTurns), []);
  useEffect(
    () => () => {
      alive.current = false;
      stopSpeaking();
    },
    [],
  );

  const refreshApprovals = useCallback(async () => {
    try {
      setApprovals((await Api.home()).approvals ?? []);
    } catch {
      /* Home shows them anyway */
    }
  }, []);

  const answered = async (r: TalkReply) => {
    if (r.pending?.length) void refreshApprovals();
    setPhase("speaking");
    await speak(r.say);
    if (!alive.current) return;
    setPhase("idle");
    if (handsRef.current && listenable) void listenAgain();
  };

  const ask = async (heard: string) => {
    const you = heard.trim();
    if (!you) {
      quiet.current++;
      setPhase("idle");
      // two silent listens in a row: stop rather than listen forever
      if (handsRef.current && quiet.current < 2) void listenAgain();
      return;
    }
    quiet.current = 0;
    if (GOODBYE.test(you)) {
      await speak("Okay. Talk later.");
      leave();
      return;
    }
    setPhase("thinking");
    const history = convo.history();
    const turn = convo.add(you, true);
    try {
      const r = await Api.talk(you, history);
      turn.reply = r;
      convo.touch();
      await answered(r);
    } catch (e) {
      turn.error = (e as Error).message;
      convo.touch();
      setPhase("idle");
      void speak("Sorry, that didn't work. The error is on screen.");
    }
  };

  const listen = useListen((heard) => void ask(heard));
  const handsRef = useRef(handsFree);
  handsRef.current = handsFree;

  const listenAgain = async () => {
    if (!alive.current) return;
    if (await listen.start()) setPhase("listening");
  };

  // Start listening as soon as the screen opens.
  useEffect(() => {
    if (listenable) void listenAgain();
    else setErr("Speech recognition isn't available here: hold the circle to talk instead.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (listen.listening) setPhase("listening");
  }, [listen.listening]);
  useEffect(() => {
    setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
  }, [turns, approvals]);

  /** Tap: interrupt Jarvis and listen, or stop listening and send. */
  const tap = () => {
    if (!listenable) return;
    quiet.current = 0;
    if (phase === "listening") listen.stop();
    else if (phase !== "thinking") void listenAgain();
  };

  // Clip fallback: hold to record, release to send.
  const holdStart = async () => {
    if (listenable || phase === "thinking") return;
    stopSpeaking();
    const perm = await requestRecordingPermissionsAsync();
    if (!perm.granted) return setErr("The microphone is off for this app: allow it in Android Settings.");
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    setRecording(true);
    setPhase("listening");
  };
  const holdEnd = async () => {
    if (!recording) return;
    setRecording(false);
    await recorder.stop();
    const uri = recorder.uri;
    if (!uri) return setPhase("idle");
    setPhase("thinking");
    const history = convo.history();
    try {
      const r = await Api.talkClip(uri, history);
      if (r.heard) {
        const turn = convo.add(r.heard, true);
        turn.reply = r;
        convo.touch();
      }
      await answered(r);
    } catch (e) {
      setErr((e as Error).message);
      setPhase("idle");
    }
  };

  const leave = () => {
    alive.current = false;
    listen.cancel();
    stopSpeaking();
    if (router.canGoBack()) router.back();
    else router.replace("/");
  };

  const decide = async (a: PendingApproval, approve: boolean) => {
    try {
      const r = await Api.decideApproval(a.id, approve);
      setApprovals((l) => l.filter((x) => x.id !== a.id));
      void speak(approve ? (r.result?.ok === false ? "That failed. The details are on screen." : "Done.") : "Okay, I won't.");
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const label =
    phase === "listening" ? (listenable ? "Listening… tap when you're done" : "Recording… release to send") : phase === "thinking" ? "Thinking…" : phase === "speaking" ? "Speaking… tap to interrupt" : listenable ? "Tap to talk" : "Hold to talk";
  const recent = turns.slice(-6);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 18, paddingTop: 8 }}>
        <Text style={{ color: c.text, fontSize: 20, fontWeight: "600" }}>Jarvis</Text>
        <View style={{ flexDirection: "row", gap: 18 }}>
          {listenable && (
            <Pressable onPress={() => setHandsFree(!handsFree)}>
              <Text style={{ color: handsFree ? c.accent : c.muted, fontSize: 15 }}>{handsFree ? "Hands-free on" : "Hands-free off"}</Text>
            </Pressable>
          )}
          <Pressable onPress={leave}>
            <Text style={{ color: c.err, fontSize: 15, fontWeight: "600" }}>End</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView ref={scroll} contentContainerStyle={{ padding: 18, gap: 14 }}>
        {!recent.length && <Text style={{ color: c.muted, fontSize: 16, lineHeight: 23 }}>Say what you need: "What's on today?", "Open VS Code on my laptop", "Remind me to call Varun at six".</Text>}
        {recent.map((t) => (
          <View key={t.id} style={{ gap: 6 }}>
            <Text style={{ color: c.muted, fontSize: 15, fontStyle: "italic" }}>{t.you}</Text>
            {t.reply && <Text selectable style={{ color: c.text, fontSize: 17, lineHeight: 24 }}>{t.reply.answer}</Text>}
            <ErrorText text={t.error} />
          </View>
        ))}
        {approvals.map((a) => (
          <View key={a.id} style={{ borderWidth: 1, borderColor: c.warn, borderRadius: 12, padding: 12, gap: 6 }}>
            <Text style={{ color: c.muted, fontSize: 13 }}>{`Waiting for you · on ${a.node}`}</Text>
            <Text style={{ color: c.text, fontSize: 16 }}>{a.summary}</Text>
            <View style={{ flexDirection: "row", gap: 24 }}>
              <Pressable onPress={() => void decide(a, true)}>
                <Text style={{ color: c.accent, fontSize: 16, fontWeight: "600" }}>Approve</Text>
              </Pressable>
              <Pressable onPress={() => void decide(a, false)}>
                <Text style={{ color: c.muted, fontSize: 16 }}>Deny</Text>
              </Pressable>
            </View>
          </View>
        ))}
        {phase === "listening" && !!listen.partial && <Text style={{ color: c.text, fontSize: 17, fontStyle: "italic" }}>{listen.partial}</Text>}
      </ScrollView>

      <ErrorText text={err || listen.error} />
      <View style={{ alignItems: "center", gap: 12, paddingBottom: 28, paddingTop: 8 }}>
        <Pressable
          onPress={tap}
          onPressIn={() => void holdStart()}
          onPressOut={() => void holdEnd()}
          style={({ pressed }) => ({
            width: 112,
            height: 112,
            borderRadius: 56,
            borderWidth: phase === "listening" ? 6 : 2,
            borderColor: c.accent,
            backgroundColor: phase === "listening" ? c.surface : c.bg,
            alignItems: "center",
            justifyContent: "center",
            opacity: pressed ? 0.7 : 1,
          })}
        >
          {phase === "thinking" ? <ActivityIndicator color={c.accent} size="large" /> : <Text style={{ color: c.accent, fontSize: 17, fontWeight: "700" }}>{phase === "listening" ? "Done" : phase === "speaking" ? "Stop" : "Talk"}</Text>}
        </Pressable>
        <Text style={{ color: c.muted, fontSize: 14 }}>{label}</Text>
      </View>
    </SafeAreaView>
  );
}
