import * as Speech from "expo-speech";
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from "expo-speech-recognition";
import { useCallback, useRef, useState } from "react";

/**
 * Listening on the phone itself (Android's speech recognition): no key, no upload of your voice to
 * the hub, words appear as you speak, and it stops by itself when you pause. Indian English by
 * default, so Tamil names and Tanglish come through better.
 */
export const LISTEN_LANG = "en-IN";

export function canListen(): boolean {
  try {
    return ExpoSpeechRecognitionModule.isRecognitionAvailable();
  } catch {
    return false; // an APK built before speech recognition was added
  }
}

/** Says `text` aloud; anything still being said is cut off first. Resolves when it finishes or is stopped. */
export function speak(text: string): Promise<void> {
  Speech.stop().catch(() => {});
  return new Promise((done) => {
    if (!text.trim()) return done();
    Speech.speak(text, { language: LISTEN_LANG, rate: 1.0, onDone: () => done(), onStopped: () => done(), onError: () => done() });
  });
}

export const stopSpeaking = () => void Speech.stop().catch(() => {});

const MESSAGES: Record<string, string> = {
  "not-allowed": "The microphone or speech recognition is off for this app: allow it in Android Settings.",
  "service-not-allowed": "This phone has no speech recognition service (install or enable the Google app).",
  "language-not-supported": "Speech recognition here doesn't support Indian English.",
  network: "Speech recognition needs the internet on this phone.",
};

/**
 * `start()` listens until you pause; `partial` shows the words so far; `onFinal` gets the full
 * sentence. Nothing heard calls `onFinal("")`.
 */
export function useListen(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState("");
  const final = useRef("");
  const sent = useRef(true);
  const cb = useRef(onFinal);
  cb.current = onFinal;

  const finish = () => {
    if (sent.current) return;
    sent.current = true;
    cb.current(final.current.trim());
  };

  useSpeechRecognitionEvent("start", () => setListening(true));
  useSpeechRecognitionEvent("result", (e) => {
    const t = e.results[0]?.transcript ?? "";
    setPartial(t);
    if (e.isFinal) final.current = t;
  });
  useSpeechRecognitionEvent("error", (e) => {
    if (e.error !== "aborted" && e.error !== "no-speech") setError(MESSAGES[e.error] ?? e.message);
  });
  useSpeechRecognitionEvent("end", () => {
    setListening(false);
    finish();
  });

  const start = useCallback(async () => {
    setError("");
    stopSpeaking(); // tapping the mic while Jarvis talks interrupts it
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) {
      setError(MESSAGES["not-allowed"]);
      return false;
    }
    final.current = "";
    sent.current = false;
    setPartial("");
    ExpoSpeechRecognitionModule.start({ lang: LISTEN_LANG, interimResults: true, continuous: false, addsPunctuation: true });
    return true;
  }, []);

  /** Stop and use what was heard so far. */
  const stop = useCallback(() => {
    try {
      ExpoSpeechRecognitionModule.stop();
    } catch {
      /* not listening */
    }
  }, []);

  /** Stop and throw away what was heard. */
  const cancel = useCallback(() => {
    sent.current = true;
    try {
      ExpoSpeechRecognitionModule.abort();
    } catch {
      /* not listening */
    }
    setPartial("");
  }, []);

  return { listening, partial, error, setError, start, stop, cancel };
}
