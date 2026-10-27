import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { ErrorText } from "../../components/ui";
import { Api, type Insights as InsightsData } from "../../lib/api";
import { LABEL, useColors } from "../../lib/theme";

const duration = (ms?: number) => (ms === undefined ? "–" : ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 3_600_000).toFixed(1)}h`);

/** The last 7 days: how much the brain did, how often it finished, and which models did the work. */
export default function Insights() {
  const c = useColors();
  const [data, setData] = useState<InsightsData>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await Api.insights(7));
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

  const label = { color: c.muted, fontSize: 13 };
  const peak = Math.max(1, ...(data?.days.map((d) => d.runs) ?? [1]));
  const finished = data && data.done + data.failed ? Math.round((data.done / (data.done + data.failed)) * 100) : undefined;

  return (
    <ScrollView contentContainerStyle={{ padding: 22, gap: 28 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} colors={[c.accent]} />}>
      <ErrorText text={error} />
      {data && (
        <>
          <View>
            <Text style={label}>Last 7 days</Text>
            <View style={{ flexDirection: "row", marginTop: 10 }}>
              {[
                [String(data.runs), "runs"],
                [finished === undefined ? "–" : `${finished}%`, "finished"],
                [duration(data.medianMs), "typical run"],
              ].map(([n, l]) => (
                <View key={l} style={{ flex: 1 }}>
                  <Text style={{ color: c.text, fontSize: 26, fontWeight: "500", fontVariant: ["tabular-nums"] }}>{n}</Text>
                  <Text style={label}>{l}</Text>
                </View>
              ))}
            </View>
          </View>

          <View accessible accessibilityLabel={`Runs per day: ${data.days.map((d) => `${d.day} ${d.runs}`).join(", ")}`}>
            <Text style={label}>Runs per day</Text>
            <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8, height: 120, marginTop: 12 }}>
              {data.days.map((d, i) => (
                <View key={d.day} style={{ flex: 1, alignItems: "center", justifyContent: "flex-end", height: "100%" }}>
                  {d.runs > 0 && <Text style={{ color: c.muted, fontSize: 11, marginBottom: 4 }}>{d.runs}</Text>}
                  <View style={{ width: "100%", height: `${(d.runs / peak) * 80}%`, minHeight: 2, borderRadius: 2, overflow: "hidden", backgroundColor: i === data.days.length - 1 ? c.text : c.muted }}>
                    {d.failed > 0 && <View style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: `${(d.failed / d.runs) * 100}%`, backgroundColor: c.err }} />}
                  </View>
                </View>
              ))}
            </View>
            <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
              {data.days.map((d) => (
                <Text key={d.day} style={{ flex: 1, textAlign: "center", color: c.muted, fontSize: 12 }}>
                  {new Date(`${d.day}T12:00:00`).toLocaleDateString([], { weekday: "narrow" })}
                </Text>
              ))}
            </View>
            {data.failed > 0 && <Text style={{ ...label, marginTop: 8 }}>The red part of a bar is runs that failed.</Text>}
          </View>

          <View>
            <Text style={label}>Models</Text>
            {data.providers.map((p, i) => (
              <View key={p.provider} style={{ flexDirection: "row", paddingVertical: 12, borderTopWidth: i ? 1 : 0, borderTopColor: c.border, gap: 12 }}>
                <Text style={{ color: c.text, fontSize: 16, flex: 1 }}>{LABEL[p.provider] ?? p.provider}</Text>
                <Text style={{ color: c.text, fontSize: 15, fontVariant: ["tabular-nums"] }}>{p.calls} calls</Text>
                <Text style={{ color: p.failed ? c.err : c.muted, fontSize: 15, width: 76, textAlign: "right", fontVariant: ["tabular-nums"] }}>{p.failed ? `${p.failed} failed` : "no fails"}</Text>
                <Text style={{ color: c.muted, fontSize: 15, width: 44, textAlign: "right", fontVariant: ["tabular-nums"] }}>{duration(p.avgMs)}</Text>
              </View>
            ))}
            {!data.providers.length && <Text style={{ color: c.muted, fontSize: 15, paddingVertical: 8 }}>No model calls this week.</Text>}
          </View>
        </>
      )}
    </ScrollView>
  );
}
