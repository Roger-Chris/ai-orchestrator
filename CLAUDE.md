# AI Orchestrator: notes for Claude

A brain that routes work across the owner's Claude, ChatGPT (Go), Gemini (Google AI Pro via the Antigravity CLI `agy`) and optional Perplexity subscriptions, across devices on a Tailscale tailnet. See README.md for features and setup; this file is what a new session needs on top of that.

## Layout

- `src/`: the hub (Node 22.13+, TypeScript via tsx, Hono, node:sqlite). `src/brain/orchestrator.ts` is the core: planning, step graph, design mode, questions/checkpoints, branch work.
- `web/`: React + Vite web app (PWA), built to `web/dist` by `npm start`.
- `mobile/`: Expo (SDK 58) React Native Android app, installed from an APK, not the Play Store. It has its own `AGENTS.md`: read it before touching Expo APIs.
- `agents/`: specialist agent YAML files.
- `tests/`: vitest with fake providers. `npm test` must stay green (70 tests); `npm run typecheck` covers the hub and the web app; `cd mobile && npx tsc --noEmit` covers the app.

## Running the hub

```bash
npm install
npm run orc -- init        # creates orchestrator.config.yaml (host: tailscale) and .env with ORC_TOKEN
npm run orc -- doctor --live
npm start                  # builds the web app, serves on :4317 (loopback + this machine's Tailscale IP)
```

The permanent hub is a **Linux machine** (8 GB RAM, hard disk, no GPU) that also runs the AI_Assistant brain (`../AI_Assistant`, brain on 127.0.0.1:8000). There the hub is a systemd user service: `deploy/linux/install.sh` (safe to re-run; makes a small-machine config if none exists), `deploy/linux/update.sh`, and `journalctl --user -u orchestrator-hub -f`. The unit runs `tsx src/cli.ts serve` directly, not `npm start`: the web app is built by the installer, not on every boot. The Windows laptop is for development and is a worker. The Mac mini joins later as a coding device (`acceptBranchWork: true`).

Secrets that are not in git, on purpose:
- `gmail-client.json`: Google OAuth client for the Gmail reader (README: Gmail); the sign-in itself is in `data/gmail-token.json`.
- `.env`: `ORC_TOKEN` (every device and the phone app use the same one), optional `PERPLEXITY_API_KEY` and `GROQ_API_KEY`.
- `fcm-service-account.json`: Firebase private key (project `orchestrator-b6a5d`) so the hub can send phone notifications. On a new machine, generate a new one: Firebase console → Project settings → Service accounts → Generate new private key, saved in the repo root under that name. Delete old keys there.
- `data/`: run history, memory, push subscriptions. Copy it to keep history; otherwise it starts empty and the phone app must tap Settings → Notifications → Turn on again.

## Building the Android app (Windows)

Hard-won details:
- The C++ build breaks on long paths. Windows long paths must be on (`HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1`, admin) **and** CMake 3.31.6 must be used (its ninja 1.12 is long-path aware; the SDK default 3.22.1 is not). Build from a short folder too.
- Recipe (from the repo root, PowerShell):
  ```powershell
  robocopy mobile C:\orcm /E /XD "$PWD\mobile\android" "$PWD\mobile\.expo"   # exclude only the TOP-level android, never every folder named android
  cd C:\orcm; npm install; npx expo prebuild --platform android --clean
  Add-Content android\local.properties "sdk.dir=C\:/Users/<you>/AppData/Local/Android/Sdk"
  Add-Content android\local.properties "cmake.dir=C\:/Users/<you>/AppData/Local/Android/Sdk/cmake/3.31.6"
  $env:JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"; cd android; .\gradlew assembleRelease "-PreactNativeArchitectures=arm64-v8a"
  adb install -r app\build\outputs\apk\release\app-release.apk
  ```
  Install CMake 3.31.6 with `sdkmanager "cmake;3.31.6"`. `prebuild --clean` wipes `local.properties`, so re-add both lines after it.
  For a JS-only change (no new native packages), skip prebuild: mirror `mobile/src` into `C:\orcm\src` (`robocopy ... /MIR`) and rerun gradle.
- `mobile/metro.config.js` resolves the app's own `node_modules` first (the repo root has a different React for the web app) but keeps nested lookup on (expo-router keeps `@expo/metro-runtime` nested).
- On Xiaomi phones `adb install` needs Developer options → **Install via USB**.

## Home screen

- The app opens on tabs: Home, Chats, Insights, Devices (`mobile/src/app/(tabs)/`). Home reads `GET /api/home` (`src/server/home.ts`): today's tasks, open decisions, running work, "needs a look" and recent runs. Insights reads `GET /api/insights`.
- Today's tasks come from the `tasks` table via `POST /api/tasks` (`{title, time?, day?, source: gmail|whatsapp|manual, detail?, id?}`; re-sending the same `id` replaces it). The Gmail reader (`src/integrations/gmail.ts`) fills it; WhatsApp is not built yet.
- Gmail: the owner's own OAuth client (`gmail-client.json`, not in git) and a refresh token in `data/gmail-token.json` from `orc gmail connect` (works headless: paste the redirect address). The reader polls every `gmail.pollMinutes`, sends new mail in batches of 10 to the first ready of Claude/Gemini/ChatGPT for JSON tasks, and marks mail seen (`gmail_seen`) only after a batch parses, so failures retry.

## Groq and other OpenAI-compatible APIs

- `src/providers/openai-compat.ts` is a generic streaming `/chat/completions` provider; Groq is an instance of it (`providers.groq`, `GROQ_API_KEY` or `GROQ_API_KEYS` comma-separated: keys rotate, a 429 rests that key until its retry-after, a 401/403 rests it for an hour) and Perplexity extends it for citations. A new service needs a `ProviderId`, a config block, a registry line and a row in `src/brain/capabilities.ts` (every `Record<ProviderId, ...>` must list it: `AGENTIC`, `PROVIDER_NAME`, app labels).
- Groq is not agentic (no files, no web), so the router never gives it workspace or branch steps. It leads only `quick` (Gemini via `agy` was too slow there), classifies each task when `brain.classifier` is `model` (8 s timeout, keyword fallback; see `refineClassification`), and is tried first for Gmail.

## Phone notifications (FCM)

- The hub sends **notification** messages (with `android.notification.channel_id = "orchestrator"` and `data.url`). Data-only messages were accepted by Google but silently dropped on the owner's Xiaomi (HyperOS) phone; do not switch back.
- Xiaomi also needs **Autostart** for the app; the app opens that screen itself after Turn on (`mobile/src/lib/background.ts`).
- The phone connects at `http://<hub's Tailscale IP>:4317` with `ORC_TOKEN`. Requests through `tailscale serve` or any local proxy still need the token.

## Conventions

- Plain, specific comments; small modules; no new dependencies without a reason.
- Never commit `.env`, `fcm-service-account.json`, `gmail-client.json` or `data/`.
