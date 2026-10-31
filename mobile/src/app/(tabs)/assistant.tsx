import { router } from "expo-router";
import { type ComponentRef, useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Feedback } from "../../components/Feedback";
import { ErrorText } from "../../components/ui";
import { Api } from "../../lib/api";
import { convo, type Turn } from "../../lib/convo";
import { canListen, speak, stopSpeaking, useListen } from "../../lib/listen";
import { openFreshApps } from "../../lib/phone";
import { useColors } from "../../lib/theme";

const SUGGESTIONS = ["What's on my plate today?", "Where is my thrust test sheet?", "What did I decide about Zapprise's colours?", "Which devices are online?"];

/**
 * Talk to the assistant: it looks in your shared memory, uses your devices (safe things at once,
 * anything that changes something waits for Approve on Home) and remembers what it did.
 */
export default function Assistant() {
  const c = useColors();
  const [turns, setTurns] = useState<Turn[]>(convo.get());
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const mic = canListen();
  const listen = useListen((heard) => {
    if (heard) void send(heard, true);
  });

  useEffect(
    () =>
      convo.subscribe((t) => {
        setTurns(t);
        setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
      }),
    [],
  );
  useEffect(() => () => stopSpeaking(), []);

  /** Typed: the full answer on screen. Spoken: a voice request, and the short answer is said aloud. */
  const send = async (said = text, spoken = false) => {
    const you = said.trim();
    if (!you || busy) return;
    if (!spoken) setText("");
    setBusy(true);
    const history = convo.history();
    const turn = convo.add(you, spoken);
    try {
      if (spoken) {
        const r = await Api.talk(you, history);
        turn.reply = r;
        convo.touch();
        void speak(r.say);
      } else turn.reply = await Api.ask(you, history);
      void openFreshApps().catch(() => undefined);
    } catch (e) {
      turn.error = (e as Error).message;
    } finally {
      convo.touch();
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView ref={scroll} contentContainerStyle={{ padding: 18, gap: 18, flexGrow: 1 }} keyboardShouldPersistTaps="handled">
        {!turns.length && (
          <View style={{ gap: 10, marginTop: 12 }}>
            <Text style={{ color: c.text, fontFamily: "serif", fontSize: 26, lineHeight: 34 }}>Ask me anything,{"\n"}or tell me what to do.</Text>
            <Text style={{ color: c.muted, fontSize: 15, lineHeight: 21 }}>
              I check your memory first, then use your devices. Anything that changes a file, runs a command or opens an app waits for your Approve on Home.
              {mic ? " Tap Speak to talk instead of typing, or Talk for a hands-free conversation." : ""}
            </Text>
            {SUGGESTIONS.map((s) => (
              <Pressable key={s} onPress={() => void send(s)} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, paddingVertical: 6 })}>
                <Text style={{ color: c.accent, fontSize: 16 }}>{s}</Text>
              </Pressable>
            ))}
            <Pressable onPress={() => router.push("/talk" as never)} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, paddingVertical: 6 })}>
              <Text style={{ color: c.accent, fontSize: 16, fontWeight: "600" }}>Talk to Jarvis (hands-free) →</Text>
            </Pressable>
          </View>
        )}
        {turns.map((t) => (
          <TurnView key={t.id} t={t} />
        ))}
        {busy && (
          <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
            <ActivityIndicator color={c.accent} />
            <Text style={{ color: c.muted }}>Thinking and checking your devices…</Text>
          </View>
        )}
      </ScrollView>
      <ErrorText text={listen.error} />
      <View style={{ flexDirection: "row", gap: 10, padding: 12, borderTopWidth: 1, borderTopColor: c.border, alignItems: "flex-end" }}>
        <TextInput
          value={listen.listening ? listen.partial : text}
          onChangeText={setText}
          editable={!listen.listening}
          placeholder={listen.listening ? "Listening…" : "Message the assistant"}
          placeholderTextColor={c.muted}
          multiline
          style={{ flex: 1, color: c.text, backgroundColor: c.surface, borderColor: listen.listening ? c.accent : c.border, borderWidth: 1, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9, fontSize: 16, maxHeight: 140 }}
        />
        {mic && !text.trim() ? (
          <Pressable
            disabled={busy}
            onPress={() => (listen.listening ? listen.stop() : void listen.start())}
            onLongPress={() => router.push("/talk" as never)}
            style={({ pressed }) => ({ opacity: busy ? 0.4 : pressed ? 0.6 : 1, paddingVertical: 10 })}
          >
            <Text style={{ color: c.accent, fontSize: 16, fontWeight: "600" }}>{listen.listening ? "Done" : "Speak"}</Text>
          </Pressable>
        ) : (
          <Pressable disabled={busy || !text.trim()} onPress={() => void send()} style={({ pressed }) => ({ opacity: busy || !text.trim() ? 0.4 : pressed ? 0.6 : 1, paddingVertical: 10 })}>
            <Text style={{ color: c.accent, fontSize: 16, fontWeight: "600" }}>Send</Text>
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

function TurnView({ t }: { t: Turn }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <View style={{ alignSelf: "flex-end", maxWidth: "85%", backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 }}>
        <Text style={{ color: c.text, fontSize: 16, fontStyle: t.spoken ? "italic" : "normal" }}>{t.you}</Text>
      </View>
      <ErrorText text={t.error} />
      {t.reply && (
        <View style={{ gap: 6 }}>
          <Text selectable style={{ color: c.text, fontSize: 16, lineHeight: 23 }}>{t.reply.answer}</Text>
          <Feedback episodeId={t.reply.episode_id} used={t.reply.lessons} />
          {t.reply.pending.length > 0 && (
            <Pressable onPress={() => router.navigate("/")}>
              <Text style={{ color: c.warn, fontSize: 14 }}>
                {`${t.reply.pending.length} ${t.reply.pending.length === 1 ? "action is" : "actions are"} waiting for your Approve on Home →`}
              </Text>
            </Pressable>
          )}
          {t.reply.steps.length > 0 && (
            <Pressable onPress={() => setOpen(!open)}>
              <Text style={{ color: c.muted, fontSize: 13 }}>{open ? "Hide what I did" : `What I did (${t.reply.steps.length} ${t.reply.steps.length === 1 ? "step" : "steps"})`}</Text>
            </Pressable>
          )}
          {open &&
            t.reply.steps.map((s, i) => (
              <View key={i} style={{ borderLeftWidth: 2, borderLeftColor: c.border, paddingLeft: 10 }}>
                <Text style={{ color: c.text, fontSize: 13, fontWeight: "600" }}>{`${s.tool}${s.args.action ? ` · ${String(s.args.action)}` : ""}${s.args.device ? ` on ${String(s.args.device)}` : ""}`}</Text>
                <Text selectable style={{ color: c.muted, fontSize: 13 }} numberOfLines={8}>{s.result}</Text>
              </View>
            ))}
        </View>
      )}
    </View>
  );
}
