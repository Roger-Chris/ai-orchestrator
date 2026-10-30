import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Button, Card, Chip, Dot, ErrorText, Field, Muted, Row } from "../../components/ui";
import { Api, connection, hubList, type NodeInfo } from "../../lib/api";
import { type Colors, LABEL, useColors } from "../../lib/theme";

const OS: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };
type FileNode = Awaited<ReturnType<typeof Api.fileNodes>>[number];
type Hit = Awaited<ReturnType<typeof Api.findFiles>>[number];
type Tool = NodeInfo["providers"][number];

const clean = (u?: string) => u?.replace(/\/+$/, "");
const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 60 ? `${Math.max(m, 1)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/** A tool's state in a word, and its colour: grey for "not set up" (nothing wrong), amber for a limit. */
function toolState(c: Colors, p: Tool): { word: string; color: string } {
  if (p.coolingDownUntil) return { word: `limit, back ${new Date(p.coolingDownUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`, color: c.warn };
  if (!p.ready) return { word: /not set up|optional|set .*_KEY|install/i.test(p.detail ?? "") ? "not set up" : (p.detail ?? "not ready"), color: c.muted };
  if (p.load > 0) return { word: `${Math.round(p.load * 100)}% busy`, color: c.accent };
  return { word: "ready", color: c.ok };
}

/**
 * Your devices on the tailnet that run the orchestrator: which one is the hub and which are its
 * backups, what each can do (AI tools, files) and a few actions. A screenshot asks first: approve it on Home.
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
  const [open, setOpen] = useState<string>();

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
  useFocusEffect(useCallback(() => void load(), [load]));

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

  const inUse = clean(connection()?.url);
  const backups = hubList().slice(1).map(clean);
  const all = nodes ? [nodes.self, ...nodes.peers] : [];
  const online = all.filter((n) => n.online !== false).length;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(true)} colors={[c.accent]} />}>
      <ErrorText text={error} />
      {!!note && (
        <Card>
          <Text style={{ color: c.text, fontSize: 14 }}>{note}</Text>
        </Card>
      )}

      <View style={{ gap: 8 }}>
        <Field placeholder="Find a file on any device" value={query} onChangeText={setQuery} onSubmitEditing={() => void search()} returnKeyType="search" />
        {hits?.map((h) => (
          <View key={`${h.node}:${h.path}`} style={{ paddingVertical: 8, borderTopWidth: 1, borderTopColor: c.border, gap: 2 }}>
            <Row>
              <Text style={{ color: c.text, fontSize: 15, flex: 1 }} numberOfLines={1}>{h.name}</Text>
              <Chip text={h.node} />
            </Row>
            <Muted small>{`${h.path} · ${Math.max(1, Math.round(h.size / 1024))} KB · ${new Date(h.mtime).toLocaleDateString()}`}</Muted>
          </View>
        ))}
        {hits && !hits.length && <Muted small>Nothing in the file index matches.</Muted>}
      </View>

      {nodes && <Muted small>{`${online} of ${all.length} device${all.length === 1 ? "" : "s"} online`}</Muted>}

      {all.map((n, i) => {
        const f = fileNodes.find((x) => x.node === n.name);
        const up = n.online !== false;
        const isHub = i === 0;
        const url = clean(n.url);
        const ready = n.providers.filter((p) => p.ready).length;
        const badge = isHub ? "Hub" : url && backups.includes(url) ? "Backup hub" : undefined;
        const using = isHub ? !!inUse && !backups.includes(inUse) : !!url && url === inUse;
        return (
          <Card key={n.name} attention={!up}>
            <Row>
              <Dot size={10} color={up ? c.ok : c.warn} />
              <Text style={{ color: c.text, fontSize: 18, fontWeight: "700", flex: 1 }} numberOfLines={1}>{n.name}</Text>
              {badge && <Chip text={badge} color={c.accent} />}
              {using && <Chip text="In use" color={c.ok} />}
            </Row>
            <Muted small>
              {[up ? (isHub ? "online" : `online via ${n.via}`) : "offline", n.platform ? (OS[n.platform] ?? n.platform) : "", n.branchWork ? "takes coding work" : ""].filter(Boolean).join(" · ")}
            </Muted>
            <Text style={{ color: c.text, fontSize: 14 }}>
              {`${ready} of ${n.providers.length} AI tools ready · `}
              {f ? `${f.files.toLocaleString()} files indexed ${ago(f.indexedAt)}${f.truncated ? " (stopped at the limit)" : ""}` : "files not indexed yet"}
            </Text>

            <Row>
              {n.providers.map((p) => {
                const s = toolState(c, p);
                const key = `${n.name}:${p.id}`;
                return (
                  <Pressable key={p.id} onPress={() => setOpen(open === key ? undefined : key)} hitSlop={4}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderColor: open === key ? s.color : c.border, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 }}>
                      <Dot size={7} color={s.color} />
                      <Text style={{ color: p.ready ? c.text : c.muted, fontSize: 13 }}>{LABEL[p.id] ?? p.id}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </Row>
            {n.providers
              .filter((p) => open === `${n.name}:${p.id}`)
              .map((p) => (
                <Muted key={p.id} small>{`${LABEL[p.id] ?? p.id}: ${toolState(c, p).word}${!p.ready && p.detail && toolState(c, p).word !== p.detail ? `. ${p.detail}` : ""}`}</Muted>
              ))}

            {up && n.actions !== false && (
              <Row>
                <Button small title="Screenshot" busy={busy === `${n.name}:screen.shot`} onPress={() => void act(n.name, "screen.shot", "Screenshot")} />
                <Button small title="Re-index files" busy={busy === `${n.name}:files.index`} onPress={() => void act(n.name, "files.index", "Re-index")} />
              </Row>
            )}
          </Card>
        );
      })}
      {nodes && !nodes.peers.length && (
        <Muted>No other devices yet. Run the orchestrator on the laptop (deploy\windows\install.ps1) or the Mac mini (deploy/mac/install.sh): it shows up here and becomes the backup hub.</Muted>
      )}
    </ScrollView>
  );
}
