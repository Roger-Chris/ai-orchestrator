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
- [x] V5 Wake word on the laptop (node agent, openWakeWord/Porcupine-free) and in-app "Hey Jarvis" while the app is open.

### Phase 1: model router + AI hub
- [x] R1 Tool registry: every provider with kind strengths, cost class (local/free/subscription/paid), limits, live state (ready/busy/cooling until), usage today.
- [x] R2 `routeFor(kind, size, override?)` with fallback chains; used by WhatsApp drafts, Gmail, calls, raw:auto for the brain.
- [x] R3 Ollama/local models as a provider (`local`), and spend caps per paid tool.
- [x] R4 `/api/ai-hub` (status, usage, caps, preferred tool per job kind) + app AI hub screen.

### Phase 2: build apps on command
- [x] B1 Brain tool `build` -> hub `/api/builds`: spec, repo/branch, device choice, coding agent (Claude Code / Codex), second-model review, tests.
- [x] B2 Previews: web preview URL, Android debug APK sent to the phone; approve merge/deploy from the phone.
- [x] B3 Builds recorded in shared memory; "continue the X app" resumes.
- [x] B4 App Builds screen.

### Phase 3: device control
- [x] D1 Desktop: open/focus/close apps, screenshot on request, computer-use model for GUI-only apps (ask level).
- [x] D2 File index of every device in shared memory; cross-device search; copy between devices (ask level).
- [x] D3 Android helper: accessibility + notification access; open apps, alarms, reminders, share files; calls/messages drafted only.
- [x] D4 Mac mini node. App Devices screen.

### Phase 4: outside paid agents
- [x] A1 Per-agent tokens, scopes (devices, folders, risk ceiling), MCP over HTTP.
- [x] A2 Audit log in shared memory, kill switch, app Agents screen.

### Phase 6: app
- [x] S2 The app builds its own APK: Android previews on the device with the Android SDK (`builds.androidNode` / `builds.androidHere`), apps found in subfolders (mobile/), a cross-platform `npm run build:apk`, Settings → Update this app (download + Android installer).
- [x] U1 Home: approvals from builds and agents; spoken notices toggle. (Other screens land with their phases.)

