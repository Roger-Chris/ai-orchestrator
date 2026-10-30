import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, Text, View } from "react-native";
import { Card, Chip, Dot, ErrorText, Muted, Row } from "../components/ui";
import { type AiHub, Api, type JobKind, type ProviderId, type ToolInfo, type ToolState } from "../lib/api";
import { type Colors, LABEL, useColors } from "../lib/theme";

/**
 * The AI hub (Jarvis R4): every AI the hub can use, whether it can work right now, what it cost
 * today, which one each job would use, and your pick for a job. Caps are set in the hub's config
 * (tools.overrides perDay / spendPerDay); here you see how close they are.
 */

const STATE: Record<ToolState, string> = { ready: "ready", busy: "busy", cooling: "resting", limit: "at its cap", off: "off", not_set_up: "not set up" };
const stateColor = (c: Colors, s: ToolState) => ({ ready: c.ok, busy: c.accent, cooling: c.warn, limit: c.warn, off: c.border, not_set_up: c.border })[s];
const COST: Record<ToolInfo["cost"], string> = { local: "on this machine", free: "free tier", subscription: "your plan", paid: "pay per use" };
const money = (n: number) => (n ? `$${n.toFixed(2)}` : "$0");
const until = (t?: number) => (t ? new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

export default function AiHubScreen() {
  const c = useColors();
  const [hub, setHub] = useState<AiHub>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<JobKind>();

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    try {
      setHub(await Api.aiHub(fresh));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));

  const prefer = async (job: JobKind, provider: ProviderId | "auto") => {
    setSaving(job);
    try {
      await Api.preferAi(job, provider);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(undefined);
    }
  };

  const chat = hub?.tools.filter((t) => t.kind === "agent" || t.kind === "chat") ?? [];
  const usable = chat.filter((t) => t.state !== "off" && t.state !== "not_set_up" && t.id !== "perplexity").map((t) => t.id as ProviderId);
  const h2 = { color: c.text, fontSize: 17, fontWeight: "700" as const };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(true)} colors={[c.accent]} />}>
      <ErrorText text={error} />
      {hub && (
        <Card>
          <Text style={h2}>Today</Text>
          <Muted>{`${hub.today.calls} calls${hub.today.failed ? `, ${hub.today.failed} failed` : ""} · ${money(hub.today.spentUsd)} spent`}</Muted>
          {hub.week.length > 1 && <Week week={hub.week} c={c} />}
        </Card>
      )}

      {hub && (
        <Card>
          <Text style={h2}>Who does what</Text>
          <Muted small>The first ready one answers; when it fails or is resting, the next takes over. Tap a name to try it first for that job.</Muted>
          {hub.jobs.map((j) => (
            <View key={j.kind} style={{ gap: 6, paddingTop: 8, borderTopWidth: 1, borderTopColor: c.border }}>
              <Text style={{ color: c.text, fontSize: 15, fontWeight: "600" }}>{j.label}</Text>
              <Text style={{ color: j.route.chain.length ? c.muted : c.err, fontSize: 13 }}>
                {j.route.chain.length ? j.route.chain.map((p) => LABEL[p] ?? p).join(" → ") : "Nothing can take this right now"}
              </Text>
              <Row>
                <Pick label="Auto" on={!j.preferred} busy={saving === j.kind} onPress={() => void prefer(j.kind, "auto")} c={c} />
                {usable.map((p) => (
                  <Pick key={p} label={LABEL[p] ?? p} on={j.preferred === p} busy={saving === j.kind} onPress={() => void prefer(j.kind, p)} c={c} />
                ))}
              </Row>
            </View>
          ))}
        </Card>
      )}

      {hub && hub.caps.length > 0 && (
        <Card>
          <Text style={h2}>Caps</Text>
          {hub.caps.map((x) => (
            <View key={x.id} style={{ gap: 2 }}>
              <Text style={{ color: x.reached ? c.warn : c.text, fontSize: 15 }}>{x.name}</Text>
              <Muted small>
                {[x.perDay ? `${x.calls} of ${x.perDay} calls` : "", x.spendPerDay ? `${money(x.spentUsd)} of ${money(x.spendPerDay)}` : "", x.reached ? "stopped until tomorrow" : ""].filter(Boolean).join(" · ")}
              </Muted>
            </View>
          ))}
        </Card>
      )}

      {hub && (
        <Card>
          <Text style={h2}>Tools</Text>
          {hub.tools.map((t) => (
            <View key={t.id} style={{ gap: 4, paddingTop: 8, borderTopWidth: 1, borderTopColor: c.border }}>
              <Row>
                <Dot color={stateColor(c, t.state)} />
                <Text style={{ color: c.text, fontSize: 15, flex: 1 }} numberOfLines={1}>{t.name}</Text>
                <Chip text={COST[t.cost]} />
              </Row>
              <Muted small>
                {[
                  `${STATE[t.state]}${(t.state === "cooling" || t.state === "limit") && t.until ? ` until ${until(t.until)}` : ""}`,
                  t.usageToday.calls ? `${t.usageToday.calls} today${t.usageToday.failed ? ` (${t.usageToday.failed} failed)` : ""}` : "",
                  t.usageToday.spentUsd ? money(t.usageToday.spentUsd) : "",
                  t.strengths.length ? `good at ${t.strengths.slice(0, 3).join(", ").replace(/_/g, " ")}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Muted>
              {!!t.detail && <Muted small>{t.detail}</Muted>}
            </View>
          ))}
        </Card>
      )}
    </ScrollView>
  );
}

function Pick({ label, on, busy, onPress, c }: { label: string; on: boolean; busy: boolean; onPress: () => void; c: Colors }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on, disabled: busy }}
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => ({ borderRadius: 999, borderWidth: 1, borderColor: on ? c.accent : c.border, backgroundColor: on ? c.accentSoft : "transparent", paddingHorizontal: 12, paddingVertical: 6, opacity: pressed || busy ? 0.6 : 1 })}
    >
      <Text style={{ color: on ? c.accent : c.text, fontSize: 13, fontWeight: on ? "700" : "400" }}>{label}</Text>
    </Pressable>
  );
}

/** Calls per day as small bars, newest on the right. */
function Week({ week, c }: { week: AiHub["week"]; c: Colors }) {
  const max = Math.max(1, ...week.map((d) => d.calls));
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6, height: 56 }}>
      {week.map((d) => (
        <View key={d.day} style={{ flex: 1, alignItems: "center", gap: 2 }}>
          <View style={{ width: "100%", height: Math.max(2, (d.calls / max) * 40), backgroundColor: d.failed > d.calls / 2 ? c.warn : c.accent, borderRadius: 3 }} />
          <Text style={{ color: c.muted, fontSize: 10 }}>{d.day.slice(8)}</Text>
        </View>
      ))}
    </View>
  );
}
