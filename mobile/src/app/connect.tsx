import { router } from "expo-router";
import { useEffect, useState } from "react";
import { KeyboardAvoidingView, ScrollView, Text } from "react-native";
import { Button, Card, ErrorText, Field, Muted } from "../components/ui";
import { Api, connection, saveConnection } from "../lib/api";
import { useColors } from "../lib/theme";

/** Where the hub is (its Tailscale address) and the ORC_TOKEN from its .env. */
export default function Connect() {
  const c = useColors();
  const [url, setUrl] = useState("http://");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const cur = connection();
    if (cur) {
      setUrl(cur.url);
      setToken(cur.token);
    }
  }, []);

  const save = async () => {
    setBusy(true);
    setError("");
    const prev = connection();
    try {
      let u = url.trim().replace(/\/+$/, "");
      if (!/^https?:\/\//.test(u)) u = `http://${u}`;
      // Plain http without a port means the orchestrator's default port.
      if (u.startsWith("http://") && !/:\d+$/.test(u)) u = `${u}:4317`;
      await saveConnection({ url: u, token });
      await Api.health();
      await Api.threads(); // checks the token too
      router.replace("/");
    } catch (e) {
      if (prev) await saveConnection(prev);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: c.text, fontSize: 22, fontWeight: "700" }}>Connect to your hub</Text>
        <Muted>The hub is the always-on PC running the orchestrator. Turn Tailscale on in this phone first.</Muted>
        <Card>
          <Field label="Hub address" value={url} onChangeText={setUrl} placeholder="http://my-pc:4317" autoCapitalize="none" autoCorrect={false} keyboardType="url" />
          <Muted small>Its Tailscale name or 100.x.y.z address, port 4317. Find it in the Tailscale app.</Muted>
          <Field label="Access token" value={token} onChangeText={setToken} placeholder="ORC_TOKEN from the hub's .env" autoCapitalize="none" autoCorrect={false} secureTextEntry />
          <Button kind="primary" title="Connect" busy={busy} disabled={!url.trim() || url.trim() === "http://"} onPress={save} />
          <ErrorText text={error} />
        </Card>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
