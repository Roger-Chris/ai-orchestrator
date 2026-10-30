# AI Orchestrator: notes for Claude

A brain that routes work across the owner's Claude, ChatGPT (Go), Gemini (Google AI Pro via the Antigravity CLI `agy`) and optional Perplexity subscriptions, across devices on a Tailscale tailnet. See README.md for features and setup; this file is what a new session needs on top of that.

## Layout

- `src/`: the hub (Node 22.13+, TypeScript via tsx, Hono, node:sqlite). `src/brain/orchestrator.ts` is the core: planning, step graph, design mode, questions/checkpoints, branch work.
- `web/`: React + Vite web app (PWA), built to `web/dist` by `npm start`.
- `mobile/`: Expo (SDK 58) React Native Android app, installed from an APK, not the Play Store. It has its own `AGENTS.md`: read it before touching Expo APIs.
- `agents/`: specialist agent YAML files.
- `tests/`: vitest with fake providers. `npm test` must stay green (175 tests); `npm run typecheck` covers the hub and the web app; `cd mobile && npx tsc --noEmit` covers the app.

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

- Terms of address (`src/whatsapp/address.ts`): what you call each person (sir, ji, bro, machi, da, di, amma, madam…, ~150 spellings in `TERMS`, plus `style.addressTerms` in config) is counted from your own messages into `stats.address`, stated as a hard rule in the prompt for direct chats, and `fixAddress` swaps any other term in a draft for the main one. With several terms for one person (Varun: "ji" when asking a favour, "machi" when joking, "da" otherwise), `studyAddress` reads each of your messages for its moment (`momentOf`: sorry, thanks, ask, refuse, greet, bye, tease, excited, question, agree, inform; Tanglish cues) and stores per term `when` (your moment), `after` (what they had just said), `at` (first/last word/alone) and up to 3 real exchanges, plus `addressNone`; `addressRule` gives the model the per-moment table, and `fitAddress` swaps a draft's term per line only when the habit for that moment is clear (≥3 uses, ≥60%) and you never use the draft's term there. Books built before this get the study from the hub's messages and the book's examples. Family words (anna, akka, mama, appa…) and pa/ma are never rewritten: they are also ordinary words. Never borrowed from look-alike chats.
- Your spelling (`src/whatsapp/spelling.ts`): `stats.spelling` maps spellings you hardly ever use (<15%) to the one you mostly use (okk/ok, bcoz/because, ila/illa…), so variants you really mix both stay; `stats.words` and `stats.stock` (messages you send again and again) go into the prompt word for word, and `mimic` applies your spellings, lowercase start and missing full stops to every draft. The owner wants drafts that copy their shortcuts and mistakes, never tidier English.
- Options: the model answers JSON `{"options":[{label,text}]}` (agree / decline / in between when they ask or invite, else 2-4 natural replies); `replyOptions` cleans each, fixes the term of address and applies `mimic`. Drafts keep them in `wa_drafts.options`; the phone shows them as chips that fill the editable text.
- Photos (`describeImage`/`describeImages` in `src/whatsapp/local.ts`): live photos sent to you in direct chats are downloaded by the link (`whatsapp.images`, `wantsMedia`; never history ones), described by Ollama `style.visionModel` (gemma3:4b, ~1.5 s warm on the RTX 5050; the first call loads it) into `wa_messages.transcript`, and forwarded like voice notes; `spoken()` shows them as "[photo: …] caption". `untranscribed()` is audio-only so Whisper never gets a photo.
- Conversation state (`src/whatsapp/convo.ts`, rules, no model): their acknowledgement of your message ("ok", "seri", 👍, a sticker) = ended (no draft unless asked); a sign-off ("ok da gn") = winding down (options include a "Close"); your last word older than 12 h = died out. Home's `quiet` lists direct chats that died out in the last 3 days ("Went quiet": Follow up drafts a nudge, Let it go hides it until the chat's next message, `wa_quiet_let_go` keeps the last message's ts).
- People graph (`orc style graph`, `src/whatsapp/graph.ts`): writes `data/style/graph/graphify-out/graph.json` in Graphify's node-link format (you, every person and group, their terms of address, relationship types, shared groups; details per node from `describe`) and runs `graphify cluster-only` (spawned without a shell: the repo path has a space) for `graph.html`; Graphify's panel truncates text, so the full profiles are also in `data/style/graph/people.md`. Totals and frequency come from `WaStore.activity` (all stored messages), not the 400 a profile studies. The owner reviews this before profiles are trusted for new messages.
- Replies (`src/whatsapp/drafter.ts`, `ReplyDrafter`): the laptop's `orc whatsapp link` forwards live messages to `whatsapp.hub` (`POST /api/whatsapp/messages`, queued and retried while the hub is down); `orc style push` sends the book (`PUT /api/style`) plus the last 60 messages per chat (`live: false`, never drafted). The hub waits `draftDelaySeconds` after their last message in a direct chat, drafts with the first ready of Claude/Gemini/ChatGPT/Groq, stores it in `wa_drafts`, notifies the phone and lists it as `replies` in `/api/home`. Your own message in that chat marks its drafts sent. The phone's "Send in WhatsApp" opens wa.me for phone-number chats and the share sheet for hidden-id chats; nothing is ever sent by the hub. Live voice notes are held by the link until the laptop's Whisper has transcribed them (`onVoice`), then forwarded with the text; a failed download or transcription forwards them as "[voice note]". `orc whatsapp link` counts libsignal's "Bad MAC" decrypt noise instead of printing it and survives Baileys' unawaited `428 Connection Closed` rejections (it reconnects by itself).

