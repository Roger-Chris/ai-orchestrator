import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { Dot, ErrorText } from "../../components/ui";
import { Api, type NodeInfo } from "../../lib/api";
import { LABEL, useColors } from "../../lib/theme";

/** The devices on your tailnet that run the orchestrator, and which models each can use right now. */
export default function Devices() {
  const c = useColors();
  const [nodes, setNodes] = useState<{ self: NodeInfo; peers: NodeInfo[] }>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      setNodes(await Api.nodes(refresh));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 24 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(true)} colors={[c.accent]} />}>
      <ErrorText text={error} />
      {nodes &&
        [nodes.self, ...nodes.peers].map((n, i) => (
          <View key={n.name}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
              <Text style={{ color: c.text, fontSize: 18, fontWeight: "600" }}>{n.name}</Text>
              <Text style={{ color: n.online === false ? c.warn : c.muted, fontSize: 13 }}>
                {i === 0 ? "hub" : n.online === false ? "offline" : `via ${n.via}`}
                {n.branchWork ? " · takes branch work" : ""}
              </Text>
            </View>
            {n.providers.map((p) => (
              <View key={p.id} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border, marginTop: 6 }}>
                <Dot size={8} color={p.ready ? c.ok : p.coolingDownUntil ? c.warn : c.err} />
                <Text style={{ color: c.text, fontSize: 16, flex: 1 }}>{LABEL[p.id] ?? p.id}</Text>
                <Text style={{ color: c.muted, fontSize: 13, flexShrink: 1 }} numberOfLines={1}>
                  {p.coolingDownUntil
                    ? `limit, back ${new Date(p.coolingDownUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                    : !p.ready
                      ? (p.detail ?? "not ready")
                      : p.load > 0
                        ? `${Math.round(p.load * 100)}% busy`
                        : "ready"}
                </Text>
              </View>
            ))}
          </View>
        ))}
      {nodes && !nodes.peers.length && <Text style={{ color: c.muted, fontSize: 15 }}>No other devices yet. Run the orchestrator on another machine on your tailnet and it shows up here.</Text>}
    </ScrollView>
  );
}
