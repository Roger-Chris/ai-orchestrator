import { Fragment, type ReactElement } from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { type Colors, useColors } from "./theme";

/**
 * A small Markdown renderer for agent answers: headings, paragraphs, lists, code blocks,
 * inline code, bold and links. Enough for what models write; no HTML, no web view.
 */
export function Markdown({ text }: { text: string }) {
  const c = useColors();
  const s = styles(c);
  const blocks: ReactElement[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) blocks.push(<Text key={blocks.length} style={s.p} selectable>{inline(para.join(" "), s)}</Text>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const l = list;
    blocks.push(
      <View key={blocks.length} style={s.list}>
        {l.items.map((item, i) => (
          <View key={i} style={s.li}>
            <Text style={s.bullet}>{l.ordered ? `${i + 1}.` : "•"}</Text>
            <Text style={s.liText} selectable>{inline(item, s)}</Text>
          </View>
        ))}
      </View>,
    );
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("```")) {
      flushPara();
      flushList();
      const code: string[] = [];
      while (++i < lines.length && !lines[i].startsWith("```")) code.push(lines[i]);
      blocks.push(
        <ScrollView key={blocks.length} horizontal style={s.pre} contentContainerStyle={{ padding: 10 }}>
          <Text style={s.code} selectable>
            {code.join("\n")}
          </Text>
        </ScrollView>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    const item = line.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
    if (heading) {
      flushPara();
      flushList();
      blocks.push(
        <Text key={blocks.length} style={[s.h, { fontSize: [20, 18, 16, 15][heading[1].length - 1] }]}>
          {inline(heading[2], s)}
        </Text>,
      );
    } else if (item) {
      flushPara();
      const ordered = /\d/.test(item[1]);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(item[2]);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return <View style={{ gap: 8 }}>{blocks}</View>;
}

/** **bold**, `code` and [links](https://…) inside a line. */
function inline(text: string, s: ReturnType<typeof styles>) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) return <Text key={i} style={{ fontWeight: "700" }}>{p.slice(2, -2)}</Text>;
    if (p.startsWith("`") && p.endsWith("`")) return <Text key={i} style={s.inlineCode}>{p.slice(1, -1)}</Text>;
    const link = p.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (link)
      return (
        <Text key={i} style={s.link} onPress={() => Linking.openURL(link[2])}>
          {link[1]}
        </Text>
      );
    return <Fragment key={i}>{p}</Fragment>;
  });
}

const styles = (c: Colors) =>
  StyleSheet.create({
    p: { color: c.text, fontSize: 15, lineHeight: 22 },
    h: { color: c.text, fontWeight: "700", marginTop: 4 },
    list: { gap: 4 },
    li: { flexDirection: "row", gap: 8, paddingRight: 8 },
    bullet: { color: c.muted, fontSize: 15, lineHeight: 22, minWidth: 16 },
    liText: { color: c.text, fontSize: 15, lineHeight: 22, flex: 1 },
    pre: { backgroundColor: c.surface2, borderRadius: 8 },
    code: { color: c.text, fontFamily: "monospace", fontSize: 13 },
    inlineCode: { fontFamily: "monospace", backgroundColor: c.surface2, fontSize: 13.5 },
    link: { color: c.accent, textDecorationLine: "underline" },
  });
