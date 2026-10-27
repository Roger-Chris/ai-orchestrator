import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `npm run dev:web` serves the app with hot reload and forwards API calls to the running orchestrator.
const api = "http://127.0.0.1:4317";

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": api, "/v1": api, "/node": api } },
});
