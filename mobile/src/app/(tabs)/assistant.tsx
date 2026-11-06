import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { type ComponentRef, useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Keyboard, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useKeyboardLift, useTabSpace } from "../../components/FloatingTabs";
import { Feedback } from "../../components/Feedback";
import { Button, ErrorText, Press } from "../../components/ui";
import { Api, type PendingApproval, type ShopRun } from "../../lib/api";
import { convo, type Turn } from "../../lib/convo";
import { canListen, speak, stopSpeaking, useListen } from "../../lib/listen";
import { openFreshApps } from "../../lib/phone";
import { useColors } from "../../lib/theme";

const GOODBYE = /^(ok(ay)?\s+)?(bye|goodbye|bye bye|that'?s all|that is all|stop|stop listening|thanks?,? that'?s all|thank you,? that'?s all)[.!]?$/i;
const SUGGESTIONS = ["What's on my plate today?", "Where is my thrust test sheet?", "What did I decide about Zapprise's colours?", "Which devices are online?"];

/**
 * Talking to Jarvis, typed or spoken, all on this one screen. The mic starts a conversation: it
 * listens until you pause, the answer appears as Jarvis starts saying it, then it listens again.
 * "Bye", two silences or a tap end it. Anything that changes something waits for Approve, right here.
 * Phones without speech recognition go to the Talk screen, which records a clip instead.
 */
export default function Assistant() {
  const c = useColors();
  const [turns, setTurns] = useState<Turn[]>(convo.get());
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const space = useTabSpace();
  const screen = useRef<ComponentRef<typeof View>>(null);
  const lift = useKeyboardLift(screen);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const mic = canListen();
  const talking = useRef(false); // in a spoken conversation: listen again after each answer
  const silences = useRef(0);
  const params = useLocalSearchParams<{ say?: string; listen?: string }>();

  const listen = useListen((heard) => void onHeard(heard));

  const onHeard = async (heard: string) => {
    if (!heard) {
      silences.current++;
      if (talking.current && silences.current < 2) void listen.start();
      else talking.current = false;
      return;
    }
    silences.current = 0;
    if (GOODBYE.test(heard)) {
      talking.current = false;
      await speak("Okay. Talk later.");
      return;
    }
    await send(heard, true);
  };

  useEffect(
    () =>
      convo.subscribe((t) => {
        setTurns(t);
        setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 50);
      }),
    [],
  );

  // Leaving the screen ends the conversation; nobody wants Jarvis talking over another screen.
  useFocusEffect(
    useCallback(
      () => () => {
        talking.current = false;
        listen.cancel();
        stopSpeaking();
        setSpeaking(false);
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [],
    ),
  );

  // "Hey Jarvis" lands here, with the question or ready to listen.
  useEffect(() => {
    if (params.say?.trim()) {
      talking.current = true;
      void send(params.say, true);
      router.setParams({ say: undefined });
    } else if (params.listen) {
      startTalking();
      router.setParams({ listen: undefined });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.say, params.listen]);

  const startTalking = () => {
    talking.current = true;
    silences.current = 0;
    setSpeaking(false);
    void listen.start();
  };

  /** Typed: the full answer on screen. Spoken: the answer appears as Jarvis starts saying it. */
  const send = async (said = text, spoken = false) => {
    const you = said.trim();
    if (!you || busy) return;
    if (!spoken) {
      setText("");
      Keyboard.dismiss();
    }
    setBusy(true);
    const history = convo.history();
    const turn = convo.add(you, spoken);
    try {
      if (spoken) {
        const r = await Api.talk(you, history);
        void openFreshApps().catch(() => undefined);
        if (r.pending?.length) void refreshApprovals();
        const show = () => {
          turn.reply = r;
          convo.touch();
          setBusy(false);
          setSpeaking(true);
        };
        await speak(r.say, show);
        if (!turn.reply) show(); // interrupted before any sound: the words still show
        setSpeaking(false);
        if (talking.current) void listen.start();
      } else {
        turn.reply = await Api.ask(you, history);
        void openFreshApps().catch(() => undefined);
        if (turn.reply.pending?.length) void refreshApprovals();
      }
    } catch (e) {
      turn.error = (e as Error).message;
      talking.current = false;
    } finally {
      convo.touch();
      setBusy(false);
    }
  };

  const refreshApprovals = async () => {
    try {
      setApprovals((await Api.home()).approvals ?? []);
    } catch {
      /* they are on Today anyway */
    }
  };

  const decide = async (a: PendingApproval, approve: boolean) => {
    setApprovals((l) => l.filter((x) => x.id !== a.id));
    const turn = convo.add(approve ? `Approved: ${a.summary}` : `Denied: ${a.summary}`);
    try {
      const r = await Api.decideApproval(a.id, approve);
      const answer = approve ? (r.result?.output?.trim() || "Done.") : "Okay, I won't.";
      turn.reply = { answer, steps: [], pending: [], episode_id: 0, lessons: [] } as unknown as Turn["reply"];
    } catch (e) {
      turn.error = (e as Error).message;
    }
    convo.touch();
  };

  const tapMic = () => {
    if (!mic) return router.push("/talk" as never);
    if (listen.listening) {
      talking.current = false;
      listen.stop();
    } else if (speaking) {
      stopSpeaking();
      startTalking();
    } else startTalking();
  };

  const typed = !!text.trim();
  const inConversation = listen.listening || speaking;
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <View ref={screen} collapsable={false} style={{ flex: 1 }}>
        <ScrollView ref={scroll} contentContainerStyle={{ padding: 18, paddingBottom: space + lift + 84, gap: 18, flexGrow: 1 }} keyboardShouldPersistTaps="handled">
          {!turns.length && (
            <View style={{ gap: 10, marginTop: 12 }}>
              <Text style={{ color: c.text, fontWeight: "700", fontSize: 26, lineHeight: 32 }}>Ask me anything,{"\n"}or tell me what to do.</Text>
              <Text style={{ color: c.muted, fontSize: 15, lineHeight: 21 }}>Type, or tap the mic and talk. I check your memory first, then use your devices. Anything that changes something waits for your Approve.</Text>
              {SUGGESTIONS.map((s) => (
                <Pressable key={s} onPress={() => void send(s)} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, paddingVertical: 6 })}>
                  <Text style={{ color: c.accent, fontSize: 16 }}>{s}</Text>
                </Pressable>
              ))}
            </View>
          )}
          {turns.length > 0 && (
            <Pressable accessibilityRole="button" onPress={() => convo.clear()} hitSlop={8} style={{ alignSelf: "center" }}>
              <Text style={{ color: c.muted, fontSize: 13 }}>Clear this chat</Text>
            </Pressable>
          )}
          {turns.map((t) => (
            <TurnView key={t.id} t={t} />
          ))}
          {approvals.map((a) => (
            <View key={a.id} style={{ backgroundColor: c.warnSoft, borderColor: c.warn, borderWidth: 1, borderRadius: 16, padding: 14, gap: 8 }}>
              <Text style={{ color: c.muted, fontSize: 13 }}>{`Waiting for you · on ${a.node}`}</Text>
              <Text style={{ color: c.text, fontSize: 16 }}>{a.summary}</Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Button small kind="primary" title="Approve" onPress={() => void decide(a, true)} />
                <Button small kind="danger" title="Deny" onPress={() => void decide(a, false)} />
              </View>
            </View>
          ))}
          {busy && (
            <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
              <ActivityIndicator color={c.accent} />
              <Text style={{ color: c.muted }}>Thinking and checking your devices…</Text>
            </View>
          )}
        </ScrollView>
        <View pointerEvents="box-none" style={{ position: "absolute", left: 16, right: 16, bottom: lift ? lift + 8 : space + 4, gap: 6 }}>
          <ErrorText text={listen.error} />
          <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-end", backgroundColor: c.surface, borderColor: listen.listening ? c.accent : c.border, borderWidth: 1, borderRadius: 26, padding: 5, paddingLeft: 16, boxShadow: "0 6px 18px rgba(40, 25, 5, 0.14)" }}>
            <TextInput
              value={listen.listening ? listen.partial : text}
              onChangeText={setText}
              editable={!listen.listening}
              placeholder={listen.listening ? "Listening…" : "Message Jarvis"}
              placeholderTextColor={c.muted}
              multiline
              style={{ flex: 1, color: c.text, fontSize: 16, paddingVertical: 8, maxHeight: 130 }}
            />
            <Press
              accessibilityRole="button"
              accessibilityLabel={typed ? "Send" : listen.listening ? "Stop listening" : speaking ? "Interrupt Jarvis" : "Talk to Jarvis"}
              disabled={busy && !speaking}
              onPress={typed ? () => void send() : tapMic}
              style={{ minWidth: 42, height: 42, paddingHorizontal: inConversation ? 14 : 0, borderRadius: 21, backgroundColor: c.accent, alignItems: "center", justifyContent: "center", opacity: busy && !speaking ? 0.5 : 1 }}
            >
              {typed ? <Text style={{ color: c.accentInk, fontSize: 20, fontWeight: "700", lineHeight: 23 }}>↑</Text> : inConversation ? <Text style={{ color: c.accentInk, fontWeight: "600" }}>{listen.listening ? "Done" : "Stop"}</Text> : <MicIcon color={c.accentInk} />}
            </Press>
          </View>
        </View>
      </View>
    </View>
  );
}

