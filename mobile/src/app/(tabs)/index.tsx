import { router, useFocusEffect } from "expo-router";
import { type ReactNode, useCallback, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Linking, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ErrorText } from "../../components/ui";
import { type AlertAction, Api, type Attention, type BrainAlert, type DayTask, type Decision, type Home as HomeData, type HomeBuild, hubUrl, type PendingApproval, type QuietChat, type ReplyDraft, type Running, Unauthorized } from "../../lib/api";
import { useColors } from "../../lib/theme";
import { openWhatsApp } from "../../lib/whatsapp";

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return m < 2880 ? "yesterday" : `${Math.round(m / 1440)} days ago`;
}

const SOURCE = { gmail: "Gmail", whatsapp: "WhatsApp", manual: "Added by you" };

const open = (threadId?: string) => threadId && router.push(`/t/${threadId}`);

function headline(h: HomeData): string {
  const tasks = h.tasks.filter((t) => !t.done).length;
  const decisions = h.decisions.length;
  const replies = h.replies?.length ?? 0; // an older hub sends none
  const alerts = h.alerts?.length ?? 0;
  const approvals = h.approvals?.length ?? 0; // an older hub sends none
  const toTry = h.builds?.filter((b) => b.preview === "ready").length ?? 0;
  const parts = [
    approvals && `${approvals} ${approvals === 1 ? "action" : "actions"} to approve`,
    toTry && `${toTry} ${toTry === 1 ? "build" : "builds"} to try`,
    alerts && `${alerts} ${alerts === 1 ? "thing needs" : "things need"} you`,
    tasks && `${tasks} ${tasks === 1 ? "task" : "tasks"} today`,
    replies && `${replies} ${replies === 1 ? "reply" : "replies"} to send`,
    decisions && `${decisions} ${decisions === 1 ? "decision" : "decisions"} waiting`,
  ].filter(Boolean);
  if (parts.length) return `${parts.join(",\n")}.`.replace(/^./, (s) => s.toUpperCase());
  return h.attention.length ? "Nothing needs you,\na few things to look at." : "Nothing needs you\nright now.";
}

/** A section: a small label with a count or link on the right, then its rows. */
function Section({ label, right, children }: { label: string; right?: ReactNode; children: ReactNode }) {
  const c = useColors();
  return (
    <View style={{ marginTop: 28 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <Text style={{ color: c.muted, fontSize: 13 }}>{label}</Text>
        {typeof right === "string" || typeof right === "number" ? <Text style={{ color: c.muted, fontSize: 13 }}>{right}</Text> : right}
      </View>
      {children}
    </View>
  );
}

function Row({ first, children, onPress }: { first?: boolean; children: ReactNode; onPress?: () => void }) {
  const c = useColors();
  const style = { paddingVertical: 12, borderTopWidth: first ? 0 : 1, borderTopColor: c.border };
  // A row without its own tap is a plain View: a disabled Pressable around Approve / Deny disabled
  // those buttons too (found by tapping Approve in a browser test of the app).
  if (!onPress) return <View style={style}>{children}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ ...style, opacity: pressed ? 0.6 : 1 })}>
      {children}
    </Pressable>
  );
}

function TextLink({ title, onPress, color }: { title: string; onPress: () => void; color?: string }) {
  const c = useColors();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} hitSlop={8}>
      {({ pressed }) => <Text style={{ color: color ?? c.accent, fontSize: 15, fontWeight: "500", opacity: pressed ? 0.6 : 1 }}>{title}</Text>}
    </Pressable>
  );
}

