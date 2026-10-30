# Windows work

What the Windows laptop does, so the other systems (Linux hub, Mac mini, phone, and any agent on them) know what happens here and what not to duplicate. Last updated 30 Oct 2026. For what is finished and what is next, see `docs/HANDOFF.md`.

## Its role

Development machine and worker, plus the backup hub once its installer has been run. It is not the permanent hub: that is the Linux machine at `http://100.104.185.17:4317`. The laptop sleeps and travels, so nothing permanent should depend on it. Its node name in config is `omen`.

## What only this laptop does

| Work | How | Why here |
|---|---|---|
| Writes and tests code for both repos | Claude Code in the worktrees below | Development machine |
| Builds the Android APK | `npm run build:apk` in `mobile/`; APKs land in `C:\development\AI Assistant\apk\` | Has the Android SDK; Linux does not |
| WhatsApp link (read-only) | `orc whatsapp link`; forwards live messages to the hub | The sign-in is only here, in `Orchestrator\data\whatsapp\auth` |
| Voice note transcription | Whisper large-v3-turbo through `uv` | RTX 5050 GPU |
| WhatsApp style book and people graph | `orc style learn`, `orc style graph`, sent to the hub with `orc style push` | Local Ollama models on the GPU (`qwen3:8b`, vision `gemma3:4b`) |
| Installs the app on the phone | `adb install -r <apk>` over USB | The phone plugs in here |

## Where things are

| What | Path |
|---|---|
| Hub, app and web work | `C:\development\AI Assistant\worktrees\orc-next` (branch `jarvis/next`) |
| Brain work | `C:\development\AI Assistant\worktrees\brain-next` (branch `jarvis/next`) |
| Main clones | `C:\development\AI Assistant\Orchestrator` and `AI_Assistant` (stay on `main`, holding the owner's own edits) |

## Running right now

| What | State |
|---|---|
| Orchestrator on the laptop | **Not running**, so there is no backup hub |
| WhatsApp link | **Stopped since 29 Oct**, so no live drafts or Work updates |
| Scheduled tasks | **Not installed**; `deploy/windows/install.ps1 -WhatsApp` adds them, and the owner runs it |
| Docker | Installed, engine not running; nothing here needs it yet |
| Codex CLI | 0.166, signed in with ChatGPT Go |
| Cloudflare WARP | Excludes `100.64.0.0/10` and `controlplane.tailscale.com`; without this it blocks Tailscale |

## What it does not do

- It does not host Hermes Agent. That belongs on the Linux hub (`deploy/linux/hermes.sh`), which stays on.
- It does not change the Linux machine. Agents may read over Tailscale SSH, with the owner approving each session; the owner runs the updates there.
- It does not send WhatsApp messages. No machine does: replies are drafts the owner sends.
- It does not merge to `main` unless the owner says so.

## Rules for working here

- Work in the worktrees. Never stash, reset, check out or clean the main clones.
- Never delete the owner's files: move them to `C:\development\AI Assistant\_to_delete\`.
- Never print or commit secrets (`.env`, tokens, `fcm-service-account.json`, `gmail-client.json`, `data/`).
- Tests and typechecks must be green before each push, and changes are logged in `docs/ROADMAP.md`.
- Android builds need CMake 3.31.6 and Windows long paths on; `build:apk` sets up the CMake version.

## Asking this laptop for work from another system

Commit to `jarvis/next` and note the request in `docs/HANDOFF.md`, or use the hub's device actions when the laptop is online. Expect it to be offline at times: check `/api/nodes` first, and retry rather than treat that as a failure.
