import { ScrollView, Text, View } from "react-native";
import { Group, Heading, ListRow, Press, Segments, Toggle } from "../components/ui";
import { feel } from "../lib/feel";
import { COLOR_SETS, type ColorSet, setLook, useColors, useLook } from "../lib/theme";

const MODES = [
  { id: "auto", label: "Automatic" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;

/** The colour set, light or dark, and haptics. Kept on this phone. */
export default function LookScreen() {
  const c = useColors();
  const look = useLook();
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: 32 }}>
      <Heading text="Colour set" />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        {(Object.keys(COLOR_SETS) as ColorSet[]).map((id) => {
          const set = COLOR_SETS[id];
          const on = look.set === id;
          return (
            <Press
              key={id}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${set.name} colour set`}
              haptic="tick"
              onPress={() => setLook({ set: id })}
              style={{ width: "48%", flexGrow: 1, padding: 12, gap: 10, borderRadius: 16, backgroundColor: c.surface, borderWidth: on ? 2 : 0.5, borderColor: on ? c.accent : c.border }}
            >
              <View style={{ height: 44, borderRadius: 10, backgroundColor: set.light[1], alignItems: "flex-start", justifyContent: "center", paddingHorizontal: 10 }}>
                <View style={{ backgroundColor: set.light[0], borderRadius: 11, paddingHorizontal: 12, paddingVertical: 3 }}>
                  <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>Aa</Text>
                </View>
              </View>
              <Text style={{ color: c.text, fontSize: 15, fontWeight: "600" }}>{on ? `${set.name} · In use` : set.name}</Text>
            </Press>
          );
        })}
      </View>
      <Heading text="Appearance" />
      <Segments options={MODES} value={look.mode} onChange={(mode) => setLook({ mode })} />
      <Heading text="Feel" />
      <Group>
        <ListRow first title="Haptics" sub="A small tap you feel when you press" right={<Toggle label="Haptics" value={look.haptics} onChange={(haptics) => setLook({ haptics })} />} />
        <ListRow title="Try the feel" sub="A success tap, as when you finish a task" onPress={feel.done} />
      </Group>
    </ScrollView>
  );
}
