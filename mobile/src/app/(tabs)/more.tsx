import { router } from "expo-router";
import { ScrollView } from "react-native";
import { useTabSpace } from "../../components/FloatingTabs";
import { Group, Heading, ListRow } from "../../components/ui";

const SECTIONS = [
  {
    title: "Get things done",
    rows: [
      ["Devices", "Your computers, files and screenshots", "/devices"],
      ["Mail", "Drafts waiting for your Send", "/mail"],
      ["Shopping", "Carts it filled and where to buy", "/shop"],
      ["Try a project", "Run a zip, repo or link and get a video", "/tryouts"],
      ["On your phone", "Things waiting for your tap", "/phone"],
      ["Record", "Record a conversation", "/record"],
    ],
  },
  {
    title: "What it knows",
    rows: [
      ["Tasks", "From your mail, WhatsApp and you", "/tasks"],
      ["Memory", "Everything it remembers", "/memory"],
      ["People you know", "How you talk to each person", "/people"],
      ["WhatsApp chats", "Which chats it reads", "/wa-chats"],
      ["Insights", "What got done this week", "/insights"],
      ["Learning", "What it learned from your feedback", "/learning"],
    ],
  },
  {
    title: "AI and app",
    rows: [
      ["AI hub", "Which AI does which job", "/ai-hub"],
      ["Tokens and limits", "Use and what is left per model", "/limits"],
      ["Outside agents", "Other AI tools you allow in", "/agents"],
      ["Colours and feel", "Colour set, light or dark, haptics", "/look"],
      ["Settings", "Hub, notifications, voice, Gmail", "/settings"],
      ["Update this app", "Install the newest version", "/update"],
    ],
  },
] as const;

/** Every screen that is not a tab, sorted by what you came to do. */
export default function More() {
  const space = useTabSpace();
  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: space, gap: 10 }}>
      {SECTIONS.map((s) => [
        <Heading key={s.title} text={s.title} />,
        <Group key={`${s.title} rows`}>
          {s.rows.map(([title, sub, to], i) => (
            <ListRow key={to} first={i === 0} title={title} sub={sub} onPress={() => router.push(to as never)} />
          ))}
        </Group>,
      ])}
    </ScrollView>
  );
}
