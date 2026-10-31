import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { Button, Card, Chip, ErrorText, Muted, Row } from "../components/ui";
import { Api, type PhoneAction } from "../lib/api";
import { doPhoneAction, openFreshApps } from "../lib/phone";
import { useColors } from "../lib/theme";

/**
 * Phone (Jarvis D3): what the assistant wants done on this phone. Nothing happens until you tap
 * Do it: alarms go to the clock app, reminders are scheduled here, calls and texts open filled in
 * and wait for you to press call or send.
 */
export default function Phone() {
  const c = useColors();
  const [items, setItems] = useState<PhoneAction[]>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await Api.phoneActions());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  // Tapping the notice brings you here with the app on screen, so a fresh "open this app" just opens.
  useFocusEffect(useCallback(() => void openFreshApps().catch(() => undefined).finally(() => void load()), [load]));

  const run = async (p: PhoneAction, f: () => Promise<unknown>) => {
    setBusy(p.id);
    try {
      await f();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const pending = items?.filter((p) => p.status === "pending") ?? [];
  const past = items?.filter((p) => p.status !== "pending").slice(0, 15) ?? [];
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} colors={[c.accent]} />}>
      <ErrorText text={error} />
      {pending.map((p) => (
        <Card key={p.id} attention>
          <Text style={{ color: c.text, fontSize: 16 }}>{p.summary}</Text>
          {!!p.reason && <Muted small>{p.reason}</Muted>}
          <Row>
            <Button kind="primary" small title="Do it" busy={busy === p.id} onPress={() => void run(p, () => doPhoneAction(p))} />
            <Button small title="No" onPress={() => void run(p, () => Api.phoneDismiss(p.id))} />
          </Row>
        </Card>
      ))}
      {items && !pending.length && <Muted>Nothing waiting. Ask the assistant to set an alarm, remind you, open an app or send a file here.</Muted>}
      {past.length > 0 && (
        <View style={{ gap: 6, marginTop: 8 }}>
          <Muted small>Earlier</Muted>
          {past.map((p) => (
            <Row key={p.id}>
              <Text style={{ color: c.muted, flex: 1 }} numberOfLines={1}>{p.summary}</Text>
              <Chip text={p.status} />
            </Row>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
