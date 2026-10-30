import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { Button, Dot, ErrorText, Field, Muted, Row } from "../../components/ui";
import { Api, type NodeInfo } from "../../lib/api";
import { LABEL, useColors } from "../../lib/theme";

const OS: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };
type FileNode = Awaited<ReturnType<typeof Api.fileNodes>>[number];
type Hit = Awaited<ReturnType<typeof Api.findFiles>>[number];

/**
 * The devices on your tailnet that run the orchestrator (Jarvis D4): what each one is, its models,
 * its file index, and a few things to do on it. A screenshot asks first: approve it on Home.
 */
export default function Devices() {
  const c = useColors();
  const [nodes, setNodes] = useState<{ self: NodeInfo; peers: NodeInfo[] }>();
  const [fileNodes, setFileNodes] = useState<FileNode[]>([]);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>();

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const [n, f] = await Promise.all([Api.nodes(refresh), Api.fileNodes().catch(() => [])]);
      setNodes(n);
      setFileNodes(f);
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

  const act = async (node: string, action: string, label: string) => {
    setBusy(`${node}:${action}`);
    setNote("");
    try {
      const r = await Api.act(node, action, {}, "asked from the app's Devices screen");
      if (r.status === "pending") setNote(`${label} on ${node}: approve it on Home.`);
      else if (r.status === "done") setNote(`${node}: ${r.result?.output ?? "done"}`);
      else setNote(`${node}: ${r.error ?? "refused"}`);
      if (action === "files.index") await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const search = async () => {
    if (!query.trim()) return;
    setBusy("search");
    try {
      setHits(await Api.findFiles(query.trim()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 24 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(true)} colors={[c.accent]} />}>
      <ErrorText text={error} />
      {!!note && <Muted small>{note}</Muted>}

      <View style={{ gap: 8 }}>
        <Field placeholder="Find a file on any device" value={query} onChangeText={setQuery} onSubmitEditing={() => void search()} returnKeyType="search" />
        {hits?.map((h) => (
          <View key={`${h.node}:${h.path}`}>
            <Text style={{ color: c.text, fontSize: 15 }} numberOfLines={1}>{h.name}</Text>
            <Muted small>{`${h.node} · ${h.path} · ${Math.max(1, Math.round(h.size / 1024))} KB · ${new Date(h.mtime).toLocaleDateString()}`}</Muted>
          </View>
        ))}
        {hits && !hits.length && <Muted small>Nothing in the file index matches.</Muted>}
      </View>

      {nodes &&
        [nodes.self, ...nodes.peers].map((n, i) => {
          const f = fileNodes.find((x) => x.node === n.name);
          const online = n.online !== false;
          return (
            <View key={n.name} style={{ gap: 4 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
                <Text style={{ color: c.text, fontSize: 18, fontWeight: "600" }}>{n.name}</Text>
                <Text style={{ color: online ? c.muted : c.warn, fontSize: 13 }}>
                  {i === 0 ? "hub" : !online ? "offline" : `via ${n.via}`}
                  {n.platform ? ` · ${OS[n.platform] ?? n.platform}` : ""}
                  {n.branchWork ? " · takes branch work" : ""}
                </Text>
              </View>
              <Muted small>{f ? `${f.files.toLocaleString()} files indexed ${new Date(f.indexedAt).toLocaleString()}${f.truncated ? " (stopped at the limit)" : ""}` : "files not indexed yet"}</Muted>
              {online && n.actions !== false && (
                <Row style={{ marginTop: 4 }}>
                  <Button small title="Screenshot" busy={busy === `${n.name}:screen.shot`} onPress={() => void act(n.name, "screen.shot", "Screenshot")} />
                  <Button small title="Re-index files" busy={busy === `${n.name}:files.index`} onPress={() => void act(n.name, "files.index", "Re-index")} />
                </Row>
              )}
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
          );
        })}
      {nodes && !nodes.peers.length && <Text style={{ color: c.muted, fontSize: 15 }}>No other devices yet. Run the orchestrator on another machine on your tailnet (the Mac mini: deploy/mac/install.sh) and it shows up here.</Text>}
    </ScrollView>
  );
}
