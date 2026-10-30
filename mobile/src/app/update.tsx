import Constants from "expo-constants";
import { cacheDirectory, deleteAsync, downloadAsync, getContentUriAsync } from "expo-file-system/legacy";
import * as IntentLauncher from "expo-intent-launcher";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { Linking, RefreshControl, ScrollView, Text } from "react-native";
import { Button, Card, ErrorText, Muted, Row } from "../components/ui";
import { Api, type AppUpdate, authHeaders, hubUrl } from "../lib/api";
import { useColors } from "../lib/theme";

/**
 * Update this app: the newest APK the hub built of this app (a build of "orchestrator", made on the
 * laptop's Android tools). Install downloads it and hands it to Android's installer, which asks you
 * to confirm; the first time Android also asks you to allow installs from Orchestrator.
 * The update is signed with the same key as this app, so it installs over it and keeps your settings.
 */
const FLAG_GRANT_READ_URI_PERMISSION = 1;

const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`;
const when = (t: number) => new Date(t).toLocaleString();

export default function Update() {
  const c = useColors();
  const [u, setU] = useState<AppUpdate>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const extra = (Constants.expoConfig?.extra ?? {}) as { commit?: string; builtAt?: string };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setU(await Api.appUpdate());
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useFocusEffect(useCallback(() => void load(), [load]));

  const install = async () => {
    if (!u?.available) return;
    const base = hubUrl();
    if (!base) return setError("Not connected to a hub yet.");
    setError("");
    setBusy("Downloading…");
    const file = `${cacheDirectory}orchestrator-${u.build}.apk`;
    try {
      await deleteAsync(file, { idempotent: true });
      const r = await downloadAsync(`${base}${u.apk}`, file, { headers: authHeaders() });
      if (r.status !== 200) throw new Error(`the hub answered HTTP ${r.status}`);
      setBusy("Opening the installer…");
      const uri = await getContentUriAsync(r.uri);
      await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
        data: uri,
        type: "application/vnd.android.package-archive",
        flags: FLAG_GRANT_READ_URI_PERMISSION,
      });
    } catch (e) {
      setError(`${(e as Error).message}. You can also open the APK in the browser below.`);
    } finally {
      setBusy("");
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} refreshControl={<RefreshControl refreshing={loading} onRefresh={load} colors={[c.accent]} />}>
      <Card>
        <Text style={{ color: c.text, fontSize: 16, fontWeight: "600" }}>This app</Text>
        <Muted small>{`Built ${extra.builtAt ? new Date(extra.builtAt).toLocaleString() : "at an unknown time"}${extra.commit ? ` from ${extra.commit}` : ""} · version ${Constants.expoConfig?.version ?? "?"}`}</Muted>
      </Card>
      <ErrorText text={error} />
      {u && !u.available && (
        <Card>
          <Text style={{ color: c.text, fontSize: 16 }}>No newer build on the hub.</Text>
          <Muted small>
            Ask Jarvis "continue the Orchestrator app: …" or start a build of "orchestrator" in Builds. When its preview is ready (the APK is built on the laptop), it shows up here.
          </Muted>
          <Row>
            <Button title="Builds" onPress={() => router.push("/builds" as never)} />
          </Row>
        </Card>
      )}
      {u?.available && (
        <Card attention>
          <Text style={{ color: c.text, fontSize: 16, fontWeight: "600" }}>{`Build ${u.build}${u.status === "merged" ? " (merged)" : u.status === "ready" ? " (not merged yet)" : ""}`}</Text>
          <Muted small>{`APK built ${when(u.builtAt)} · ${mb(u.size)}${u.branch ? ` · ${u.branch}` : ""}`}</Muted>
          <Text style={{ color: c.text, fontSize: 15, lineHeight: 21 }}>{u.spec}</Text>
          <Row>
            <Button kind="primary" title={busy || "Install"} busy={!!busy} onPress={() => void install()} />
            <Button title="Open in browser" onPress={() => void Linking.openURL(`${hubUrl()}${u.apk}`)} />
          </Row>
          <Muted small>Android asks you to confirm the update. The first time, it also asks you to allow installs from Orchestrator: allow it, then go back and tap Install again.</Muted>
        </Card>
      )}
    </ScrollView>
  );
}
