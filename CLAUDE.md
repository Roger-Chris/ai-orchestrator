# AI Orchestrator: notes for Claude

A brain that routes work across the owner's Claude, ChatGPT (Go), Gemini (Google AI Pro via the Antigravity CLI `agy`) and optional Perplexity subscriptions, across devices on a Tailscale tailnet. See README.md for features and setup; this file is what a new session needs on top of that.

## Layout

- `src/`: the hub (Node 22.13+, TypeScript via tsx, Hono, node:sqlite). `src/brain/orchestrator.ts` is the core: planning, step graph, design mode, questions/checkpoints, branch work.
- `web/`: React + Vite web app (PWA), built to `web/dist` by `npm start`.
- `mobile/`: Expo (SDK 58) React Native Android app, installed from an APK, not the Play Store. It has its own `AGENTS.md`: read it before touching Expo APIs.
- `agents/`: specialist agent YAML files.
- `tests/`: vitest with fake providers. `npm test` must stay green (96 tests); `npm run typecheck` covers the hub and the web app; `cd mobile && npx tsc --noEmit` covers the app.

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
- `.env`: `ORC_TOKEN` (every device and the phone app use the same one), optional `PERPLEXITY_API_KEY`, `GROQ_API_KEYS` and `BRAIN_TOKEN` (the AI_Assistant brain's token, on the hub that runs next to it).
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
- After testing the app against a local hub (`adb reverse tcp:<port>` and `http://127.0.0.1:<port>` in Settings → Change hub or token), set it back to `http://100.104.185.17:4317` and tap Settings → Notifications → Turn on again. Left on a test address, the app shows "fetch failed … 127.0.0.1", never sees replies or alerts, and gets no notifications (they are registered with whichever hub the app last used).
- Native packages added for calls: `expo-audio` (push-to-talk, config plugin adds RECORD_AUDIO) and `expo-speech` (the phone's own TTS). The first build after them needs `npx expo prebuild --platform android --clean` (not the JS-only shortcut). Install mobile deps with `npm install --legacy-peer-deps`: the lockfile's peer deps make plain `npm ci` fail.
- GitHub builds it too: `.github/workflows/android-release.yml` publishes a release `app-<run>` with the APK for every push to `main` that touches `mobile/` (or Actions → Android release → Run workflow). It signs with the Expo template's debug keystore, like local builds, so it installs over the phone's app. Latest APK to Downloads: `gh release download --repo Roger-Chris/ai-orchestrator --pattern "*.apk" -D ~/Downloads`.

## Home screen

- The app opens on tabs: Home, Chats, Insights, Devices (`mobile/src/app/(tabs)/`). Home reads `GET /api/home` (`src/server/home.ts`): today's tasks, open decisions, running work, "needs a look" and recent runs. Insights reads `GET /api/insights`.
- Today's tasks come from the `tasks` table via `POST /api/tasks` (`{title, time?, day?, source: gmail|whatsapp|manual, detail?, id?}`; re-sending the same `id` replaces it). The Gmail reader (`src/integrations/gmail.ts`) fills it; WhatsApp is not built yet.
- Today is normally filled from the AI_Assistant brain (`src/integrations/assistant.ts`, `assistant:` config, `BRAIN_TOKEN` in `.env`): every `pollMinutes` it copies the brain's tasks due today, overdue and finished-today as `brain:<id>` rows (`upsertTask`/`pruneTasks`), and `POST /api/tasks/brain:<id>/done` calls the brain's `/tasks/<id>/done` (or `/confirm` to reopen) first. The brain is localhost-only, so this runs on the Linux hub. Its `GET /tasks` includes `source` (email/whatsapp/manual) since AI_Assistant added it for this.
- Alerts from the brain: it decides what is worth interrupting you for and when (levels, quiet hours, snooze: AI_Assistant `brain/app/alerts.py`) and posts each to `POST /api/notify`; the hub pushes it (tag `alert:<id>`) and keeps the open ones in `AssistantTasks` (refreshed from the brain's `GET /alerts` on every sync; an older brain without it is skipped). Home's `alerts` show as "Needs you" in the app; Done / Snooze 1 h / Not important go through `POST /api/alerts/:id/ack` to the brain's `/alerts/<id>/ack`.
- Gmail: the owner's own OAuth client (`gmail-client.json`, not in git) and a refresh token in `data/gmail-token.json` from `orc gmail connect` (works headless: paste the redirect address). The reader polls every `gmail.pollMinutes`, sends new mail in batches of 10 to the first ready of Claude/Gemini/ChatGPT for JSON tasks, and marks mail seen (`gmail_seen`) only after a batch parses, so failures retry.

## Alarms and calls

- Brain alerts at level 3 (alarm) and 4 (call) go out on the app's `alarm` channel (`ALARM_CHANNEL` in `src/server/fcm.ts`, created by `ensureChannels` in `mobile/src/lib/push.ts`: max importance, alarm audio, long vibration, bypass DND, public on the lock screen) with `data.url = /#/call/<id>`; levels 1-2 are sent exactly as before (`alertPayload` in `src/server/push.ts`). Android fixes a channel's sound/vibration at creation: change the settings by renaming the channel id, never by editing it.
- No full-screen intent: an FCM *notification* message is drawn by the Firebase SDK when the app is in the background, and expo-notifications has no full-screen option; it would need data-only messages (dropped on the owner's Xiaomi) plus native code. The alarm is a heads-up notification that rings; tapping it opens `mobile/src/app/call/[id].tsx`.
- Calls (`src/calls/desk.ts`, `CallDesk`; `src/calls/groq.ts` for Whisper + JSON chat): `GET /api/calls/:alertId`, `POST .../answer` (opening line), `POST .../turn` (multipart `audio` field, or JSON `{text}` / `{audio: base64, mime}`), `POST .../end`. Actions are only done/snooze/dismiss (brain ack), draft_reply and delegate (read-only runs, only after the assistant proposed and you said yes) and none; anything else is refused. Call state is in memory per alert (2 h idle). No Groq key: voice gets 409 `{fallback: "text"}`, typed turns go to Claude/Gemini/ChatGPT.

## WhatsApp style and the context pool

- `orc whatsapp link` (`src/whatsapp/link.ts`): Baileys 7.0.0-rc14 (pinned) linked device, READ-ONLY (no send path, keep it that way). Full history arrives only at link time; messages go to `wa_messages`/`wa_chats` in `orchestrator.db`, voice notes to `data/whatsapp/voice/`. Most chats now come as hidden `@lid` ids with no name or phone mapping; names fill in from pushName as people message. Baileys 6.7 could not decrypt your own phone's sync messages once WhatsApp moved your account to a LID ("No matching sessions found", ~12 a minute, never recovered); 7.x keeps LID sessions and the `lid-mapping.update` / contact `lid`+`phoneNumber` mapping, and the failures went to zero with every one recovered by retry. A chat stays under whichever id (LID or phone) its history is stored as (`resolve` + `WaStore.hasChat`), because the style book is keyed by it. The link's status line counts undecryptable messages (direct / group / recovered) and prints each chat the first time it fails. A copy of the 6.7 sign-in is in `data/whatsapp/auth-backup-v6-*`.
- `orc style learn` runs on the laptop (RTX 5050): Whisper large-v3-turbo via `uv run tools/transcribe.py` (decodes audio itself: faster-whisper's decoder breaks on current PyAV), then Ollama `qwen3:8b` writes one card per chat plus your overall voice into `data/style/stylebook.json`. Keep `num_ctx` 8192 and `num_predict` capped: 12k pushed the model partly onto the CPU and an uncapped JSON answer looped forever. Unchanged chats reuse their card.
- Cards are grounded (`groundCard` in `src/whatsapp/pool.ts`): terms of address must be known ones (da, bro, sir…) or part of the name and used at least twice; qwen otherwise copies the prompt's examples or lists words like "okk".
- `buildPool`/`poolPrompt` (`orc style pool <name|number> [--ask "…"] [--draft]`) is what every reply is written from: your voice, this chat's card and stats, the examples closest to their message, look-alike characters' examples when the chat has few (or was never studied; never their terms of address), shared groups and the last 30 messages. The hub drafts from it (`src/whatsapp/drafter.ts`, below).

- Terms of address (`src/whatsapp/address.ts`): what you call each person (sir, ji, bro, machi, da, di, amma, madam…, ~150 spellings in `TERMS`, plus `style.addressTerms` in config) is counted from your own messages into `stats.address`, stated as a hard rule in the prompt for direct chats, and `fixAddress` swaps any other term in a draft for the main one. Family words (anna, akka, mama, appa…) and pa/ma are never rewritten: they are also ordinary words. Never borrowed from look-alike chats.
- Your spelling (`src/whatsapp/spelling.ts`): `stats.spelling` maps spellings you hardly ever use (<15%) to the one you mostly use (okk/ok, bcoz/because, ila/illa…), so variants you really mix both stay; `stats.words` and `stats.stock` (messages you send again and again) go into the prompt word for word, and `mimic` applies your spellings, lowercase start and missing full stops to every draft. The owner wants drafts that copy their shortcuts and mistakes, never tidier English.
- Options: the model answers JSON `{"options":[{label,text}]}` (agree / decline / in between when they ask or invite, else 2-4 natural replies); `replyOptions` cleans each, fixes the term of address and applies `mimic`. Drafts keep them in `wa_drafts.options`; the phone shows them as chips that fill the editable text.
- Replies (`src/whatsapp/drafter.ts`, `ReplyDrafter`): the laptop's `orc whatsapp link` forwards live messages to `whatsapp.hub` (`POST /api/whatsapp/messages`, queued and retried while the hub is down); `orc style push` sends the book (`PUT /api/style`) plus the last 60 messages per chat (`live: false`, never drafted). The hub waits `draftDelaySeconds` after their last message in a direct chat, drafts with the first ready of Claude/Gemini/ChatGPT/Groq, stores it in `wa_drafts`, notifies the phone and lists it as `replies` in `/api/home`. Your own message in that chat marks its drafts sent. The phone's "Send in WhatsApp" opens wa.me for phone-number chats and the share sheet for hidden-id chats; nothing is ever sent by the hub. Live voice notes are held by the link until the laptop's Whisper has transcribed them (`onVoice`), then forwarded with the text; a failed download or transcription forwards them as "[voice note]". `orc whatsapp link` counts libsignal's "Bad MAC" decrypt noise instead of printing it and survives Baileys' unawaited `428 Connection Closed` rejections (it reconnects by itself).

## Agents know the setup

- Every step (except coding on branches) and the final synthesis get a live briefing as system instructions, ahead of the agent's own (`src/brain/setup.ts`, `extras.setup` built in `cli.ts`): owner (`profile.name`/`about`, else `OWNER_NAME`), devices and their ready models (cluster + `tailscale status`, cached 60 s), today's tasks, runs waiting on the owner, connected services. Without it, questions like "which devices are online?" got generic how-tos. A failing briefing is skipped, never fatal.

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
