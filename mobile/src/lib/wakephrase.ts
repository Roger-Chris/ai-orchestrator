/**
 * Spotting "Hey Jarvis" in recognised speech (the phone app listens with Android's recogniser while
 * it is open, mobile/src/lib/wake.ts `useWakeWord`). Plain TypeScript with no app imports, so the hub's vitest suite tests it (tests/wake.test.ts).
 */

// What Android's recogniser makes of "Jarvis" in Indian English, from the owner's tests and common mishearings.
const NAME = "(?:jarvis|jarvi|jarves|jarviz|jervis|jarwis)";
const GREETING = "(?:hey|hi|hay|hello|ok|okay|yo|a)";
// Either a greeting then the name anywhere, or the name first thing in the sentence.
const WAKE = new RegExp(`(?:\\b${GREETING}[\\s,]+${NAME}|^\\s*${NAME})\\b[\\s,.!?]*(.*)$`, "i");

export interface WakeMatch {
  /** The words after the wake phrase ("what's on today"), empty when you only said the name. */
  rest: string;
}

export function matchWake(text: string): WakeMatch | null {
  const m = text.match(WAKE);
  if (!m) return null;
  return { rest: m[1].replace(/^[\s,.!?]+/, "").trim() };
}
