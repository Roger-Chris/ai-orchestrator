import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { Card, Dot, ErrorText, Muted, Row } from "../components/ui";
import { Api, type ModelLimit, type ModelLimits, type ToolState } from "../lib/api";
import { type Colors, useColors } from "../lib/theme";

/**
 * Tokens used, and what each model has left. Claude, ChatGPT and Groq report their own limits with
 * each answer, so those numbers are as of the model's last use; the others only show when they hit one.
 */

const STATE: Record<ToolState, string> = { ready: "available", busy: "busy", cooling: "at its limit", limit: "at your cap", off: "off", not_set_up: "not set up" };
const stateColor = (c: Colors, s: ToolState) => ({ ready: c.ok, busy: c.accent, cooling: c.err, limit: c.err, off: c.border, not_set_up: c.border })[s];
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const when = (t: number) => {
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${time}`;
};

export default function Limits() {
  const c = useColors();
  const [data, setData] = useState<ModelLimits>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    try {
      setData(await Api.modelLimits(fresh));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));

  const h2 = { color: c.text, fontSize: 17, fontWeight: "700" as const };
  const models = data?.models.filter((m) => m.state !== "off" && m.state !== "not_set_up") ?? [];
  const max = Math.max(1, ...(data?.days.map((d) => d.in + d.out) ?? []));

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(true)} colors={[c.accent]} />}>
      <ErrorText text={error} />
      {data && (
        <Card>
          <Text style={h2}>Limits left</Text>
          {models.map((m) => (
            <Model key={m.id} m={m} c={c} />
          ))}
          {!models.length && <Muted>No model is set up on this hub.</Muted>}
        </Card>
      )}
      {data && (
        <Card>
          <Text style={h2}>Token use</Text>
          <Muted>{`Today: ${tokens(data.today.in)} in, ${tokens(data.today.out)} out`}</Muted>
          <Muted>{`Last 7 days: ${tokens(data.week.in)} in, ${tokens(data.week.out)} out`}</Muted>
          {data.days.length > 1 && (
            <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 6, height: 56 }}>
              {data.days.map((d) => (
                <View key={d.day} style={{ flex: 1, alignItems: "center", gap: 2 }}>
                  <View style={{ width: "100%", height: Math.max(2, ((d.in + d.out) / max) * 40), backgroundColor: c.accent, borderRadius: 3 }} />
                  <Text style={{ color: c.muted, fontSize: 10 }}>{d.day.slice(8)}</Text>
                </View>
              ))}
            </View>
          )}
          {models.map((m) => (
            <Muted key={m.id} small>{`${m.name}: today ${tokens(m.today.in + m.today.out)} in ${m.today.calls} calls · 7 days ${tokens(m.week.in + m.week.out)} in ${m.week.calls} calls`}</Muted>
          ))}
          <Muted small>Only work done through this hub, counted from when this was added. Cached input is left out. Not every service reports tokens, so some can show calls with no tokens.</Muted>
        </Card>
      )}
    </ScrollView>
  );
}

function Model({ m, c }: { m: ModelLimit; c: Colors }) {
  return (
    <View style={{ gap: 6, paddingTop: 8, borderTopWidth: 1, borderTopColor: c.border }}>
      <Row>
        <Dot color={stateColor(c, m.state)} />
        <Text style={{ color: c.text, fontSize: 15, flex: 1 }} numberOfLines={1}>{m.name}</Text>
        <Muted small>{`${STATE[m.state]}${m.until ? ` until ${when(m.until)}` : ""}`}</Muted>
      </Row>
      {m.windows.map((w) => (
        <View key={w.label} style={{ gap: 3 }}>
          <Muted small>{`${w.label}: ${100 - w.usedPercent}% left${w.resetsAt ? `, resets ${when(w.resetsAt)}` : ""}`}</Muted>
          <View style={{ height: 6, borderRadius: 3, backgroundColor: c.border }}>
            <View style={{ height: 6, borderRadius: 3, width: `${Math.min(100, w.usedPercent)}%`, backgroundColor: w.usedPercent >= 90 ? c.err : w.usedPercent >= 70 ? c.warn : c.accent }} />
          </View>
        </View>
      ))}
      {m.windows.length > 0 && m.windowsAt ? <Muted small>{`As of its last use, ${when(m.windowsAt)}`}</Muted> : null}
      {!m.windows.length && <Muted small>It does not report what is left. It shows here as at its limit when it hits one.</Muted>}
      {!!m.perDay && <Muted small>{`Your cap: ${m.today.calls} of ${m.perDay} calls today`}</Muted>}
      {!!m.spendPerDay && <Muted small>{`Your cap: $${m.spentUsd.toFixed(2)} of $${m.spendPerDay.toFixed(2)} today`}</Muted>}
    </View>
  );
}
