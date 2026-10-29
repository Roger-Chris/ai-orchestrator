import { useEffect, useState } from "react";
import { Text } from "react-native";
import { useColors } from "../lib/theme";
import { type HubTts, type VoiceChoice, getVoiceChoice, hubTts, phoneVoices, setVoiceChoice, speak, stopSpeaking } from "../lib/voice";
import { Button, Card, Muted, Row } from "./ui";

const SAMPLE = "Hi, I'm Jarvis. Your build finished and two tasks are due today.";

/** Settings → Voice: the hub's speech service and voice, or the phone's own voice, with a test line. */
export function VoiceSettings() {
  const c = useColors();
  const [v, setV] = useState<VoiceChoice>({ engine: "auto" });
  const [hub, setHub] = useState<HubTts | null>(null);
  const [phone, setPhone] = useState<{ id: string; label: string }[]>([]);
  const [showPhone, setShowPhone] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    getVoiceChoice().then(setV);
    hubTts(true).then(setHub);
    phoneVoices().then(setPhone);
    return () => stopSpeaking();
  }, []);

  const pick = (next: VoiceChoice) => {
    setV(next);
    void setVoiceChoice(next);
  };
  const test = async () => {
    setTesting(true);
    await speak(SAMPLE).finally(() => setTesting(false));
  };

  const services = hub?.providers.filter((p) => p.ready || p.restingUntil) ?? [];
  const service = services.find((p) => p.id === (v.provider || hub?.default?.provider));
  const h2 = { color: c.text, fontSize: 17, fontWeight: "700" as const };
  const sub = { color: c.text, fontWeight: "600" as const };

  return (
    <Card>
      <Text style={h2}>Voice</Text>
      <Muted small>
        How Jarvis sounds when it speaks. Auto uses the hub's voice service when it has one and the phone's own voice otherwise; if the hub can't say something, the phone says it.
      </Muted>
      <Row>
        {(["auto", "hub", "phone"] as const).map((e) => (
          <Button key={e} small kind={v.engine === e ? "primary" : "ghost"} title={e === "auto" ? "Auto" : e === "hub" ? "Hub voice" : "Phone voice"} disabled={e === "hub" && !hub?.enabled} onPress={() => pick({ ...v, engine: e })} />
        ))}
      </Row>
      {!hub?.enabled && (
        <Muted small>
          The hub has no voice service yet. Add OPENAI_API_KEY or GEMINI_API_KEY to the hub's .env (or accept Groq's Orpheus terms in the Groq console) and restart it.
        </Muted>
      )}

      {v.engine !== "phone" && services.length > 0 && (
        <>
          <Text style={sub}>Service</Text>
          <Row>
            {services.map((p) => (
              <Button key={p.id} small kind={service?.id === p.id ? "primary" : "ghost"} title={p.ready ? p.label : `${p.label} (resting)`} onPress={() => pick({ ...v, provider: p.id, voice: undefined })} />
            ))}
          </Row>
          {!!service?.lastError && !service.ready && <Text style={{ color: c.warn }}>{service.lastError}</Text>}
          {service && (
            <>
              <Text style={sub}>Voice</Text>
              <Row>
                {service.voices.map((x) => (
                  <Button key={x.id} small kind={(v.provider === service.id && v.voice ? v.voice : service.voice) === x.id ? "primary" : "ghost"} title={x.label} onPress={() => pick({ ...v, provider: service.id, voice: x.id })} />
                ))}
              </Row>
            </>
          )}
        </>
      )}

      {v.engine !== "hub" && (
        <>
          <Row style={{ justifyContent: "space-between" }}>
            <Text style={sub}>Phone voice: {phone.find((p) => p.id === v.phoneVoice)?.label ?? "default"}</Text>
            <Button small title={showPhone ? "Hide" : "Change"} onPress={() => setShowPhone(!showPhone)} />
          </Row>
          {showPhone && (
            <Row>
              <Button small kind={!v.phoneVoice ? "primary" : "ghost"} title="Default" onPress={() => pick({ ...v, phoneVoice: undefined })} />
              {phone.map((p) => (
                <Button key={p.id} small kind={v.phoneVoice === p.id ? "primary" : "ghost"} title={p.label} onPress={() => pick({ ...v, phoneVoice: p.id })} />
              ))}
              {!phone.length && <Muted small>No English voices listed by Android's text-to-speech.</Muted>}
            </Row>
          )}
        </>
      )}

      <Row>
        <Button title={testing ? "Stop" : "Test voice"} onPress={() => (testing ? stopSpeaking() : void test())} />
      </Row>
    </Card>
  );
}
