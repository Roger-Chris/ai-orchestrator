import { router } from "expo-router";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { matchWake } from "./wakephrase";
import { LISTEN_LANG, canListen } from "./listen";
import { micHeld, micOwner, registerWakeStopper, setMicOwner, watchMic } from "./mic";
import { getVoiceChoice, watchVoice } from "./voice";

/**
 * "Hey Jarvis" while the app is open (Settings → Voice). Android's recogniser listens continuously
 * on the phone; when it hears the wake phrase it opens the Talk screen, with whatever you said after
 * it as the first question ("Hey Jarvis, what's on today"). Only while the app is on screen and no
 * screen is using the mic itself; Android may click softly each time listening restarts.
 * A background, screen-off wake word would need a native always-on service: not built.
 */

const RESTART_MS = 400;
/** After the wake phrase, wait this long for the rest of the sentence before opening Talk anyway. */
const REST_WAIT_MS = 1500;

export function useWakeWord() {
  const [enabled, setEnabled] = useState(false);
  const [, bump] = useState(0);
  const running = useRef(false);
  const woke = useRef<{ rest: string; timer?: ReturnType<typeof setTimeout> } | null>(null);
  const ended = useRef<(() => void) | null>(null);
  const failed = useRef(false);
  const restart = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Quiet for a moment after waking, while the Talk screen opens and takes the mic. */
  const pausedUntil = useRef(0);

  // Settings, app state and mic holds all decide whether to listen.
  useEffect(() => {
    void getVoiceChoice().then((v) => setEnabled(!!v.wakeWord));
    const offVoice = watchVoice((v) => {
      failed.current = false;
      setEnabled(!!v.wakeWord);
    });
    const offMic = watchMic(() => bump((n) => n + 1));
    const app = AppState.addEventListener("change", () => bump((n) => n + 1));
    return () => {
      offVoice();
      offMic();
      app.remove();
    };
  }, []);

  const stop = () =>
    new Promise<void>((done) => {
      clearTimeout(restart.current);
      if (!running.current) return done();
      const t = setTimeout(() => finishStop(), 800); // the end event normally comes much sooner
      const finishStop = () => {
        clearTimeout(t);
        running.current = false;
        if (micOwner() === "wake") setMicOwner("none");
        ended.current = null;
        done();
      };
      ended.current = finishStop;
      try {
        ExpoSpeechRecognitionModule.abort();
      } catch {
        finishStop();
      }
    });

  const shouldRun = () => enabled && !failed.current && Date.now() > pausedUntil.current && AppState.currentState === "active" && !micHeld() && micOwner() !== "listen" && canListen();

  const start = async () => {
    if (running.current || !shouldRun()) return;
    const perm = await ExpoSpeechRecognitionModule.getPermissionsAsync().catch(() => ({ granted: false }));
    if (!perm.granted || !shouldRun() || running.current) return;
    running.current = true;
    woke.current = null;
    setMicOwner("wake");
    ExpoSpeechRecognitionModule.start({ lang: LISTEN_LANG, interimResults: true, continuous: true, contextualStrings: ["Hey Jarvis", "Jarvis"] });
  };

  // Start or stop whenever something relevant changed.
  useEffect(() => {
    registerWakeStopper(stop);
    if (shouldRun()) void start();
    else void stop();
  });
  useEffect(
    () => () => {
      registerWakeStopper(null);
      void stop();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const open = (rest: string) => {
    if (woke.current?.timer) clearTimeout(woke.current.timer);
    woke.current = null;
    pausedUntil.current = Date.now() + 3000;
    setTimeout(() => bump((n) => n + 1), 3100); // re-check once the pause is over
    void stop().then(() => router.push({ pathname: "/talk", params: rest ? { say: rest } : {} }));
  };

  useSpeechRecognitionEvent("result", (e) => {
    if (micOwner() !== "wake") return;
    const text = e.results[0]?.transcript ?? "";
    const m = matchWake(text);
    if (!m) return;
    if (e.isFinal) return open(m.rest);
    // Heard the name: give the rest of the sentence a moment to arrive.
    if (!woke.current) woke.current = { rest: m.rest, timer: setTimeout(() => open(woke.current?.rest ?? ""), REST_WAIT_MS) };
    else woke.current.rest = m.rest;
  });
  useSpeechRecognitionEvent("error", (e) => {
    if (micOwner() !== "wake") return;
    // Silence and timeouts just restart; anything else (no permission, no service) stops until Settings change.
    if (!["no-speech", "speech-timeout", "aborted", "network", "busy"].includes(e.error)) failed.current = true;
  });
  useSpeechRecognitionEvent("end", () => {
    if (ended.current) return ended.current();
    if (micOwner() !== "wake") return;
    running.current = false;
    setMicOwner("none");
    if (woke.current) return open(woke.current.rest);
    // The recogniser stops after a while even in continuous mode: listen again.
    restart.current = setTimeout(() => void start(), RESTART_MS);
  });
}
