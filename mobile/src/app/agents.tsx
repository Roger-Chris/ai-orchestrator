import * as Clipboard from "expo-clipboard";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Switch, Text, View } from "react-native";
import { Button, Card, Chip, ErrorText, Field, Muted, Row } from "../components/ui";
import { Api, connection, type OutsideAgent, type OutsideAuditEntry } from "../lib/api";
import { useColors } from "../lib/theme";

/**
 * Outside agents (Jarvis phase 4): paid or third-party agents you let in over MCP, each with its own
 * token and limits. Every call they make is in the log below and in the shared memory. The switch
 * at the top stops all of them at once; Revoke stops one for good.
 */

const OUTCOME_COLOR = { ok: "ok", pending: "warn", refused: "err", error: "err" } as const;

export default function Agents() {
  const c = useColors();
  const [agents, setAgents] = useState<OutsideAgent[]>();
  const [paused, setPaused] = useState(false);
  const [audit, setAudit] = useState<OutsideAuditEntry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [created, setCreated] = useState<{ name: string; token: string }>();
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState<{ name: string; devices: string; folders: string; risk: "safe" | "ask"; memoryWrite: boolean }>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [a, log] = await Promise.all([Api.outsideAgents(), Api.outsideAudit()]);
      setAgents(a.agents);
      setPaused(a.paused);
      setAudit(log);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));

  const run = async (key: string, f: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await f();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const add = () =>
    form &&
    run("add", async () => {
      const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
      const r = await Api.addOutsideAgent(form.name.trim(), { devices: list(form.devices), folders: list(form.folders), risk: form.risk, memoryWrite: form.memoryWrite });
      setCreated({ name: r.agent.name, token: r.token });
      setCopied(false);
      setForm(undefined);
    });

  const names = Object.fromEntries((agents ?? []).map((a) => [a.id, a.name]));
  const h2 = { color: c.text, fontSize: 17, fontWeight: "700" as const };
  const colorOf = (o: OutsideAuditEntry["outcome"]) => c[OUTCOME_COLOR[o]];

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} colors={[c.accent]} />}>
      <ErrorText text={error} />
      <Card attention={paused}>
        <Row>
          <Text style={{ color: c.text, fontSize: 16, flex: 1 }}>{paused ? "All outside agents are stopped" : "Outside agents may work"}</Text>
          <Switch value={!paused} disabled={busy === "pause"} onValueChange={(on) => void run("pause", () => Api.pauseOutsideAgents(!on))} trackColor={{ true: c.accent, false: c.err }} />
        </Row>
        <Muted small>{`They connect to ${connection()?.url ?? "the hub"}/mcp with their own token. Turning this off stops every one of them at once.`}</Muted>
      </Card>

      {created && (
        <Card attention>
          <Text style={h2}>{`Token for ${created.name}`}</Text>
          <Muted small>Copy it into the agent's MCP settings now. It is not shown again; if it is lost, revoke the agent and add a new one.</Muted>
          <Text selectable style={{ color: c.text, fontFamily: "monospace", fontSize: 13 }}>{created.token}</Text>
          <Row>
            <Button
              kind="primary"
              small
              title={copied ? "Copied" : "Copy token"}
              onPress={() => {
                void Clipboard.setStringAsync(created.token);
                setCopied(true);
              }}
            />
            <Button small title="Done" onPress={() => setCreated(undefined)} />
          </Row>
        </Card>
      )}

      {!form ? (
        <Button kind="primary" title="Add an agent" onPress={() => setForm({ name: "", devices: "", folders: "", risk: "safe", memoryWrite: false })} />
      ) : (
        <Card>
          <Text style={h2}>New outside agent</Text>
          <Field label="Name" value={form.name} onChangeText={(name) => setForm({ ...form, name })} placeholder="Codex cloud" />
          <Field label="Devices it may use (comma-separated; * for all; empty for memory only)" value={form.devices} onChangeText={(devices) => setForm({ ...form, devices })} autoCapitalize="none" placeholder="omen, mac-mini" />
          <Field label="Folders it must stay in (absolute, comma-separated; empty = the devices' assistant folders)" value={form.folders} onChangeText={(folders) => setForm({ ...form, folders })} autoCapitalize="none" placeholder="C:/development/drone" />
          <Row>
            <Muted small>Riskiest call:</Muted>
            {(["safe", "ask"] as const).map((r) => (
              <Pressable key={r} onPress={() => setForm({ ...form, risk: r })} style={{ borderWidth: 1, borderRadius: 999, borderColor: form.risk === r ? c.accent : c.border, paddingHorizontal: 12, paddingVertical: 6 }}>
                <Text style={{ color: form.risk === r ? c.accent : c.text }}>{r === "safe" ? "Safe only" : "Ask me"}</Text>
              </Pressable>
            ))}
          </Row>
          <Row>
            <Switch value={form.memoryWrite} onValueChange={(memoryWrite) => setForm({ ...form, memoryWrite })} trackColor={{ true: c.accent, false: c.border }} />
            <Text style={{ color: c.text }}>May add to the shared memory</Text>
          </Row>
          <Row>
            <Button kind="primary" title="Create" busy={busy === "add"} disabled={!form.name.trim()} onPress={() => void add()} />
            <Button title="Cancel" onPress={() => setForm(undefined)} />
          </Row>
        </Card>
      )}

      {agents?.map((a) => (
        <Card key={a.id}>
          <Row>
            <Text style={{ color: a.revokedAt ? c.muted : c.text, fontSize: 16, fontWeight: "600", flex: 1 }}>{a.name}</Text>
            <Chip text={a.revokedAt ? "revoked" : a.scopes.risk === "ask" ? "can ask" : "safe only"} />
          </Row>
          <Muted small>
            {[
              a.scopes.devices.length ? `devices: ${a.scopes.devices.join(", ")}` : "memory only",
              a.scopes.folders.length ? `folders: ${a.scopes.folders.join(", ")}` : "",
              a.scopes.memoryWrite ? "writes memory" : "reads memory",
              `${a.calls} calls${a.lastUsed ? `, last ${new Date(a.lastUsed).toLocaleString()}` : ""}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Muted>
          {!a.revokedAt && <Button kind="danger" small title="Revoke" busy={busy === a.id} onPress={() => void run(a.id, () => Api.revokeOutsideAgent(a.id))} />}
        </Card>
      ))}
      {agents && !agents.length && <Muted>No outside agents yet.</Muted>}

      {audit.length > 0 && (
        <View style={{ gap: 6 }}>
          <Text style={h2}>What they did</Text>
          {audit.map((e, i) => (
            <View key={i} style={{ borderTopWidth: 1, borderTopColor: c.border, paddingTop: 6 }}>
              <Row>
                <Text style={{ color: c.text, fontSize: 13, flex: 1 }} numberOfLines={2}>{`${names[e.agentId] ?? e.agentId}: ${e.summary}`}</Text>
                <Text style={{ color: colorOf(e.outcome), fontSize: 12 }}>{e.outcome}</Text>
              </Row>
              <Muted small>{`${new Date(e.at).toLocaleString()}${e.detail ? ` · ${e.detail.slice(0, 160)}` : ""}`}</Muted>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
