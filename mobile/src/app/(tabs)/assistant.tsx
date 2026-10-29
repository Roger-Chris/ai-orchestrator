import { router } from "expo-router";
import { type ComponentRef, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { ErrorText } from "../../components/ui";
import { Api, type AssistantReply } from "../../lib/api";
import { useColors } from "../../lib/theme";

interface Turn {
  id: number;
  you: string;
  reply?: AssistantReply;
  error?: string;
}

/** Kept for the whole app session, so switching tabs doesn't lose the conversation. */
let log: Turn[] = [];
let nextId = 1;

const SUGGESTIONS = ["What's on my plate today?", "Where is my thrust test sheet?", "What did I decide about Zapprise's colours?", "Which devices are online?"];

/**
 * Talk to the assistant: it looks in your shared memory, uses your devices (safe things at once,
 * anything that changes something waits for Approve on Home) and remembers what it did.
 */
export default function Assistant() {
  const c = useColors();
  const [turns, setTurns] = useState<Turn[]>(log);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);

  const update = (t: Turn[]) => {
    log = t;
    setTurns(t);
    setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
  };

  const send = async (said = text) => {
    const you = said.trim();
    if (!you || busy) return;
    setText("");
    setBusy(true);
    // the last three exchanges go along, so "open it" or "and the other one?" work
    const history = log
      .filter((t) => t.reply)
      .slice(-3)
      .flatMap((t) => [
        { role: "user" as const, content: t.you },
        { role: "assistant" as const, content: t.reply!.answer },
      ]);
    const turn: Turn = { id: nextId++, you };
    update([...log, turn]);
    try {
      turn.reply = await Api.ask(you, history);
    } catch (e) {
      turn.error = (e as Error).message;
    } finally {
      update([...log]);
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
            </Text>
            {SUGGESTIONS.map((s) => (
              <Pressable key={s} onPress={() => void send(s)} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, paddingVertical: 6 })}>
                <Text style={{ color: c.accent, fontSize: 16 }}>{s}</Text>
              </Pressable>
            ))}
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
      <View style={{ flexDirection: "row", gap: 10, padding: 12, borderTopWidth: 1, borderTopColor: c.border, alignItems: "flex-end" }}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Message the assistant"
          placeholderTextColor={c.muted}
          multiline
          style={{ flex: 1, color: c.text, backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9, fontSize: 16, maxHeight: 140 }}
        />
        <Pressable disabled={busy || !text.trim()} onPress={() => void send()} style={({ pressed }) => ({ opacity: busy || !text.trim() ? 0.4 : pressed ? 0.6 : 1, paddingVertical: 10 })}>
          <Text style={{ color: c.accent, fontSize: 16, fontWeight: "600" }}>Send</Text>
        </Pressable>
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
        <Text style={{ color: c.text, fontSize: 16 }}>{t.you}</Text>
      </View>
      <ErrorText text={t.error} />
      {t.reply && (
        <View style={{ gap: 6 }}>
          <Text selectable style={{ color: c.text, fontSize: 16, lineHeight: 23 }}>{t.reply.answer}</Text>
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
