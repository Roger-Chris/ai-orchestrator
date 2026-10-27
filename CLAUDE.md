# AI Orchestrator: notes for Claude

A brain that routes work across the owner's Claude, ChatGPT (Go), Gemini (Google AI Pro via the Antigravity CLI `agy`) and optional Perplexity subscriptions, across devices on a Tailscale tailnet. See README.md for features and setup; this file is what a new session needs on top of that.

## Layout

- `src/`: the hub (Node 22.13+, TypeScript via tsx, Hono, node:sqlite). `src/brain/orchestrator.ts` is the core: planning, step graph, design mode, questions/checkpoints, branch work.
- `web/`: React + Vite web app (PWA), built to `web/dist` by `npm start`.
- `mobile/`: Expo (SDK 58) React Native Android app, installed from an APK, not the Play Store. It has its own `AGENTS.md`: read it before touching Expo APIs.
- `agents/`: specialist agent YAML files.
- `tests/`: vitest with fake providers. `npm test` must stay green (60 tests); `npm run typecheck` covers the hub and the web app; `cd mobile && npx tsc --noEmit` covers the app.

## Running the hub

```bash
npm install
npm run orc -- init        # creates orchestrator.config.yaml (host: tailscale) and .env with ORC_TOKEN
npm run orc -- doctor --live
npm start                  # builds the web app, serves on :4317 (loopback + this machine's Tailscale IP)
```

Secrets that are not in git, on purpose:
- `.env`: `ORC_TOKEN` (every device and the phone app use the same one) and optional `PERPLEXITY_API_KEY`.
- `fcm-service-account.json`: Firebase private key (project `orchestrator-b6a5d`) so the hub can send phone notifications. On a new machine, generate a new one: Firebase console → Project settings → Service accounts → Generate new private key, saved in the repo root under that name. Delete old keys there.
- `data/`: run history, memory, push subscriptions. Copy it to keep history; otherwise it starts empty and the phone app must tap Settings → Notifications → Turn on again.

## Building the Android app (Windows)

Hard-won details:
- The C++ build breaks on long paths. Windows long paths must be on (`HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1`, admin) **and** CMake 3.31.6 must be used (its ninja 1.12 is long-path aware; the SDK default 3.22.1 is not). Build from a short folder too.
- Recipe (from the repo root, PowerShell):
  ```powershell
  robocopy mobile C:\orcm /E /XD "$PWD\mobile\android" "$PWD\mobile\.expo"   # exclude only the TOP-level android, never every folder named android
  cd C:\orcm; npm install; npx expo prebuild --platform android --clean
  Add-Content android\local.properties "cmake.dir=C\:/Users/<you>/AppData/Local/Android/Sdk/cmake/3.31.6"
  $env:JAVA_HOME="C:\Program Files\Android\Android Studio\jbr"; cd android; .\gradlew assembleRelease "-PreactNativeArchitectures=arm64-v8a"
  adb install -r app\build\outputs\apk\release\app-release.apk
  ```
  Install CMake 3.31.6 with `sdkmanager "cmake;3.31.6"`. `prebuild --clean` wipes `local.properties`, so re-add `cmake.dir` after it.
- `mobile/metro.config.js` resolves the app's own `node_modules` first (the repo root has a different React for the web app) but keeps nested lookup on (expo-router keeps `@expo/metro-runtime` nested).
- On Xiaomi phones `adb install` needs Developer options → **Install via USB**.

## Phone notifications (FCM)

- The hub sends **notification** messages (with `android.notification.channel_id = "orchestrator"` and `data.url`). Data-only messages were accepted by Google but silently dropped on the owner's Xiaomi (HyperOS) phone; do not switch back.
- Xiaomi also needs **Autostart** for the app; the app opens that screen itself after Turn on (`mobile/src/lib/background.ts`).
- The phone connects at `http://<hub's Tailscale IP>:4317` with `ORC_TOKEN`. Requests through `tailscale serve` or any local proxy still need the token.

## Conventions

- Plain, specific comments; small modules; no new dependencies without a reason.
- Never commit `.env`, `fcm-service-account.json` or `data/`.
