import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { Api } from "../lib/api";
import { useColors } from "../lib/theme";

/**
 * Good / Not right under an answer: the learning harness's signal. "Not right" asks what it should
 * have done; that note is what the nightly reflection learns from. Saying "no, I meant…" in the next
 * message counts too, and "from now on…" teaches it straight away.
 */
export function Feedback({ episodeId, used }: { episodeId?: number; used?: { id: number; text: string }[] }) {
  const c = useColors();
  const [sent, setSent] = useState<"good" | "bad">();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [showUsed, setShowUsed] = useState(false);
  if (!episodeId) return null;

  const send = async (good: boolean, n = "") => {
    setErr("");
    try {
      await Api.feedback(episodeId, good, n);
      setSent(good ? "good" : "bad");
      setAsking(false);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const link = (title: string, onPress: () => void, color = c.muted) => (
    <Pressable onPress={onPress} hitSlop={8}>
      <Text style={{ color, fontSize: 13 }}>{title}</Text>
    </Pressable>
  );

  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", gap: 18, alignItems: "center" }}>
        {sent ? (
          <Text style={{ color: c.muted, fontSize: 13 }}>{sent === "good" ? "Thanks, noted." : "Noted: I'll learn from it tonight."}</Text>
        ) : (
          <>
            {link("Good", () => void send(true))}
            {link("Not right", () => setAsking(true))}
          </>
        )}
        {!!used?.length && link(showUsed ? "Hide what I learnt" : `Used ${used.length} thing${used.length === 1 ? "" : "s"} I learnt`, () => setShowUsed(!showUsed))}
      </View>
      {showUsed && used!.map((l) => <Text key={l.id} style={{ color: c.muted, fontSize: 13 }}>{`• ${l.text}`}</Text>)}
      {asking && !sent && (
        <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-end" }}>
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder="What should I have done? (optional)"
            placeholderTextColor={c.muted}
            multiline
            style={{ flex: 1, color: c.text, borderColor: c.border, borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 6, fontSize: 14 }}
          />
          {link("Send", () => void send(false, note), c.accent)}
        </View>
      )}
      {!!err && <Text style={{ color: c.err, fontSize: 13 }}>{err}</Text>}
    </View>
  );
}
