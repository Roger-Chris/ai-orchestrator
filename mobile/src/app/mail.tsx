import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, RefreshControl, ScrollView, Text, View } from "react-native";
import { Button, Card, Chip, ErrorText, Field, Muted, Row } from "../components/ui";
import { Api, type MailDraft } from "../lib/api";
import { useColors } from "../lib/theme";

/** One draft to check and edit. Send sends exactly what is in these boxes, after asking once more. */
function Draft({ mail, reload }: { mail: MailDraft; reload: () => Promise<void> }) {
  const c = useColors();
  const [to, setTo] = useState(mail.to);
  const [subject, setSubject] = useState(mail.subject);
  const [body, setBody] = useState(mail.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(mail.error ?? "");

  const run = async (f: () => Promise<MailDraft>) => {
    setBusy(true);
    try {
      const m = await f();
      setError(m.error ?? "");
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const send = () =>
    Alert.alert("Send this mail?", `To ${to.trim()}\n${subject}`, [
      { text: "Not yet", style: "cancel" },
      { text: "Send", onPress: () => void run(() => Api.mailSend(mail.id, { to, subject, body })) },
    ]);

  return (
    <Card attention>
      {!!mail.toName && <Text style={{ color: c.text, fontSize: 16 }}>For {mail.toName}</Text>}
      <Muted small>You asked: {mail.about}</Muted>
      <Field label="To" value={to} onChangeText={setTo} autoCapitalize="none" keyboardType="email-address" placeholder="name@example.com" />
      <Field label="Subject" value={subject} onChangeText={setSubject} />
      <Field label="Mail" value={body} onChangeText={setBody} multiline style={{ minHeight: 160, textAlignVertical: "top" }} />
      <ErrorText text={error} />
      <Row>
        <Button kind="primary" small title="Send" busy={busy} disabled={!to.trim() || !subject.trim() || !body.trim()} onPress={send} />
        <Button small title="Discard" disabled={busy} onPress={() => void run(() => Api.mailDiscard(mail.id))} />
      </Row>
    </Card>
  );
}

/** Mail: what Jarvis wrote for you. Nothing leaves until you tap Send here. */
export default function Mail() {
  const c = useColors();
  const [items, setItems] = useState<MailDraft[]>();
  const [sender, setSender] = useState<{ connected: boolean; email?: string }>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [mails, from] = await Promise.all([Api.mails(), Api.mailSender()]);
      setItems(mails);
      setSender(from);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));

  const waiting = items?.filter((m) => m.status === "draft" || m.status === "failed") ?? [];
  const past = items?.filter((m) => m.status === "sent" || m.status === "discarded").slice(0, 15) ?? [];
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={loading} onRefresh={load} colors={[c.accent]} />}>
      <ErrorText text={error} />
      {sender && !sender.connected && <Muted>Sending is not set up yet: run "orc gmail connect-send" on the hub and sign in with Google once.</Muted>}
      {sender?.email && <Muted small>Sends as {sender.email}</Muted>}
      {waiting.map((m) => (
        <Draft key={m.id} mail={m} reload={load} />
      ))}
      {items && !waiting.length && <Muted>Nothing waiting. Ask Jarvis to write a mail.</Muted>}
      {past.length > 0 && (
        <View style={{ gap: 6, marginTop: 8 }}>
          <Muted small>Earlier</Muted>
          {past.map((m) => (
            <Row key={m.id}>
              <Text style={{ color: c.muted, flex: 1 }} numberOfLines={1}>{m.subject} · {m.to || m.toName}</Text>
              <Chip text={m.status} />
            </Row>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
