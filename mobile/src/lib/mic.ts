import { useFocusEffect } from "expo-router";
import { useCallback } from "react";

/**
 * Who is using Android's speech recogniser right now. There is one recogniser and its events go to
 * every listener in the app, so each user (a screen's mic, or the "Hey Jarvis" listener) only reacts
 * while it owns it. Screens that talk (Assistant, Talk, a call) hold the mic while they are on
 * screen, which keeps the wake word listener off so it never hears Jarvis speaking or steals the mic.
 */
export type MicOwner = "none" | "listen" | "wake";

let owner: MicOwner = "none";
let holds = 0;
const watchers = new Set<() => void>();
let wakeStopper: (() => Promise<void>) | null = null;

const notify = () => watchers.forEach((w) => w());

export const micOwner = () => owner;
export const micHeld = () => holds > 0;

export function setMicOwner(next: MicOwner) {
  owner = next;
  notify();
}

/** Called when anything changes that may let the wake word listener start or require it to stop. */
export function watchMic(fn: () => void): () => void {
  watchers.add(fn);
  return () => void watchers.delete(fn);
}

/** The wake word listener registers how to stop it (resolves once the recogniser has ended). */
export function registerWakeStopper(stop: (() => Promise<void>) | null) {
  wakeStopper = stop;
}

/** A screen's mic takes the recogniser: the wake word listener is stopped first. */
export async function claimMic(): Promise<void> {
  if (owner === "wake" && wakeStopper) await wakeStopper();
  setMicOwner("listen");
}

/** Keeps the wake word listener off while this screen is focused. */
export function useHoldMic() {
  useFocusEffect(
    useCallback(() => {
      holds++;
      notify();
      return () => {
        holds = Math.max(0, holds - 1);
        notify();
      };
    }, []),
  );
}
