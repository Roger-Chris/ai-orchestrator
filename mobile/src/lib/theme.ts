import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";
import { useColorScheme } from "react-native";

const light = {
  bg: "#f7f3ec",
  surface: "#fffdf9",
  surface2: "#f0eadf",
  border: "#e5ddd0",
  text: "#231d16",
  muted: "#665c50",
  accent: "#a4492a",
  accentSoft: "#f5e4da",
  accentInk: "#ffffff",
  ok: "#3f7a3a",
  warn: "#8f5b08",
  warnSoft: "#f6e8cd",
  err: "#b3261e",
  claude: "#c2410c",
  codex: "#047857",
  gemini: "#1d4ed8",
  perplexity: "#0e7490",
  groq: "#be185d",
  local: "#4d7c0f",
  manus: "#57534e",
  hermes: "#6d28d9",
};

const dark: typeof light = {
  bg: "#161310",
  surface: "#211d18",
  surface2: "#2b261f",
  border: "#3a342b",
  text: "#f5efe7",
  muted: "#b8aea2",
  accent: "#e5936f",
  accentSoft: "#3a2318",
  accentInk: "#1e120b",
  ok: "#8fce83",
  warn: "#e5b55c",
  warnSoft: "#362710",
  err: "#f2877e",
  claude: "#fb923c",
  codex: "#34d399",
  gemini: "#93c5fd",
  perplexity: "#67e8f9",
  groq: "#f9a8d4",
  local: "#bef264",
  manus: "#d6d3d1",
  hermes: "#c4b5fd",
};

export type Colors = typeof light;

/** The colour sets on the Colours and feel screen: only the accent changes, the warm ground stays. */
export const COLOR_SETS = {
  clay: { name: "Clay", light: ["#a4492a", "#f5e4da"], dark: ["#e5936f", "#3a2318"] },
  walnut: { name: "Walnut", light: ["#6b4a2f", "#eee3d6"], dark: ["#d0ac8a", "#33261b"] },
  olive: { name: "Olive", light: ["#5c6b2f", "#e9ecd6"], dark: ["#b8c77e", "#2a2f17"] },
  burgundy: { name: "Burgundy", light: ["#8a2f3b", "#f3e0e0"], dark: ["#e8919c", "#3a1a1f"] },
  honey: { name: "Honey", light: ["#8f5b08", "#f6e8cd"], dark: ["#e5b55c", "#362710"] },
  stone: { name: "Stone", light: ["#4a4a44", "#e8e5dd"], dark: ["#d6d3c9", "#302e29"] },
} as const;
export type ColorSet = keyof typeof COLOR_SETS;
export type Look = { set: ColorSet; mode: "auto" | "light" | "dark"; haptics: boolean };

const KEY = "orc.look";
let look: Look = { set: "clay", mode: "auto", haptics: true };
const listeners = new Set<() => void>();
const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => listeners.delete(f);
};

export const currentLook = () => look;
export const useLook = () => useSyncExternalStore(subscribe, currentLook);

export function setLook(change: Partial<Look>) {
  look = { ...look, ...change };
  listeners.forEach((f) => f());
  SecureStore.setItemAsync(KEY, JSON.stringify(look)).catch(() => {});
}

/** Read once at start; a missing or unreadable choice leaves the defaults. */
export async function loadLook() {
  try {
    const saved = JSON.parse((await SecureStore.getItemAsync(KEY)) ?? "{}") as Partial<Look>;
    look = { ...look, ...saved };
    if (!(look.set in COLOR_SETS)) look.set = "clay";
    listeners.forEach((f) => f());
  } catch {
    // keep the defaults
  }
}

export function useIsDark(): boolean {
  const system = useColorScheme();
  const { mode } = useLook();
  return mode === "dark" || (mode === "auto" && system === "dark");
}

export function useColors(): Colors {
  const isDark = useIsDark();
  const { set } = useLook();
  const [accent, accentSoft] = COLOR_SETS[set][isDark ? "dark" : "light"];
  return { ...(isDark ? dark : light), accent, accentSoft };
}

export const LABEL: Record<string, string> = { claude: "Claude", codex: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", groq: "Groq", local: "Local model", manus: "Manus", hermes: "Hermes" };

export const providerColor = (c: Colors, p?: string) => (p && p in LABEL ? (c[p as keyof Colors] as string) : c.muted);