function TaskRow({ t, first, onToggle }: { t: DayTask; first: boolean; onToggle: () => void }) {
  const c = useColors();
  return (
    <Row first={first}>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: t.done }} accessibilityLabel={t.title} onPress={onToggle} hitSlop={6} style={{ flexDirection: "row", gap: 12 }}>
        <Text style={{ width: 54, color: c.muted, fontSize: 14, paddingTop: 1, fontVariant: ["tabular-nums"] }}>{t.time ?? "today"}</Text>
        <View style={{ width: 18, height: 18, marginTop: 2, borderRadius: 4, borderWidth: 1.5, borderColor: t.done ? c.text : c.muted, backgroundColor: t.done ? c.text : "transparent", alignItems: "center", justifyContent: "center" }}>
          {t.done && <Text style={{ color: c.bg, fontSize: 12, fontWeight: "700", lineHeight: 14 }}>✓</Text>}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: t.done ? c.muted : c.text, fontSize: 16, textDecorationLine: t.done ? "line-through" : "none" }}>{t.title}</Text>
          <Text style={{ color: c.muted, fontSize: 13, marginTop: 2 }}>{[SOURCE[t.source], t.detail].filter(Boolean).join(" · ")}</Text>
        </View>
      </Pressable>
    </Row>
  );
}

const ALERT_KIND: Record<string, string> = { brief: "Morning brief", question: "Someone is waiting", overdue: "Overdue", new_task: "New task" };

