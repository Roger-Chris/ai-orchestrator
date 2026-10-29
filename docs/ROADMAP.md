# Jarvis roadmap: build state

The owner asked (2026-10-30) to build every phase of the plan one after another, automatically, and
to carry on in the next session when one ends. This file is the hand-over: a new session reads it,
takes the first unchecked step, builds it, ticks it, and pushes. Plan doc:
https://claude.ai/artifact/Bj5HX1Wj7PhCpQD67X5T2T

## Rules for every session (from the owner, still in force)

- Work on branches `jarvis/next` in both repos (Roger-Chris/ai-orchestrator, Roger-Chris/AI_Assistant). Never merge to main unless the owner says so.
- Never delete the owner's files; never ask for delete permission again (refused once). Move to `_to_delete/` instead.
- No Telegram or other chat transport. No WhatsApp send path: replies are drafted, the owner sends.
- Never print or paste tokens; don't read `.env` files or secrets.
- Device actions keep safe / ask / never. Nothing that sends, pays, deletes, publishes or enters passwords runs without the owner's tap.
- Tests and typecheck green before each push (`npx vitest run`, `npx tsc --noEmit -p .`, `cd mobile && npx tsc --noEmit`; brain: `.venv/bin/python -m pytest -q`, `.venv/bin/ruff check app tests`).
- Commits: author Roger-Chris <rogerchris190306@gmail.com>, Claude trailers.
- Push: bundle to the laptop (`C:\development\AI Assistant\_claude_tmp\`), fetch into the laptop repos, push with the laptop's token (see CLAUDE.md of the session notes); or `git ls-remote` to check it landed.
- Mobile changes need a new APK (`npm run build:apk` on the laptop); say so in the summary.
- Tick a step here (`- [x]`) in the same commit that finishes it, and add one line under "Log".

## Steps

### Voice (owner asked first, 2026-10-30)
- [x] V1 Hub `POST /api/assistant/voice`: text or a voice clip (+ history) -> transcribe (Groq Whisper) -> brain thinking loop -> `{heard, answer, say, steps, pending}`; `say` is a short spoken version.
- [x] V2 App: mic in the Assistant tab (on-device speech recognition, `expo-speech-recognition` 58.0.0; falls back to sending the clip), spoken answers, approvals still a tap.
- [x] V3 App: "Talk to Jarvis" call screen any time (not tied to an alert), push-to-talk and hands-free (auto end of speech), barge-in stops speaking.
- [x] V4 Better voice: hub `POST /api/tts` (OpenAI / Gemini TTS when configured) with phone TTS as the fallback; voice choice in Settings.
- [ ] V5 Wake word on the laptop (node agent, openWakeWord/Porcupine-free) and in-app "Hey Jarvis" while the app is open.

### Phase 1: model router + AI hub
- [ ] R1 Tool registry: every provider with kind strengths, cost class (local/free/subscription/paid), limits, live state (ready/busy/cooling until), usage today.
- [ ] R2 `routeFor(kind, size, override?)` with fallback chains; used by WhatsApp drafts, Gmail, calls, raw:auto for the brain.
- [ ] R3 Ollama/local models as a provider (`local`), and spend caps per paid tool.
- [ ] R4 `/api/ai-hub` (status, usage, caps, preferred tool per job kind) + app AI hub screen.

### Phase 2: build apps on command
- [ ] B1 Brain tool `build` -> hub `/api/builds`: spec, repo/branch, device choice, coding agent (Claude Code / Codex), second-model review, tests.
- [ ] B2 Previews: web preview URL, Android debug APK sent to the phone; approve merge/deploy from the phone.
- [ ] B3 Builds recorded in shared memory; "continue the X app" resumes.
- [ ] B4 App Builds screen.

### Phase 3: device control
- [ ] D1 Desktop: open/focus/close apps, screenshot on request, computer-use model for GUI-only apps (ask level).
- [ ] D2 File index of every device in shared memory; cross-device search; copy between devices (ask level).
- [ ] D3 Android helper: accessibility + notification access; open apps, alarms, reminders, share files; calls/messages drafted only.
- [ ] D4 Mac mini node. App Devices screen.

### Phase 4: outside paid agents
- [ ] A1 Per-agent tokens, scopes (devices, folders, risk ceiling), MCP over HTTP.
- [ ] A2 Audit log in shared memory, kill switch, app Agents screen.

### Phase 6: app
- [ ] U1 Home: approvals from builds and agents; spoken notices toggle. (Other screens land with their phases.)

## Log
- 2026-10-30: roadmap written; V1 hub voice endpoint; V2-V3 mic in Assistant tab + hands-free Talk screen (needs a new APK: expo-speech-recognition is native).
- 2026-10-29 (scheduled run): V4 hub `POST /api/tts` + `GET /api/tts/audio` (OpenAI gpt-4o-mini-tts, Gemini Interactions TTS, Groq Orpheus split at 200 chars; failing services rest; cache) and Settings → Voice (auto / hub / phone, service, voice, phone voice, test). Phone TTS stays the fallback. Assumed Gemini model `gemini-3.8-flash-lite-tts` from the current docs; change `tts.gemini.model` if it is renamed. JS-only app change: rebuild the APK.
