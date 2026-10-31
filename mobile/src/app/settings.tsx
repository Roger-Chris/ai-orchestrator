import { router } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, AppState, Platform, ScrollView, Text, View } from "react-native";
import { Button, Card, Dot, Muted, Row } from "../components/ui";
import { VoiceSettings } from "../components/VoiceSettings";
import { Api, connection, hubList, primaryHub } from "../lib/api";
import { askBatteryExemption, batteryRestricted, isXiaomi, openAppSettings, openAutostart } from "../lib/background";
import { enablePush, pushBuiltIn } from "../lib/push";
import { useColors } from "../lib/theme";
import { WaReply } from "../lib/wareply";

/** Xiaomi's Autostart can't be requested by an app: explain, then open the screen where it lives. */
function promptAutostart(): Promise<void> {
  return new Promise((done) =>
    Alert.alert(
      "One more switch on Xiaomi",
      "Xiaomi blocks notifications for apps that aren't allowed to autostart. On the next screen, find Orchestrator and turn Autostart on, then come back.",
      [
        { text: "Later", style: "cancel", onPress: () => done() },
        { text: "Open Autostart", onPress: () => openAutostart().finally(done) },
      ],
    ),
  );
}

export default function Settings() {
  const c = useColors();
  const conn = connection();
  const [pushMsg, setPushMsg] = useState("");
  const [busy, setBusy] = useState("");

  const [restricted, setRestricted] = useState(false);
  const [waOn, setWaOn] = useState(false);
  const [gmail, setGmail] = useState<Awaited<ReturnType<typeof Api.gmail>>>();
  const [controlOn, setControlOn] = useState(false);
  const [canStart, setCanStart] = useState(true);
  const [gmailMsg, setGmailMsg] = useState("");
  const [brain, setBrain] = useState<Awaited<ReturnType<typeof Api.assistant>>>();
  const [usage, setUsage] = useState("");
  const [briefMsg, setBriefMsg] = useState("");

  useEffect(() => {
    Api.gmail().then(setGmail).catch(() => {});
    Api.assistant().then(setBrain).catch(() => {});
  }, []);

  const checkGmail = async () => {
    setBusy("gmail");
    setGmailMsg("");
    try {
      const r = await Api.gmailCheck();
      setGmailMsg(r.scanned ? `Read ${r.scanned} new email(s), added ${r.added} task(s).` : "No new email since the last check.");
    } catch (e) {
      setGmailMsg((e as Error).message);
    } finally {
      setBusy("");
      Api.gmail().then(setGmail).catch(() => {});
    }
  };

  // Re-check when you come back from Android's settings screens.
  useEffect(() => {
    const check = () => {
      setWaOn(WaReply.isEnabled());
      setControlOn(WaReply.control.isOn());
      setCanStart(WaReply.control.canStartApps());
      return batteryRestricted().then(setRestricted);
    };
    void check();
    const sub = AppState.addEventListener("change", (s) => s === "active" && void check());
    return () => sub.remove();
  }, []);

  /** Notifications on, then the background permissions they depend on, one prompt at a time. */
  const turnOn = async () => {
    const msg = await enablePush();
    if (Platform.OS === "android" && msg.startsWith("Notifications are on")) {
      if (await batteryRestricted()) await askBatteryExemption();
      if (isXiaomi) await promptAutostart();
      setRestricted(await batteryRestricted());
    }
    return msg;
  };

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    try {
      setPushMsg(await fn());
    } catch (e) {
      setPushMsg((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const h2 = { color: c.text, fontSize: 17, fontWeight: "700" as const };
  return (
    <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>
      <Card>
        <Text style={h2}>Hub</Text>
        <Muted>{conn?.url ?? "not connected"}</Muted>
        {conn && primaryHub() && conn.url !== primaryHub() ? (
          <Text style={{ color: c.warn }}>Using a backup: {primaryHub()} is not answering. The app goes back to it when it does.</Text>
        ) : null}
        <Muted>
          {hubList().length > 1 ? `Backups if it is down: ${hubList().slice(1).join(", ")}` : "No backup hub yet: start the orchestrator on another device (the laptop) and it is found here."}
        </Muted>
        <Row>
          <Button title="Change hub or token" onPress={() => router.push("/connect")} />
        </Row>
      </Card>

      <Card>
        <Text style={h2}>Assistant</Text>
        <Muted small>Tasks found in your mail and WhatsApp, your shared memory, and which WhatsApp chats are read.</Muted>
        <Row>
          <Button title="Tasks" onPress={() => router.push("/tasks")} />
          <Button title="Memory" onPress={() => router.push("/memory")} />
          <Button title="WhatsApp chats" onPress={() => router.push("/wa-chats")} />
          <Button title="People" onPress={() => router.push("/people")} />
        </Row>
        <Row>
          <Button title="Learning" onPress={() => router.push("/learning" as never)} />
          <Button title="AI hub" onPress={() => router.push("/ai-hub" as never)} />
          <Button title="Builds" onPress={() => router.push("/builds" as never)} />
          <Button title="Phone" onPress={() => router.push("/phone" as never)} />
          <Button title="Outside agents" onPress={() => router.push("/agents" as never)} />
          <Button title="Update this app" onPress={() => router.push("/update" as never)} />
        </Row>
        <Row>
          <Button
            title="Send today's brief now"
            busy={busy === "brief"}
            onPress={() => {
              setBusy("brief");
              Api.briefNow()
                .then(() => setBriefMsg("Sent: it shows under Needs you on Home."))
                .catch((e) => setBriefMsg((e as Error).message))
                .finally(() => setBusy(""));
            }}
          />
          <Button title={usage ? "Hide key usage" : "Model key usage"} onPress={() => (usage ? setUsage("") : Api.modelUsage().then((u) => setUsage(u.report)).catch((e) => setUsage((e as Error).message)))} />
        </Row>
        {!!briefMsg && <Text style={{ color: c.text }}>{briefMsg}</Text>}
        {!!usage && <Text selectable style={{ color: c.text, fontFamily: "monospace", fontSize: 12 }}>{usage}</Text>}
      </Card>

      <VoiceSettings />

      <Card>
        <Text style={h2}>Gmail</Text>
        {brain?.configured && (
          <>
            <Text style={{ color: brain.ok ? c.text : c.err }}>
              {brain.ok ? `From the AI_Assistant brain: ${brain.today ?? 0} task(s) today` : `The brain is not reachable: ${brain.lastError ?? "not synced yet"}`}
            </Text>
            <Muted small>The brain reads your Gmail and turns mail into tasks; today's appear on Home, and ticking one off there marks it done in the brain.</Muted>
          </>
        )}
        {gmail?.connected ? (
          <>
            <Text style={{ color: c.text }}>Connected as {gmail.email}</Text>
            <Muted small>
              {gmail.lastCheck ? `Last checked ${new Date(gmail.lastCheck).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Not checked yet"}
              {gmail.lastAdded ? `, ${gmail.lastAdded} task(s) added` : ""}. New mail is read every few minutes and tasks go to Today on Home.
            </Muted>
            {!!gmail.lastError && <Text style={{ color: c.err }}>{gmail.lastError}</Text>}
            <Row>
              <Button title="Check now" busy={busy === "gmail"} onPress={() => void checkGmail()} />
            </Row>
          </>
        ) : brain?.configured ? null : (
          <Muted small>
            {gmail?.configured
              ? "Not connected. On the hub, run: npm run orc -- gmail connect"
              : "Not set up. Put your Google OAuth client in the hub's folder as gmail-client.json, then run: npm run orc -- gmail connect (the README has the steps)."}
          </Muted>
        )}
        {!!gmailMsg && <Text style={{ color: c.text }}>{gmailMsg}</Text>}
      </Card>

      <Card>
        <Text style={h2}>Notifications</Text>
        <Muted small>Get a notification when an agent asks you something, a step is paused for you, a design needs approval, or a run finishes.</Muted>
        {!pushBuiltIn && <Muted small>This build has no Firebase config, so it can't receive notifications yet. The README explains the 5-minute setup.</Muted>}
        <Row>
          <Button kind="primary" title="Turn on" busy={busy === "on"} disabled={!pushBuiltIn} onPress={() => run("on", turnOn)} />
          <Button title="Send a test" busy={busy === "test"} disabled={!pushBuiltIn} onPress={() => run("test", async () => `Sent to ${(await Api.pushTest()).sent} device(s).`)} />
        </Row>
        {!!pushMsg && <Text style={{ color: c.text }}>{pushMsg}</Text>}
        {Platform.OS === "android" && (
          <View style={{ gap: 8, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 10 }}>
            <Text style={{ color: c.text, fontWeight: "600" }}>Background delivery</Text>
            <Row style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
              <Row style={{ flex: 1, flexWrap: "nowrap" }}>
                <Dot color={restricted ? c.warn : c.ok} />
                <Text style={{ color: c.text, flex: 1 }}>{restricted ? "Battery saver may stop the app" : "Allowed to run in background"}</Text>
              </Row>
              {restricted && <Button small title="Allow" onPress={() => void askBatteryExemption()} />}
            </Row>
            {isXiaomi && (
              <Row style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                <Row style={{ flex: 1, flexWrap: "nowrap" }}>
                  <Dot color={c.muted} />
                  <Text style={{ color: c.text, flex: 1 }}>Xiaomi Autostart (turn on for Orchestrator)</Text>
                </Row>
                <Button small title="Open" onPress={() => void openAutostart()} />
              </Row>
            )}
            <Button small title="All app permissions" onPress={() => void openAppSettings()} />
          </View>
        )}
      </Card>

      {WaReply.control.available && (
        <Card>
          <Text style={h2}>Let Jarvis open apps</Text>
          <Muted small>Ask from anywhere, such as your laptop, and the app opens on this phone. A notification stays visible while this is on. Only opening apps works this way: alarms, calls, texts and files still wait for your tap.</Muted>
          <Row style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
            <Row style={{ flex: 1, flexWrap: "nowrap" }}>
              <Dot color={controlOn ? c.ok : c.muted} />
              <Text style={{ color: c.text, flex: 1 }}>{controlOn ? "On" : "Off"}</Text>
            </Row>
            <Button
              small
              title={controlOn ? "Turn off" : "Turn on"}
              onPress={() => {
                WaReply.control.set(!controlOn);
                setControlOn(!controlOn);
              }}
            />
          </Row>
          {controlOn && !canStart && <Button small title="Allow display over other apps" onPress={() => WaReply.control.openOverlaySettings()} />}
          {controlOn && isXiaomi && (
            <>
              <Muted small>On Xiaomi, also turn on "Display pop-up windows while running in the background".</Muted>
              <Button small title="Open Xiaomi permissions" onPress={() => WaReply.control.openXiaomiPermissions()} />
            </>
          )}
        </Card>
      )}

      {WaReply.available && (
        <Card>
          <Text style={h2}>WhatsApp replies</Text>
          <Muted small>
            When a WhatsApp message arrives, Orchestrator shows who wrote, what they said and a suggested reply in your style. Tap Send suggestion, or Reply to type your own: WhatsApp itself sends it, only when you tap. It works while WhatsApp's notification for that chat is still showing.
          </Muted>
          <Row style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
            <Row style={{ flex: 1, flexWrap: "nowrap" }}>
              <Dot color={waOn ? c.ok : c.muted} />
              <Text style={{ color: c.text, flex: 1 }}>{waOn ? "Reading WhatsApp notifications" : "Needs Notification access"}</Text>
            </Row>
            {!waOn && <Button small title="Allow" onPress={() => WaReply.openSettings()} />}
          </Row>
          {!waOn && (
            <Muted small>
              On the next screen turn on Orchestrator. If Android says it's a restricted setting: App info → ⋮ (top right) → Allow restricted settings, then try again.
            </Muted>
          )}
        </Card>
      )}

    </ScrollView>
  );
}