/** Something the brain decided needs you. Your answer goes back to the brain; done also finishes the task. */
/** Something the assistant wants to do on one of your devices. Nothing happens until Approve. */
function ApprovalRow({ a, first, onDone }: { a: PendingApproval; first: boolean; onDone: () => void }) {
  const c = useColors();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [out, setOut] = useState("");
  const decide = async (approve: boolean) => {
    setBusy(true);
    setErr("");
    try {
      const r = await Api.decideApproval(a.id, approve);
      if (approve && r.result) setOut(`${r.result.ok ? "Done" : "Failed"}: ${r.result.output.slice(0, 300)}`);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const left = Math.max(0, Math.round((a.expiresAt - Date.now()) / 60_000));
  const outside = !!a.by?.startsWith("agent:");
  return (
    <Row first={first}>
      <Text style={{ color: outside ? c.warn : c.muted, fontSize: 13 }}>{`${outside ? `Asked by outside agent ${a.by!.slice(6)} · ` : ""}On ${a.node} · ${ago(a.since)} · ${left} min left`}</Text>
      <Text style={{ color: c.text, fontSize: 16, marginTop: 3 }}>{a.summary}</Text>
      {!!a.reason && <Text style={{ color: c.muted, fontSize: 14, lineHeight: 20, marginTop: 3 }}>{`Why: ${a.reason}`}</Text>}
      <View style={{ flexDirection: "row", gap: 20, marginTop: 10, alignItems: "center" }}>
        <TextLink title="Approve" onPress={() => void decide(true)} />
        <TextLink title="Deny" color={c.muted} onPress={() => void decide(false)} />
        {busy && <ActivityIndicator color={c.accent} />}
      </View>
      {!!out && <Text style={{ color: c.muted, fontSize: 13, marginTop: 6 }}>{out}</Text>}
      <ErrorText text={err} />
    </Row>
  );
}

/** A build to try (U1): open its preview or install its APK here; Merge stays on the Builds screen. */
function BuildRow({ b, first }: { b: HomeBuild; first: boolean }) {
  const c = useColors();
  const base = hubUrl() ?? "";
  const state =
    b.status === "running" ? "Building…" : b.status === "failed" ? "Build failed" : b.preview === "ready" ? "Ready to try" : b.preview === "building" ? "Making the preview…" : b.preview === "failed" ? "Preview failed" : "Ready to review";
  return (
    <Row first={first} onPress={() => router.push(`/builds?id=${b.id}` as never)}>
      <Text style={{ color: b.status === "failed" || b.preview === "failed" ? c.err : c.muted, fontSize: 13 }}>{`${state} · ${ago(b.at)}${b.notes ? ` · ${b.notes} step${b.notes === 1 ? "" : "s"} did not run` : ""}`}</Text>
      <Text style={{ color: c.text, fontSize: 16, marginTop: 3 }}>{b.name}</Text>
      <View style={{ flexDirection: "row", gap: 20, marginTop: 10 }}>
        {!!b.web && <TextLink title="Open preview" onPress={() => void Linking.openURL(`${base}${b.web}`)} />}
        {!!b.apk && <TextLink title="Install APK" onPress={() => void Linking.openURL(`${base}${b.apk}`)} />}
        <TextLink title="Review →" color={c.muted} onPress={() => router.push(`/builds?id=${b.id}` as never)} />
      </View>
    </Row>
  );
}

function AlertRow({ a, first, onDone }: { a: BrainAlert; first: boolean; onDone: () => void }) {
  const c = useColors();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [more, setMore] = useState(false);
  const answer = async (action: AlertAction) => {
    setBusy(true);
    setErr("");
    try {
      await Api.ackAlert(a.id, action);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const since = a.created_at ? ago(Date.parse(a.created_at)) : undefined;
  return (
    <Row first={first}>
      <Text style={{ color: c.muted, fontSize: 13 }}>{[ALERT_KIND[a.kind] ?? "Alert", since].filter(Boolean).join(" · ")}</Text>
      <Text style={{ color: c.text, fontSize: 16, marginTop: 3 }}>{a.title}</Text>
      {!!a.body && (
        <Text onPress={() => setMore(!more)} numberOfLines={more ? undefined : 3} style={{ color: c.muted, fontSize: 14, lineHeight: 20, marginTop: 3 }}>
          {a.body}
        </Text>
      )}
      <View style={{ flexDirection: "row", gap: 20, marginTop: 10, alignItems: "center" }}>
        <TextLink title={a.kind === "brief" ? "Got it" : "Done"} onPress={() => void answer("done")} />
        <TextLink title="Snooze 1 h" color={c.muted} onPress={() => void answer("snooze")} />
        <TextLink title="Not important" color={c.muted} onPress={() => void answer("dismiss")} />
        {a.kind !== "brief" && <TextLink title="Call me" color={c.muted} onPress={() => router.push(`/call/${a.id}?talk=1` as never)} />}
        {busy && <ActivityIndicator color={c.accent} />}
      </View>
      <ErrorText text={err} />
    </Row>
  );
}

function DecisionRow({ d, first, onDone }: { d: Decision; first: boolean; onDone: () => void }) {
  const c = useColors();
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const answer = () => reply.trim() && d.stepId && void act(() => Api.answer(d.runId, d.stepId!, reply.trim()));
  const kind = { question: "Question", checkpoint: "Checkpoint", design: "Design review" }[d.kind];
  return (
    <Row first={first}>
      <Text style={{ color: c.muted, fontSize: 13 }}>{[kind, d.kind === "design" ? undefined : d.from, ago(d.since)].filter(Boolean).join(" · ")}</Text>
      <Text style={{ color: c.text, fontSize: 16, marginTop: 3 }}>{d.text}</Text>
      {d.kind === "question" ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12, marginTop: 8 }}>
          <TextInput
            value={reply}
            onChangeText={setReply}
            placeholder="Your answer"
            placeholderTextColor={c.muted}
            returnKeyType="send"
            onSubmitEditing={answer}
            style={{ flex: 1, color: c.text, fontSize: 15, borderBottomWidth: 1, borderBottomColor: c.border, paddingVertical: 6 }}
          />
          {busy ? <ActivityIndicator color={c.accent} /> : <TextLink title="Send" onPress={answer} />}
        </View>
      ) : (
        <View style={{ flexDirection: "row", gap: 20, marginTop: 10, alignItems: "center" }}>
          {d.kind === "checkpoint" && d.stepId && <TextLink title="Continue" onPress={() => void act(() => Api.review(d.runId, d.stepId!, { action: "continue" }))} />}
          {d.threadId && <TextLink title={d.kind === "design" ? "Read and approve" : "Open"} color={d.kind === "design" ? c.accent : c.muted} onPress={() => open(d.threadId)} />}
          {busy && <ActivityIndicator color={c.accent} />}
        </View>
      )}
      <ErrorText text={err} />
    </Row>
  );
}

/**
 * A reply drafted in your style. Nothing is sent from here: "Send in WhatsApp" opens WhatsApp
 * with the text ready (straight to the chat when the number is known, else via the share sheet).
 */
function ReplyRow({ r, first, onDone }: { r: ReplyDraft; first: boolean; onDone: () => void }) {
  const c = useColors();
  // An older hub sends no options: its one draft is the only choice.
  const options = r.options?.length ? r.options : [{ label: "Reply", text: r.text }];
  const [picked, setPicked] = useState(0);
  const [text, setText] = useState(options[0].text);
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const send = () =>
    act(async () => {
      await openWhatsApp(text, r.phone);
      await Api.closeDraft(r.id, "sent");
    });
  return (
    <Row first={first}>
      <Text style={{ color: c.muted, fontSize: 13 }}>{[r.name, ago(r.createdAt)].join(" · ")}</Text>
      <Text style={{ color: c.muted, fontSize: 14, marginTop: 3, fontStyle: "italic" }} numberOfLines={3}>
        {r.incoming}
      </Text>
      {options.length > 1 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
          {options.map((o, i) => (
            <Pressable
              key={i}
              accessibilityRole="radio"
              accessibilityState={{ selected: i === picked }}
              onPress={() => {
                setPicked(i);
                setText(o.text);
              }}
              style={{ paddingHorizontal: 12, paddingVertical: 5, borderRadius: 14, borderWidth: 1, borderColor: i === picked ? c.accent : c.border, backgroundColor: i === picked ? c.accent : "transparent" }}
            >
              <Text style={{ color: i === picked ? c.bg : c.text, fontSize: 14 }}>{o.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <TextInput
        value={text}
        onChangeText={setText}
        multiline
        accessibilityLabel={`Reply to ${r.name}`}
        style={{ color: c.text, fontSize: 16, marginTop: 6, borderLeftWidth: 2, borderLeftColor: c.accent, paddingLeft: 10, paddingVertical: 2 }}
      />
      <TextInput
        value={ask}
        onChangeText={setAsk}
        placeholder="Or say what you want to reply…"
        placeholderTextColor={c.muted}
        returnKeyType="send"
        onSubmitEditing={() => ask.trim() && void act(() => Api.redraft(r.chatId, ask.trim()))}
        style={{ color: c.text, fontSize: 14, marginTop: 8, borderBottomWidth: 1, borderBottomColor: c.border, paddingVertical: 4 }}
      />
      <View style={{ flexDirection: "row", gap: 20, marginTop: 10, alignItems: "center" }}>
        <TextLink title="Send in WhatsApp" onPress={() => void send()} />
        <TextLink title="Redo" color={c.muted} onPress={() => void act(() => Api.redraft(r.chatId, ask.trim() || undefined))} />
        <TextLink title="Dismiss" color={c.muted} onPress={() => void act(() => Api.closeDraft(r.id, "dismissed"))} />
        {busy && <ActivityIndicator color={c.accent} />}
      </View>
      <ErrorText text={err} />
    </Row>
  );
}

/** A chat that went quiet after your message: nudge it (a draft in your style) or let it go. */
function QuietRow({ q, first, onDone }: { q: QuietChat; first: boolean; onDone: () => void }) {
  const c = useColors();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr("");
    try {
      await fn();
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row first={first}>
      <Text style={{ color: c.muted, fontSize: 13 }}>{[q.name, `quiet since ${ago(q.since)}`].join(" · ")}</Text>
      <Text style={{ color: c.text, fontSize: 15, marginTop: 3 }} numberOfLines={2}>
        You: {q.last}
      </Text>
      <View style={{ flexDirection: "row", gap: 20, marginTop: 8, alignItems: "center" }}>
        <TextLink title="Follow up" onPress={() => void act(() => Api.redraft(q.chatId))} />
        <TextLink title="Let it go" color={c.muted} onPress={() => void act(() => Api.letGo(q.chatId))} />
        {busy && <ActivityIndicator color={c.accent} />}
      </View>
      <ErrorText text={err} />
    </Row>
  );
}

function RunningRow({ r, first }: { r: Running; first: boolean }) {
  const c = useColors();
  const share = r.stepsTotal ? r.stepsDone / r.stepsTotal : 0;
  return (
    <Row first={first} onPress={r.threadId ? () => open(r.threadId) : undefined}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
        <Text style={{ color: c.text, fontSize: 16, flex: 1 }} numberOfLines={1}>
          {r.task}
        </Text>
        {r.stepsTotal > 0 && <Text style={{ color: c.muted, fontSize: 13 }}>{`${Math.min(r.stepsDone + 1, r.stepsTotal)} of ${r.stepsTotal}`}</Text>}
      </View>
      {!!r.now && (
        <Text style={{ color: c.muted, fontSize: 13, marginTop: 2 }} numberOfLines={1}>
          {r.now}
        </Text>
      )}
      <View style={{ height: 2, backgroundColor: c.border, marginTop: 10 }}>
        <View style={{ height: 2, width: `${Math.max(4, share * 100)}%`, backgroundColor: c.text }} />
      </View>
    </Row>
  );
}

function AttentionRow({ a, first, onRetried }: { a: Attention; first: boolean; onRetried: () => void }) {
  const c = useColors();
  const retry = async () => {
    await Api.send(a.threadId!, a.task!, {}).catch(() => {});
    onRetried();
  };
  return (
    <Row first={first} onPress={a.threadId ? () => open(a.threadId) : undefined}>
      <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, marginTop: 7, backgroundColor: a.level === "error" ? c.err : c.warn }} />
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.text, fontSize: 16 }}>{a.title}</Text>
          <Text style={{ color: c.muted, fontSize: 13, marginTop: 2 }}>{a.detail}</Text>
        </View>
        {a.threadId && a.task && <TextLink title="Retry" onPress={() => void retry()} />}
      </View>
    </Row>
  );
}

/** The message box at the bottom: starts a new conversation with the brain. */
function Ask() {
  const c = useColors();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const thread = await Api.newThread();
      await Api.send(thread.id, t, {});
      setText("");
      router.push(`/t/${thread.id}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.bg }}>
      <View style={{ flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: c.border, borderRadius: 999, paddingLeft: 18, paddingRight: 6, minHeight: 48 }}>
        <TextInput value={text} onChangeText={setText} placeholder="Message the brain" placeholderTextColor={c.muted} onSubmitEditing={send} returnKeyType="send" style={{ flex: 1, color: c.text, fontSize: 16, paddingVertical: 8 }} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          onPress={send}
          disabled={!text.trim() || busy}
          style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: text.trim() ? c.text : c.border, alignItems: "center", justifyContent: "center" }}
        >
          {busy ? <ActivityIndicator size="small" color={c.bg} /> : <Text style={{ color: c.bg, fontSize: 18, fontWeight: "700", lineHeight: 20 }}>↑</Text>}
        </Pressable>
      </View>
    </View>
  );
}

/** Today at a glance: your tasks, what the brain is waiting on you for, what is running, and anything wrong. */
export default function Home() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [home, setHome] = useState<HomeData>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      setHome(await Api.home());
      setError("");
    } catch (e) {
      if (e instanceof Unauthorized) router.replace("/connect");
      setError((e as Error).message);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
      const t = setInterval(load, 8000);
      return () => clearInterval(t);
    }, [load]),
  );

  const refresh = async () => {
    setLoading(true);
    await load();
    setLoading(false);
  };

  const toggle = (t: DayTask) => {
    setHome((h) => h && { ...h, tasks: h.tasks.map((x) => (x.id === t.id ? { ...x, done: !t.done } : x)) });
    Api.taskDone(t.id, !t.done).catch(() => void load());
  };

  const date = new Date().toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  const sources = home ? [home.sources.gmail && "Gmail", home.sources.whatsapp && "WhatsApp"].filter(Boolean).join(" and ") : "";

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: c.bg }}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 20, paddingHorizontal: 22, paddingBottom: 28 }}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} colors={[c.accent]} />}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ color: c.muted, fontSize: 13, flex: 1 }} numberOfLines={1}>
            {home ? `${date} · hub on ${home.node}${home.devices > 1 ? ` · ${home.devices} devices` : ""}` : date}
          </Text>
          <View style={{ flexDirection: "row", gap: 18 }}>
            <TextLink title="Insights" color={c.muted} onPress={() => router.push("/insights" as never)} />
            <TextLink title="Settings" color={c.muted} onPress={() => router.push("/settings")} />
          </View>
        </View>
        <ErrorText text={error} />
        {!home ? (
          !error && <ActivityIndicator style={{ marginTop: 40 }} color={c.accent} />
        ) : (
          <>
            <Text style={{ color: c.text, fontFamily: "serif", fontSize: 30, lineHeight: 38, marginTop: 10 }}>{headline(home)}</Text>
            <View style={{ marginTop: 12, flexDirection: "row" }}>
              <TextLink title="● Record a conversation" onPress={() => router.push("/record?start=1" as never)} />
            </View>

            {(home.approvals?.length ?? 0) > 0 && (
              <Section label="Approve?" right={home.approvals!.length}>
                {home.approvals!.map((a, i) => (
                  <ApprovalRow key={a.id} a={a} first={i === 0} onDone={() => void load()} />
                ))}
              </Section>
            )}

            {(home.builds?.length ?? 0) > 0 && (
              <Section label="Builds" right={<TextLink title="All builds →" color={c.muted} onPress={() => router.push("/builds" as never)} />}>
                {home.builds!.map((b, i) => (
                  <BuildRow key={b.id} b={b} first={i === 0} />
                ))}
              </Section>
            )}

            {(home.alerts?.length ?? 0) > 0 && (
              <Section label="Needs you" right={home.alerts.length}>
                {home.alerts.map((a, i) => (
                  <AlertRow key={a.id} a={a} first={i === 0} onDone={() => void load()} />
                ))}
              </Section>
            )}

            <Section label="Today" right={<TextLink title={sources ? `from ${sources} · All tasks →` : "All tasks →"} color={c.muted} onPress={() => router.push("/tasks")} />}>
              {home.tasks.map((t, i) => (
                <TaskRow key={t.id} t={t} first={i === 0} onToggle={() => toggle(t)} />
              ))}
              {!home.tasks.length && (
                <Text style={{ color: c.muted, fontSize: 15, paddingVertical: 8, lineHeight: 21 }}>
                  {sources ? "Nothing scheduled for today." : "Gmail and WhatsApp aren't connected yet. Tasks from your mail and messages will show up here."}
                </Text>
              )}
            </Section>

            {(home.replies?.length ?? 0) > 0 && (
              <Section label="Replies" right={home.replies.length}>
                {home.replies.map((r, i) => (
                  <ReplyRow key={r.id} r={r} first={i === 0} onDone={() => void load()} />
                ))}
              </Section>
            )}

            {(home.quiet?.length ?? 0) > 0 && (
              <Section label="Went quiet" right={home.quiet!.length}>
                {home.quiet!.map((q, i) => (
                  <QuietRow key={q.chatId} q={q} first={i === 0} onDone={() => void load()} />
                ))}
              </Section>
            )}

            {home.decisions.length > 0 && (
              <Section label="Decisions" right={home.decisions.length}>
                {home.decisions.map((d, i) => (
                  <DecisionRow key={`${d.runId}${d.stepId ?? ""}`} d={d} first={i === 0} onDone={() => void load()} />
                ))}
              </Section>
            )}

            {home.running.length > 0 && (
              <Section label="Running" right={home.running.length}>
                {home.running.map((r, i) => (
                  <RunningRow key={r.runId} r={r} first={i === 0} />
                ))}
              </Section>
            )}

            {home.attention.length > 0 && (
              <Section label="Needs a look" right={home.attention.length}>
                {home.attention.map((a, i) => (
                  <AttentionRow key={`${a.title}${a.runId ?? ""}`} a={a} first={i === 0} onRetried={() => void load()} />
                ))}
              </Section>
            )}

            {home.recent.length > 0 && (
              <Section label="Recent" right={<TextLink title="All chats →" onPress={() => router.push("/chats")} />}>
                {home.recent.map((r, i) => (
                  <Row key={r.runId} first={i === 0} onPress={r.threadId ? () => open(r.threadId) : undefined}>
                    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
                      <Text style={{ color: c.text, fontSize: 16, flex: 1 }} numberOfLines={1}>
                        {r.task}
                      </Text>
                      <Text style={{ color: r.status === "failed" ? c.err : c.muted, fontSize: 13 }}>{`${r.status} · ${ago(r.at)}`}</Text>
                    </View>
                  </Row>
                ))}
              </Section>
            )}
          </>
        )}
      </ScrollView>
      <Ask />
    </KeyboardAvoidingView>
  );
}