### Learning harness (owner asked 2026-10-30: "learn, adapt and grow from its context")
- [x] L1 Brain: episodes, 👍/👎 and corrections, "from now on…" teaching, lessons in the prompt (AI_Assistant learn.py, docs/LEARNING.md).
- [x] L2 Brain: nightly settle + reflection (lessons, regression cases from failures) + evaluation gate (trial lessons promoted or rolled back); safety never learnt.
- [x] L3 Hub + app: /api/brain/learn/* allow-listed; Good / Not right under every answer (Assistant and Talk); Settings -> Learning.

## Log
- 2026-10-30: roadmap written; V1 hub voice endpoint; V2-V3 mic in Assistant tab + hands-free Talk screen (needs a new APK: expo-speech-recognition is native).
- 2026-10-29 (scheduled run): V4 hub `POST /api/tts` + `GET /api/tts/audio` (OpenAI gpt-4o-mini-tts, Gemini Interactions TTS, Groq Orpheus split at 200 chars; failing services rest; cache) and Settings → Voice (auto / hub / phone, service, voice, phone voice, test). Phone TTS stays the fallback. Assumed Gemini model `gemini-3.8-flash-lite-tts` from the current docs; change `tts.gemini.model` if it is renamed. JS-only app change: rebuild the APK.
- 2026-10-29 (scheduled run): V5 `orc wake` on the laptop (tools/wakeword.py: openWakeWord `hey_jarvis` on the CPU, records until you pause, plays the hub's WAV answer; src/voice/wake.ts sends it to `/api/assistant/voice`, follow-ups without the wake word, computer's own voice as fallback; `wake.enabled` starts it with `orc serve`) and in-app "Hey Jarvis" while the app is open (Settings → Voice switch; continuous Android recognition, mic ownership so screens that listen keep it off). Read "Porcupine-free" as: no Picovoice key, so openWakeWord. Screen-off phone wake word not built (needs a native service). Could not test with a real mic from the cloud.
- 2026-10-29 (scheduled run): R1 tool registry `src/ai/tools.ts` + `GET /api/tools`: providers, Groq Whisper, TTS services and the configured Ollama models with cost class, strengths, limits, live state and usage today; `tools.overrides` for cost/daily cap/off; TTS and Whisper now record usage. Plan limits are notes, not live quota (no provider exposes it); `perDay` caps are the owner's to set.
- 2026-10-30 (scheduled run): R2 model router `src/ai/route.ts` (`routeFor`/`run`, job orders + `tools.routes`, skip cooling/capped/not set up, Groq last for long prompts, cheaper first for small TaskKind jobs) used by WhatsApp drafts, Gmail, call answers and `raw:auto`; `GET /api/tools/route`; brain `PLANNER_MODEL=auto` -> `raw:auto`. Calls now fall back to Groq last (before: Claude, ChatGPT, Gemini only). Hub + one brain line (AI_Assistant `jarvis/next`), no app change. The laptop was not connected, so this run's commits and the 29 Oct ones are kept as a bundle in the claude.ai project (`claude/unpushed/`).
- 2026-10-30 (scheduled run): R3 `local` provider (Ollama's OpenAI API, `providers.local`, defaults to `style.ollamaUrl`/`style.model`, last resort in the router, low capability scores) and spend caps (`tools.overrides.<id>.spendPerDay`/`costPerCall`, usage `cost_usd` column, `pool.capped` and `tts.capped` enforce `perDay` and spend caps everywhere). App: only the `local` label/colour (needs the APK rebuild that is already on the list).
- 2026-10-30 (scheduled run): R4 `GET /api/ai-hub` (tools, each job's chain now, today, caps, 7 days) + `PUT /api/ai-hub/prefer` (owner's first pick per job, `prefs` table, router honours it) and the app's Settings → AI hub screen. Typechecked, not seen on a phone (needs the APK).
- 2026-10-30 (owner asked for phases 2-4 now): B1-B4 builds: `src/builds` (BuildDesk over branch runs with tests and a second model's review, `builds` table), previews on the hub (`/p/<key>/` web, `/p/<key>/app.apk`), merge on the owner's tap, every build in shared memory (`project:<app>`, `work:build-<id>`) and "continue the X app" (here or from memory), brain tool `build`, app Settings → Builds. Deploy is not built (no target named); a preview is the check before Merge.
- 2026-10-30 (owner asked for phases 2-4 now): D1-D4 device control: desktop actions (`apps.focus`, `apps.close` ask, `screen.shot` ask, `gui.task` ask through a configured computer-use agent), the file index of every device on the hub (+ summary in shared memory), cross-device search and `files.send` (ask, never replaces), phone actions on the app's Phone screen (alarm, reminder, open app, file; calls/texts only opened, never dialled or sent), Devices tab with OS, files, Screenshot, Re-index; `deploy/mac/install.sh` for the Mac mini. D3's accessibility service and general notification access are NOT built (native code that has to be built and tested on the phone); gui.task needs a computer-use agent configured. Not tried on real desktops from the cloud.
- 2026-10-30 (owner asked for phases 2-4 now): A1-A2 outside agents: per-agent tokens (hashed, shown once), scopes (devices, folders, risk ceiling safe/ask, memory write), MCP over HTTP at `/mcp` (memory tools, devices, act within scopes; safe-only agents never create approvals), audit log in the hub and one shared-memory record per agent per day, kill switch and revoke, app Settings → Outside agents. Phases 2, 3 and 4 are done; Phase 6 (U1) is left.
- 2026-10-30 (end-to-end test, owner asked to test the app): brain + hub + a scripted stand-in model + the app's web build in a phone-sized browser. Every assistant flow worked (file search across devices, phone alarm/file, a write waiting for Approve, build, remember/recall, voice text); a real build with Claude Code made a working Todo app, preview served and merged from the app. Fixed what the test found: tests of a NEW project never ran (detected before the agent wrote package.json; now detected again after the edit), dependency folders kept out of branches (`.git/info/exclude` in the common git dir), steps that did not run (no second model for the review) shown on the build and in its notice, and Home's Approve/Deny were disabled inside a disabled Pressable row (web; fixed for every platform). The Android device itself was not reachable from the cloud session, so the APK was not installed or tried on the phone.
- 2026-10-30: pushed phases 2-4 (0fabb5a / 1a2005c) from the laptop and started the GitHub Actions Android build of jarvis/next. S2: the app builds its own APK (laptop Android builds over `/node/apk-build`, apps in subfolders, cross-platform build:apk, Settings → Update this app). U1: Home shows builds to try (preview / APK / review) and marks approvals asked by outside agents; Settings → Voice → Say notices aloud. Every roadmap step is now ticked.
- 2026-10-30 (laptop test run on Windows): the hub suite failed in 7 files though every test passed. 6 deleted their temp databases while still open (Linux allows it, Windows says EBUSY): `MemoryReplica.close()` added and the tests close every store and replica. `tests/wake.test.ts` could not load `mobile/src/lib/wakephrase.ts` without `mobile/node_modules` (Vite read mobile's tsconfig, which extends expo's): `vitest.config.ts` pins the hub's tsconfig; its uv path check expected `join` where the code (rightly) uses `resolve`. Now 228/228 on Windows (94acbc7).
- 2026-10-30 (laptop): `npm run build:apk` now finds the SDK without ANDROID_HOME (Android Studio's usual folder), writes `local.properties` after `prebuild --clean` with `sdk.dir` and the newest SDK CMake (3.31.6: 3.22.1's ninja breaks on long paths), and starts gradlew.bat by full path (cmd ignores the current folder when NoDefaultCurrentDirectoryInExePath is set, as for agents and services). Built in the worktree in 14 min and installed over the app on the phone. Brain: agent_eval names the exception when a case crashes (90e4076).
- 2026-10-30 (live eval, laptop -> Linux hub, codex): ChatGPT on the Go plan needs Codex CLI 0.166+ (gpt-5.5 was retired for ChatGPT sign-in; the new default gpt-6-luna works). First run 0/17: the brain sent its Gemini keys to the hub instead of ORC_TOKEN (401; fixed in the brain, 0479556). Then 8/17: `raw:` calls ran Codex as a full agent with the owner's MCP servers and shell, and it answered "that tool needs approval / isn't available" instead of the JSON step. Now `raw:` calls are plain (`--ignore-user-config --ephemeral`), the brain's prompt says its JSON tools are real, "remind me" is add_task, and `shell.run` says to put the folder in `cwd` (a `git -C … status` was not safe-listed). With a local stand-in for the new hub path: 16/17; risky_write still fails safe (Codex will not write from its read-only sandbox, so no approval is asked). The Linux hub and brain need this branch to get it.

## Owner to-do
- Self-updating app (S2): in the hub's (Linux) `orchestrator.config.yaml` set `builds: { androidNode: omen }` (the laptop's node name); on the laptop set `builds: { androidHere: true }` and make sure `ANDROID_HOME` and Java 17 are set for the orchestrator service (the same ones `npm run build:apk` uses), then restart both. The Linux hub's clone of ai-orchestrator must have the GitHub remote as `origin`; the laptop clones it from there.
- Rebuild and install the APK (`npm run build:apk` in mobile/ on the laptop, or the GitHub Actions build): V4 Settings → Voice, V5 "Hey Jarvis" and R4 Settings → AI hub are in the app (JS only, no new native packages since V2-V3's build).
- For the hub's voice: add `OPENAI_API_KEY` or `GEMINI_API_KEY` to the hub's `.env` and restart it, or accept the Orpheus model terms once in the Groq console (the Groq keys are reused). Without any, the phone's own voice speaks (as before).
- Try `npm run orc -- wake` on the laptop (needs uv, already used for `orc style learn`); if it wakes too rarely or too often, try `--threshold 0.4` / `0.6` and put the value under `wake:` in the config; `wake.enabled: true` to start it with `orc serve`.
- Optional: `PLANNER_MODEL=auto` (with `PLANNER_BASE_URL=hub`) in the brain's `.env` lets the hub's router pick ChatGPT / Claude / Gemini / Groq for the brain's thinking and fall back between them; `codex` keeps it on ChatGPT as now. Restart the brain after the change.
- Spend caps are off until you set them: e.g. in `orchestrator.config.yaml` `tools: { overrides: { perplexity: { spendPerDay: 0.5 }, "tts:openai": { costPerCall: 0.002, spendPerDay: 0.2 } } }`. A local model needs `ollama pull qwen3:8b` (or set `providers.local.model`) on a machine that has Ollama; `providers.local.enabled: false` turns it off.
- Mac mini: clone ai-orchestrator, then `HUB=http://100.104.185.17:4317 deploy/mac/install.sh`; copy `ORC_TOKEN` into its .env; allow Screen Recording (and Accessibility for apps.close) for node in System Settings; set `actions.roots`.
- Desktop GUI automation (`gui.task`): pick a computer-use agent you trust and set `actions.computerUse.command`/`args` (with `{goal}`); until then it says it is not set up.
- After the APK rebuild, Settings → Phone: the first alarm may ask which clock app to use.
- Outside agents: add one in Settings → Outside agents, then give the agent `<hub>/mcp` and its token as an HTTP MCP server. A cloud agent can reach `/mcp` only if you expose it (e.g. Tailscale Funnel); decide that yourself, and prefer "Safe only" plus a folder scope.
- 2026-10-30: L1-L3 learning harness (brain learn.py, app Learning screen and answer feedback).