## Replies know the person (shared memory) and treat first contacts carefully

- `src/whatsapp/knowledge.ts`: `personKnowledge(replica, {name, chatId, isGroup})` gives the reply prompt what the shared memory knows about them: who they are, facts/decisions/notes about them, relations, and open tasks/events with them (the brain mirrors tasks with the people's names in `tags`). The drafter gets it through `DrafterOptions.knowledge` (wired in `cli.ts` from the local replica) for both `draft()` and the phone's `suggest()`; a memory error never stops a reply.
- Matching is exact only: the chat id first (the brain's graph keeps it as a slugged alias, `919876543210-s-whatsapp-net`), then the name as `person:<slug>` / `org:<slug>` or an alias. A bare number never matches by name; no search fallback (a wrong person is worse than none). Tasks must name the person exactly in their tags.
- The prompt section says "from my own notes … background only, never quote it, never mention notes or memory".
- First contacts (`ContextPool.newContact`: no style card and I never wrote to them; `unknownNumber`: the name is just a number): `newContactRule` makes replies polite, neutral and short, no nicknames or terms of address, nothing personal, no promises to meet/pay/commit, one "Who is this?" option when unclear, and `{"options":[]}` for spam or sales. Groups never get these rules.

## Agents know the setup

- Every step (except coding on branches) and the final synthesis get a live briefing as system instructions, ahead of the agent's own (`src/brain/setup.ts`, `extras.setup` built in `cli.ts`): owner (`profile.name`/`about`, else `OWNER_NAME`), devices and their ready models (cluster + `tailscale status`, cached 60 s), today's tasks, runs waiting on the owner, connected services. Without it, questions like "which devices are online?" got generic how-tos. A failing briefing is skipped, never fatal.

## Groq and other OpenAI-compatible APIs

- `src/providers/openai-compat.ts` is a generic streaming `/chat/completions` provider; Groq is an instance of it (`providers.groq`, `GROQ_API_KEY` or `GROQ_API_KEYS` comma-separated: keys rotate, a 429 rests that key until its retry-after, a 401/403 rests it for an hour) and Perplexity extends it for citations. A new service needs a `ProviderId`, a config block, a registry line and a row in `src/brain/capabilities.ts` (every `Record<ProviderId, ...>` must list it: `AGENTIC`, `PROVIDER_NAME`, app labels).
- Groq is not agentic (no files, no web), so the router never gives it workspace or branch steps. It leads only `quick` (Gemini via `agy` was too slow there), classifies each task when `brain.classifier` is `model` (8 s timeout, keyword fallback; see `refineClassification`), and is tried first for Gmail.

## Phone notifications (FCM)

- The hub sends **notification** messages (with `android.notification.channel_id = "orchestrator"` and `data.url`). Data-only messages were accepted by Google but silently dropped on the owner's Xiaomi (HyperOS) phone; do not switch back.
- Xiaomi also needs **Autostart** for the app; the app opens that screen itself after Turn on (`mobile/src/lib/background.ts`).
- The phone connects at `http://<hub's Tailscale IP>:4317` with `ORC_TOKEN`. Requests through `tailscale serve` or any local proxy still need the token.

## Shared memory (every device)

- One memory pool for all devices (plan: `../AI_Assistant/docs/JARVIS.md`). The master copy is the brain's `memory_record` table; every device keeps a full replica in `data/shared-memory.db` (`src/shared/replica.ts`, `MemoryReplica`) so search is local and works offline.
- Sync (`sync()`, every `sharedMemory.pollSeconds`): push dirty rows to `<upstream>/batch`, then pull `<upstream>/changes?since=<last_seq>` in pages. Newer `updated_at` wins on both sides. When the brain refuses an older edit it returns its copy and the replica takes it; without that, a device that already pulled that record would keep its stale edit for ever (found by a real-brain run, covered by a test). Deletes are tombstones.
- Upstream (`src/shared/setup.ts`): on the machine with `BRAIN_TOKEN` it is the brain itself (`assistant.url/memory`); elsewhere `sharedMemory.hub` (or `MEMORY_HUB`) + `/node/memory`, which that hub passes to the brain (`src/server/shared-memory.ts`). The brain stays on 127.0.0.1.
- `/api/shared-memory/*` (status, sync, search, recent, about, record, remember, PUT/DELETE record) answers from the local replica.
- Every finished run becomes a `work` record (`Memory.remember`), so what any device did is searchable everywhere.
- `orc mcp` adds `memory_search`, `memory_about`, `memory_remember`, `memory_recent`. They go through the local `orc serve`; if it is not running they open the replica file directly (writes sync later). Register once per AI tool: `claude mcp add orchestrator -- npx tsx <repo>/src/cli.ts mcp`, and the same command in Codex, Gemini CLI and Antigravity's MCP settings.
- Records the brain mirrors from its graph and tasks (`source` graph/tasks) are owned by the brain: add knowledge about a person as a `fact` with `subject` = their uid instead of editing the person record.

## Device actions and approvals

- `src/actions/registry.ts`: what the assistant can do on a device (`system.info`, `files.list/find/read/write/copy/move`, `shell.run`, `apps.list/open`, `ai.run`, `memory.search`). Each call has a risk: safe runs, ask waits for the owner, never is refused. `actions.safe` / `actions.never` in config override per action; `actions.safeCommands` is the shell safe list (anything with `; | & > < $ \``, or not on the list, asks).
- The owner's rule: nothing old is lost before the new version is checked. So there is no delete action, `files.write` backs an existing file up as `<name>.bak-<time>` first, and copy/move refuse to replace anything. Keep it that way.
- Files only inside `actions.roots` (default: `node.workRoot`), links resolved first; secret-looking names (.env, keys, tokens, credentials, service accounts) are never read, listed or written. Every output goes through `redact()` (GitHub/OpenAI/Groq/Google/Slack tokens, `user:pass@` in URLs): a git remote with an embedded token was found on the owner's laptop.
- `ai.run` drives the subscriptions' CLIs through the provider pool: claude, codex (ChatGPT), gemini (Antigravity/agy), perplexity, groq. `write: true` (permission edit) asks.
- Flow (`src/actions/desk.ts`): `POST /api/act {node, action, args, reason}` on the hub → the device's `POST /node/act`. Safe: done. Ask: the device answers `needs_approval`, the hub stores an approval (`approvals` table, 30 min), pushes "Approve on <device>?" and lists it in `/api/home` `approvals` (the app's "Approve?" section). `POST /api/approvals/:id/approve` sends the call again with the approval id; the device claims it with the hub that holds it (`/node/approvals/:id/claim`: same action, same args hash, unused, unexpired; claiming uses it up). Approved actions are written to shared memory as `work`.
- Approve/Deny endpoints are for the owner's own apps; the thinking loop must never be given a tool that calls them.
- `SHELL_META` includes `( ) { } @`: PowerShell evaluates them inside arguments (`git status (Remove-Item x)`). `insideRoots` resolves links on the deepest existing folder, so `root/link/new/file` with a link out of the roots is refused (a test covers both). A write approval shows the start of the text, so the owner is not approving blind.
- `POST /api/assistant/ask {text}` on the brain's machine passes to the brain's thinking loop (`/agent/ask`): the app's Assistant tab.

## The brain in the app (no Telegram)

- Telegram was removed from the brain on 29 Oct 2026; the app is the only remote. `/api/brain/*` (`src/server/brain.ts`) passes an allow-list of brain paths with BRAIN_TOKEN: tasks (list, add, confirm/reject/done, patch), chats + mute, brief, llm/usage, graph, memory/stats. Anything else is 403; keep the list short.
- App screens: Assistant tab (`(tabs)/assistant.tsx`, conversation kept for the app session), `tasks.tsx` (Keep / Not a task / Done, add), `memory.tsx` (search, kinds, about, remember), `wa-chats.tsx` (mute switches), Settings → Assistant (brief now, model key usage). Brain errors come as `{detail}`; `api()` reads both.
- To look at the app in a browser: copy `mobile/` aside, swap `expo-secure-store` for localStorage and drop `useLastNotificationResponse` (both native-only), `npm install --no-save react-dom react-native-web`, `npx expo export --platform web`, and serve it on the same origin as the hub's `/api`. That is how the screens were checked before Telegram was removed.

## Tool registry (Jarvis phase 1)

- `src/ai/tools.ts` `ToolRegistry.list()` (`GET /api/tools`, `?fresh=1` re-detects logins): every AI the hub can use as `ToolInfo` {id, name, kind agent/chat/speech/transcribe/vision, cost local/free/subscription/paid, strengths (kinds scored >= 8.5 in the capability matrix), scores, limits {maxConcurrent, perDay, note}, state ready/busy/cooling/limit/off/not_set_up, until, load, usageToday}. Tool ids: the five providers, `whisper:groq`, `tts:openai|gemini|groq`, `ollama:<style.model>` and `ollama:<style.visionModel>` (Ollama `/api/tags`, cached 60 s).
- Cost classes and plan notes are in `PROVIDER_FACTS`/`TTS_FACTS`; config `tools.overrides.<id>` sets `cost`, `perDay` (state `limit` until the next UTC day once today's calls reach it), `note`, `enabled: false`.
- Usage today comes from the `usage` table (UTC day, every device that reported here). Providers were already recorded; TTS (`Tts` `onUse`) records `tts:<service>` and Groq Whisper (`GroqVoice` `onTranscribe`) records `whisper:groq`. `Store.recordUsage` takes any tool id.
- R4 will show it in the app.

## Model router (Jarvis phase 1, R2)

- `src/ai/route.ts` `ModelRouter.routeFor(kind, size, {override, strict})` -> `{chain, skipped, reason}` from the registry's live list. Kinds: the hub's jobs `whatsapp_draft`, `mail`, `call`, `brain` (orders in `DEFAULT_ROUTES`, the owner's earlier choices; config `tools.routes.<job>: [..]` replaces one, the other providers except Perplexity follow as last resorts), or any TaskKind (capability score order; `small` lets a cheaper tool lead when scores are within 1). Off / not set up / daily cap / cooling are skipped with a reason; busy goes after ready. `large` (>= 24k chars, `sizeOf`) moves Groq to the end (free-tier token limits).
- `run(kind, req, opts)` walks the chain with `pool.run` (read permission), records usage per try, returns `{provider, text, route, failed}`; `RouteError` (`rateLimited` when every try was a limit) when nothing answered.
- Used by: WhatsApp drafts (`ReplyDrafter` `router`), Gmail tasks (`GmailReader` `router`, per batch), a call's typed answers (`CallDesk.think`), and `/v1/chat/completions` model `raw:auto` (job `brain`; the answer's `model` says which session answered; nothing left: 429). A pinned `whatsapp.replyProvider` / `gmail.provider` stays strict (that one only), as before. The brain uses `raw:auto` with `PLANNER_BASE_URL=hub` `PLANNER_MODEL=auto`.
- `GET /api/tools/route?kind=&size=&override=` previews a chain without running anything (for R4's screen and for checking).
- Ollama models are listed by the registry but not routed yet: R3 makes `local` a provider.

## Talking to Jarvis (voice)

- `POST /api/assistant/voice` (`src/voice/talk.ts`): recognised words or a clip (Groq Whisper) + history -> the brain's thinking loop as `source: "voice"` -> `{heard, answer, say, steps, pending}`; `say` is a short plain line. The app's Assistant tab mic and the hands-free Talk screen (`mobile/src/app/talk.tsx`) use it; listening is on the phone (`expo-speech-recognition`, en-IN, `mobile/src/lib/listen.ts`).
- Jarvis's voice (`src/voice/tts.ts`, config `tts:`): `POST /api/tts {text, provider?, voice?}` and `GET /api/tts/audio?text=&provider=&voice=` return audio from the first service with a key, in `tts.order`: OpenAI (`OPENAI_API_KEY`, gpt-4o-mini-tts, mp3), Gemini (`GEMINI_API_KEY`, Interactions API `POST /v1beta/interactions`, audio base64 in the `model_output` step; raw PCM is wrapped as 24 kHz WAV), Groq Orpheus (the Groq keys; 200 characters per request, so `splitForLimit` + WAVs joined). A failing service rests (429: 1 min, 400/401/403/404: 1 h, else 30 s) and is skipped until then, the next is tried (all resting: 503 with no call); the last 24 lines are cached. `GET /api/tts` lists services, voices and the default, never keys. Every failure answers `{fallback: "phone"}`: the app then speaks with Android TTS.
- App side: everything speaks through `mobile/src/lib/voice.ts` `speak()`/`stopSpeaking()` (Assistant tab, Talk, alarm/call screen). It streams `/api/tts/audio` into an expo-audio player (headers carry the token), falls back to `expo-speech` on a player error or nothing loaded in 12 s, and a generation counter stops a line still being fetched when you interrupt. Settings → Voice (`components/VoiceSettings.tsx`) stores `{engine: auto|hub|phone, provider, voice, phoneVoice}` in SecureStore `orc.voice`.
- "Hey Jarvis" on a computer (`orc wake`, or `wake.enabled: true` to start it with `orc serve`; `src/voice/wake.ts`, `tools/wakeword.py`): openWakeWord's `hey_jarvis` model on the CPU (uv script, Python <3.12 because of tflite-runtime on Linux; first run downloads the models). The Python side owns the mic: wake -> chime -> records until ~0.9 s of quiet (`Endpointer`, loudness over a learnt noise floor; `--selftest` checks it with numpy only) -> `utterance.wav` in `%TEMP%/jarvis-wake` (always overwritten, nothing to delete). Node sends it to `wake.hub` (else `sharedMemory.hub`, `whatsapp.hub`, this machine) `/api/assistant/voice` with the last turns, then asks `/api/tts` for WAV (`format: "wav"`) and tells Python to play it (the mic is ignored while playing), else the computer's own voice (`systemSay`: Windows System.Speech, macOS `say`, Linux `espeak`, text on stdin only). Up to `wake.followUps` follow-ups without the wake word; "bye" or silence goes back to waiting; a conversation older than 5 min starts fresh. JSON-lines protocol is in the script's docstring; "played"/"error" bypass the event queue (an answer waits for them).
- "Hey Jarvis" in the app (Settings → Voice switch, `mobile/src/lib/wake.ts` mounted in the root layout): Android's recogniser in continuous mode while the app is in the foreground, restarted when it ends; `matchWake` (`mobile/src/lib/wakephrase.ts`, tested by the hub's vitest) spots the phrase (and mishearings like "jervis") and opens Talk with the rest of the sentence as `?say=`. One recogniser for the whole app: `mobile/src/lib/mic.ts` tracks the owner (listen / wake); every `useListen` screen and the call screen hold the mic while focused, so the wake listener is off there and never hears Jarvis speak. Not built: a screen-off/background wake word (needs a native always-on service).

## Conventions

- Plain, specific comments; small modules; no new dependencies without a reason.
- Never commit `.env`, `fcm-service-account.json`, `gmail-client.json` or `data/`.
