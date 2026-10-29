import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, Switch, Text, View } from "react-native";
import { ErrorText, Muted } from "../components/ui";
import { Api, type WaChat } from "../lib/api";
import { useColors } from "../lib/theme";

/** WhatsApp chats the brain reads, busiest first. A muted chat is kept as context but never becomes tasks. */
export default function WaChats() {
  const c = useColors();
  const [chats, setChats] = useState<WaChat[]>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setChats(await Api.waChats());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));

  const toggle = async (chat: WaChat) => {
    setChats((all) => all?.map((x) => (x.id === chat.id ? { ...x, muted: !chat.muted } : x)));
    try {
      await Api.muteChat(chat.id, !chat.muted);
    } catch (e) {
      setError((e as Error).message);
      void load();
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 20 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} colors={[c.accent]} />}>
      <Muted small>Muted chats are still stored, so the assistant knows the context, but nothing in them turns into tasks or alerts.</Muted>
      <ErrorText text={error} />
      {chats?.map((chat) => (
        <View key={chat.id} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border, marginTop: 4 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: chat.muted ? c.muted : c.text, fontSize: 16 }} numberOfLines={1}>{chat.name}</Text>
            <Text style={{ color: c.muted, fontSize: 13 }}>{`${chat.is_group ? "group · " : ""}${chat.messages} messages${chat.muted ? " · muted" : ""}`}</Text>
          </View>
          <Switch value={!chat.muted} onValueChange={() => void toggle(chat)} trackColor={{ true: c.accent, false: c.border }} />
        </View>
      ))}
      {chats && !chats.length && <Muted>No WhatsApp chats yet: the bridge has not sent any messages.</Muted>}
    </ScrollView>
  );
}
