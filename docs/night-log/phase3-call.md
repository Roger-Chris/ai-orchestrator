# Phase 3: alarm screen and voice call (night log)

Branch `night/phase3-call`, cut from `origin/main` (ade0737). Not merged.

## Built

Hub
- `src/server/fcm.ts`: `Fcm.send` takes an optional `channel`. On `alarm` it also sets `notification_priority: PRIORITY_MAX` and `visibility: PUBLIC`. Without a channel the payload is byte-for-byte what it was before.
- `src/server/push.ts`: `alertPayload(alert)`. Levels 1-2: url `/`, default channel, same as before. Level 3: `alarm` channel, url `/#/call/<id>`. Level 4: same, with the title prefixed "Call: ". `/api/notify` uses it.
- `src/calls/groq.ts`: `GroqVoice`, which does Whisper `/audio/transcriptions` (`providers.groq.transcribeModel`, default `whisper-large-v3-turbo`) and JSON-mode `/chat/completions` (`providers.groq.model`). It uses the same GROQ_API_KEY(S) and moves to the next key after a 401, 403 or 429. Its `fetch` can be swapped out for tests.
- `src/calls/desk.ts`: `CallDesk` keeps per-alert call state in memory (forgotten after 2 h idle), the opening line, and turns.
  - Allowed actions: done, snooze, dismiss (sent to `AssistantTasks.ack`, which ends the call), draft_reply and delegate (each starts an orchestrator run with `permission: "read"`), and none.
  - Any other action is refused (`refused` field, nothing done).
  - draft_reply and delegate only run when that same action was proposed on an earlier turn and the owner's words agree (yes / do it / go ahead…, with no "no / wait / don't"). A short plain "yes" carries out the pending proposal even if the model returns none.
  - The system prompt includes the live setup briefing (`describeSetup`), the alert, the brain task if it is on today's list, and the last 12 lines of the call.
- `src/server/app.ts` routes:
  - `GET /api/calls/:alertId` returns `{alert, voice, available, lines, ended}`.
  - `POST /api/calls/:alertId/answer` returns `{say}`.
  - `POST /api/calls/:alertId/turn` takes multipart (`audio` file, max 10 MB), JSON `{text}`, or `{audio: base64, mime}`. It returns `{transcript, say, action, done, runId?, refused?, proposed?}`.
  - `POST /api/calls/:alertId/end`.
  - An alert that isn't open gives 404. No brain gives 409.
- No Groq key: audio gets 409 `{error, fallback: "text"}`. Typed turns go to the first ready of Claude, Gemini or ChatGPT (`think` in `cli.ts`). If no model is ready at all, typed turns also get 409.

App
- `mobile/src/lib/push.ts`: `ensureChannels()` creates the `alarm` channel (MAX importance, alarm audio usage, long vibration pattern, bypassDnd, lock-screen PUBLIC). It runs on app start and on Turn on. `routeFor` maps `/#/call/<id>` to `/call/<id>`.
- `mobile/src/app/call/[id].tsx`, which works by level:
  - Level 4: ringing screen (vibrates) with Answer / Decline.
  - Level 3: alarm screen with Done / Snooze 1 h / Not important / Talk it through.
  - After Answer, the phone speaks the opening (expo-speech). Hold the button to record (expo-audio, mono 16 kHz AAC) and release to send. The transcript and reply show as bubbles and the reply is spoken.
  - Done / Snooze / End call stay visible the whole time.
  - Without a Groq key (or if the mic is denied) a text box replaces the mic.
- Home: a "Call me" link on each alert row (not on briefs), which opens `/call/<id>?talk=1` (skips ringing).
- `mobile/app.config.ts`: the `expo-audio` plugin (RECORD_AUDIO, background recording and playback off).

## New native packages (prebuild needed)
- `expo-audio ~58.0.10` and `expo-speech ~58.0.3` (versions from expo's bundledNativeModules.json).
- The next APK needs `npx expo prebuild --platform android --clean`. The JS-only shortcut is not enough. Re-add both `local.properties` lines afterwards.
- `npm ci` in `mobile/` fails on the existing lockfile (peer-deps drift, this was already so on main). Use `npm install --legacy-peer-deps`.

## Full-screen intent: not built
- expo-notifications 58.1.6 has no full-screen-intent option. I checked the installed JS types and Android sources: no `fullScreenIntent` or `USE_FULL_SCREEN_INTENT` anywhere.
- The hub sends FCM notification messages, which the Firebase SDK draws itself while the app is in the background, so app code never gets a chance to attach a full-screen intent.
- What a full-screen alarm would take:
  1. Data-only FCM for levels 3-4. These were dropped on the owner's Xiaomi, so that needs re-testing with high priority and Autostart on.
  2. A small native module or config plugin that builds the notification with `setFullScreenIntent` and declares `USE_FULL_SCREEN_INTENT`.
  3. `showWhenLocked` / `turnScreenOn` on the activity, only while the call screen is open.
  4. On Android 14+, the owner must grant "Full screen notifications" (Settings → Apps → Special app access), because the Play-store auto-grant doesn't apply to sideloaded non-dialer apps.
- I couldn't fetch the Expo web docs tonight (the session limit hit WebFetch), so the above is from the installed package sources.
- What exists now: a max-importance heads-up notification that rings, is visible on the lock screen, and opens the call screen when tapped.

## Untested (needs a device)
- Everything on the phone: channel sound and vibration, bypass DND on HyperOS, tap routing to `/call/<id>`, recording, the upload format from React Native `FormData {uri,name,type}`, TTS voice and language, and how the hold-to-talk button behaves.
- Real Groq Whisper and JSON mode against `openai/gpt-oss-120b`. The tests only use fake HTTP.
- Whether HyperOS allows bypassDnd for a sideloaded app.

## Owner to do
- Put `GROQ_API_KEY` (or `GROQ_API_KEYS`) in the hub's `.env` for voice. Without it, calls are typed only.
- After installing the new APK: allow the microphone on first call; keep Autostart on. If the alarm channel ever needs different settings, it must get a new id (Android keeps the first settings).
- Phones that already have the app: the alarm channel is created on the next app start.
- Optional: Settings → Notifications → "Alarms and calls" → allow "Override Do Not Disturb" if HyperOS didn't grant it.

## Tests
- `tests/calls.test.ts` (6 tests): channel by level (payload, FCM body, `/api/notify`); voice turn → done forwarded to the brain (multipart, Whisper model, JSON mode, briefing in the prompt); refusal of `send_message`; draft/delegate only after proposal + yes (and "no" does nothing; runs carry the no-send instruction); no-key path (voice 409 + text fallback via another model; 409 with no model); agreement and JSON parsing.
