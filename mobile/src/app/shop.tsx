import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, Linking, RefreshControl, ScrollView, Text, View } from "react-native";
import { Button, Card, Chip, ErrorText, Muted, Row } from "../components/ui";
import { Api, type ShopRun } from "../lib/api";
import { useColors } from "../lib/theme";

const OPEN: ShopRun["status"][] = ["working", "ready", "needs_you", "link", "checkout", "blocked", "not_found", "failed"];

/**
 * Shopping: what Jarvis put in a cart, and the total. Jarvis can't order. Go to checkout opens the
 * store, where you place the order and enter any payment details or sign-in yourself.
 */
export default function Shop() {
  const c = useColors();
  const [items, setItems] = useState<ShopRun[]>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await Api.shopRuns());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));

  const run = async (r: ShopRun, f: () => Promise<unknown>) => {
    setBusy(r.id);
    try {
      await f();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const checkout = (r: ShopRun) =>
    Alert.alert(`Go to checkout: ${r.total}?`, `${r.items.map((i) => `${i.qty} x ${i.name}`).join("\n")}\n\nThe store opens. You place the order and pay there yourself.`, [
      { text: "Not yet", style: "cancel" },
      { text: "Open the store", onPress: () => void run(r, async () => { await Api.shopCheckout(r.id, r.total ?? ""); await Linking.openURL(r.cartUrl); }) },
    ]);

  const open = items?.filter((r) => OPEN.includes(r.status)) ?? [];
  const past = items?.filter((r) => !OPEN.includes(r.status)).slice(0, 15) ?? [];
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} colors={[c.accent]} />}>
      <ErrorText text={error} />
      {open.map((r) => (
        <Card key={r.id} attention={r.status === "ready" || r.status === "needs_you"}>
          <Row>
            <Text style={{ color: c.text, fontSize: 16, flex: 1 }}>{r.storeName}</Text>
            <Chip text={r.status === "working" ? "finding it…" : r.status.replace("_", " ")} />
          </Row>
          <Muted small>You asked: {r.request}</Muted>
          {r.items.map((i, n) => (
            <Text key={n} style={{ color: c.text }}>{i.qty} x {i.name}{i.price ? `  ${i.price}` : ""}</Text>
          ))}
          {!!r.total && <Text style={{ color: c.text, fontSize: 18, fontWeight: "600" }}>Total {r.total}</Text>}
          {!!r.account && <Muted small>In the cart of {r.account}</Muted>}
          {!!r.note && <Muted small>{r.note}</Muted>}
          {r.checked?.map((k) => (
            <Muted key={k.store} small>{k.store}: {k.found ? `has it${k.price ? ` at ${k.price}` : ""}` : "not found"}{k.note ? ` (${k.note})` : ""}</Muted>
          ))}
          {r.alternatives?.map((a) => (
            <Text key={a.url} style={{ color: c.accent }} onPress={() => void Linking.openURL(a.url)}>Also at {a.name}{a.price ? `: ${a.price}` : ""} →</Text>
          ))}
          <Row>
            {(r.status === "ready" || r.status === "checkout") && <Button kind="primary" small title="Go to checkout" busy={busy === r.id} onPress={() => checkout(r)} />}
            {r.status === "checkout" && <Button small title="I ordered it" onPress={() => void run(r, () => Api.shopOrdered(r.id))} />}
            {r.status !== "ready" && r.status !== "checkout" && r.status !== "working" && <Button small kind={r.status === "link" ? "primary" : undefined} title="Search the store" onPress={() => void Linking.openURL(r.searchUrl)} />}
            {r.status !== "working" && <Button small title="Not now" onPress={() => void run(r, () => Api.shopDismiss(r.id))} />}
          </Row>
        </Card>
      ))}
      {items && !open.length && <Muted>Nothing here. Ask Jarvis to add something to a cart.</Muted>}
      {past.length > 0 && (
        <View style={{ gap: 6, marginTop: 8 }}>
          <Muted small>Earlier</Muted>
          {past.map((r) => (
            <Row key={r.id}>
              <Text style={{ color: c.muted, flex: 1 }} numberOfLines={1}>{r.storeName}: {r.request}</Text>
              <Chip text={r.status} />
            </Row>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