/** A microphone drawn from plain views, like the tab icons. */
function MicIcon({ color }: { color: string }) {
  return (
    <View style={{ width: 22, height: 24, alignItems: "center" }}>
      <View style={{ width: 9, height: 14, borderRadius: 5, backgroundColor: color }} />
      <View style={{ position: "absolute", top: 7, width: 16, height: 11, borderWidth: 2, borderTopWidth: 0, borderColor: color, borderBottomLeftRadius: 8, borderBottomRightRadius: 8 }} />
      <View style={{ position: "absolute", top: 18, width: 2, height: 4, backgroundColor: color }} />
      <View style={{ position: "absolute", top: 22, width: 10, height: 2, backgroundColor: color }} />
    </View>
  );
}

/** The brain's reply is written when shopping starts, so the result is fetched here until it ends. */
function ShopLine({ id }: { id: string }) {
  const c = useColors();
  const [run, setRun] = useState<ShopRun>();
  const working = !run || run.status === "working";
  useEffect(() => {
    if (!working) return;
    const load = () => void Api.shopRun(id).then(setRun).catch(() => undefined);
    load();
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [id, working]);
  const line = working
    ? "Shopping: still working…"
    : run.status === "ready" || run.status === "checkout" || run.status === "ordered"
      ? `Completed: ${run.storeName} cart, ${run.total ?? "total on the cart"} →`
      : run.status === "link"
        ? `Completed: best at ${run.storeName}, open the link →`
        : run.status === "dismissed"
          ? "Shopping: dismissed"
          : `Shopping stopped (${run.status.replace("_", " ")}): ${run.storeName} →`;
  return (
    <Pressable onPress={() => router.push(`/shop?id=${id}` as never)}>
      <Text style={{ color: c.accent, fontSize: 14 }}>{line}</Text>
    </Pressable>
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
          {t.reply.steps.map((s) => s.tool === "shop" && s.result.match(/\(run (s[0-9a-f]+)\)/)?.[1]).filter((id): id is string => !!id).map((id) => <ShopLine key={id} id={id} />)}
          <Feedback episodeId={t.reply.episode_id} used={t.reply.lessons} />
          {t.reply.pending.some((p) => p.action === "mail.draft") && (
            <Pressable onPress={() => router.push("/mail" as never)}>
              <Text style={{ color: c.accent, fontSize: 14 }}>The mail is ready: check it and tap Send →</Text>
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
