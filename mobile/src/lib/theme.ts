import { useColorScheme } from "react-native";

const light = {
  bg: "#f6f7f9",
  surface: "#ffffff",
  surface2: "#f0f2f5",
  border: "#dfe3e8",
  text: "#16191d",
  muted: "#646d78",
  accent: "#4f46e5",
  accentSoft: "#eef0ff",
  accentInk: "#ffffff",
  ok: "#15803d",
  warn: "#b45309",
  warnSoft: "#fff7e6",
  err: "#b91c1c",
  claude: "#c2410c",
  codex: "#047857",
  gemini: "#1d4ed8",
  perplexity: "#0e7490",
  groq: "#be185d",
  local: "#4d7c0f",
};

const dark: typeof light = {
  bg: "#0f1115",
  surface: "#171a20",
  surface2: "#1f232b",
  border: "#2b313b",
  text: "#e7eaee",
  muted: "#8f99a6",
  accent: "#818cf8",
  accentSoft: "#23264a",
  accentInk: "#0f1115",
  ok: "#4ade80",
  warn: "#fbbf24",
  warnSoft: "#2d2410",
  err: "#f87171",
  claude: "#fb923c",
  codex: "#34d399",
  gemini: "#93c5fd",
  perplexity: "#67e8f9",
  groq: "#f9a8d4",
  local: "#bef264",
};

export type Colors = typeof light;

export function useColors(): Colors {
  return useColorScheme() === "dark" ? dark : light;
}

export const LABEL: Record<string, string> = { claude: "Claude", codex: "ChatGPT", gemini: "Gemini", perplexity: "Perplexity", groq: "Groq", local: "Local model" };

export const providerColor = (c: Colors, p?: string) => (p && p in LABEL ? (c[p as keyof Colors] as string) : c.muted);
