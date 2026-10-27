import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Button, Card, Chip, Dot, Muted, Row } from "../components/ui";
import { Api, connection, type NodeInfo } from "../lib/api";
import { enablePush, pushBuiltIn } from "../lib/push";
import { LABEL, useColors } from "../lib/theme";

export default function Settings() {
  const c = useColors();
  const conn = connection();
  const [nodes, setNodes] = useState<{ self: NodeInfo; peers: NodeInfo[] }>();
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof Api.usage>>>([]);
  const [pushMsg, setPushMsg] = useState("");
  const [busy, setBusy] = useState("");

  const loadNodes = useCallback((refresh = false) => Api.nodes(refresh).then(setNodes).catch(() => {}), []);
  useEffect(() => {
    void loadNodes();
    Api.usage().then(setUsage).catch(() => {});
  }, [loadNodes]);

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    try {
      setPushMsg(await fn());
    } catch (e) {
      setPushMsg((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const h2 = { color: c.text, fontSize: 17, fontWeight: "700" as const };
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <Card>
        <Text style={h2}>Hub</Text>
        <Muted>{conn?.url ?? "not connected"}</Muted>
        <Row>
          <Button title="Change hub or token" onPress={() => router.push("/connect")} />
        </Row>
      </Card>

      <Card>
        <Text style={h2}>Notifications</Text>
        <Muted small>Get a notification when an agent asks you something, a step is paused for you, a design needs approval, or a run finishes.</Muted>
        {!pushBuiltIn && <Muted small>This build has no Firebase config, so it can't receive notifications yet. The README explains the 5-minute setup.</Muted>}
        <Row>
          <Button kind="primary" title="Turn on" busy={busy === "on"} disabled={!pushBuiltIn} onPress={() => run("on", enablePush)} />
          <Button title="Send a test" busy={busy === "test"} disabled={!pushBuiltIn} onPress={() => run("test", async () => `Sent to ${(await Api.pushTest()).sent} device(s).`)} />
        </Row>
        {!!pushMsg && <Text style={{ color: c.text }}>{pushMsg}</Text>}
      </Card>

      <Card>
        <Row style={{ justifyContent: "space-between" }}>
          <Text style={h2}>Devices & models</Text>
          <Button small title="Refresh" onPress={() => loadNodes(true)} />
        </Row>
        {nodes &&
          [nodes.self, ...nodes.peers].map((n, i) => (
            <View key={n.name} style={{ gap: 6, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 8 }}>
              <Row style={{ justifyContent: "space-between" }}>
                <Text style={{ color: c.text, fontWeight: "600" }}>{n.name}</Text>
                <Muted small>
                  {i === 0 ? "hub" : n.online === false ? "offline" : `via ${n.via}`}
                  {n.branchWork ? " · takes branch work" : ""}
                </Muted>
              </Row>
              <Row>
                {n.providers.map((p) => (
                  <View key={p.id} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                    <Dot size={8} color={p.ready ? c.ok : p.coolingDownUntil ? c.warn : c.err} />
                    <Chip text={`${LABEL[p.id] ?? p.id}${p.load > 0 ? ` ${Math.round(p.load * 100)}%` : ""}`} />
                  </View>
                ))}
              </Row>
            </View>
          ))}
        {nodes && !nodes.peers.length && <Muted small>No other devices yet.</Muted>}
      </Card>

      <Card>
        <Text style={h2}>Usage, last 7 days</Text>
        {usage.length ? (
          usage.map((r) => (
            <Row key={`${r.day}${r.provider}${r.node}`} style={{ justifyContent: "space-between" }}>
              <Muted small>{r.day}</Muted>
              <Text style={{ color: c.text }}>
                {LABEL[r.provider] ?? r.provider} @ {r.node}
              </Text>
              <Muted small>
                {r.calls} calls{r.failed ? `, ${r.failed} failed` : ""}
              </Muted>
            </Row>
          ))
        ) : (
          <Muted small>No calls yet.</Muted>
        )}
      </Card>
    </ScrollView>
  );
}
