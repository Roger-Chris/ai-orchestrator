# Jarvis handoff (30 Oct 2026)

Where the work stands, so another session can pick it up. Both repos: branch `jarvis/next` only, never `main`.

| Repo | Laptop worktree | Head |
|---|---|---|
| ai-orchestrator (hub, app, web) | `C:\development\AI Assistant\worktrees\orc-next` | see `git log` (last code: Devices rework `aac1b66`; this file after it) |
| AI_Assistant (brain) | `C:\development\AI Assistant\worktrees\brain-next` | `3425d7a` |

The main clones (`Orchestrator`, `AI_Assistant`) stay on `main` with the owner's own edits: never stash, reset, checkout or clean them. Work in the worktrees.

Tests at the end: hub 245 passing (`npx vitest run`), hub, web and app typecheck clean; brain 154 passing, ruff clean.

## Done this session

### Tests and builds
- Hub tests pass on Windows (`94acbc7`): test databases closed before deletion (`MemoryReplica.close()`), `vitest.config.ts` pins the hub's tsconfig.
- `npm run build:apk` works without `ANDROID_HOME`, from long paths, and from agent shells (`74ac67d`).
- One builds-preview test times out now and then while an APK build loads the laptop; it passes on its own.

### Brain
- Thinking through the hub from another machine sends `ORC_TOKEN`, not the Gemini planner keys (`0479556`).
- Prompt says its JSON tools are real; "remind me" is `add_task`.
- The task list the model reads is grouped by date: overdue (with days ago), today, later, no date. Before, an old unconfirmed task ("Send all SH files", 18 Sep, from a notes-to-self voice note) was called "today's" (`3425d7a`).
- Spoken requests think with the fast classifier model (`AGENT_VOICE_MODEL=classifier`, planner as fallback) instead of a Codex session per step.
- `agent_eval` names the exception when a case crashes (`90e4076`).

### Hub
- `raw:` calls run Codex plain (`--ignore-user-config --ephemeral`) so it answers the brain's JSON steps instead of using its own MCP tools (`d91ea0a`).
- Backup hub (`36d39d8`, `c38576d`): the app moves to another device's orchestrator when the Linux hub stops answering and back when it answers; registers notifications with every hub. The WhatsApp link drafts on the laptop while Linux is down. `deploy/windows/install.ps1` starts the orchestrator (and, with `-WhatsApp`, the link) at logon and restarts them.
- People screen (`GET /api/style/people`): style-book cards, no message text.
- Work tab (`c4a8816`): people linked to their WhatsApp chat, tasks given through WhatsApp (the phone sends, never the hub), moved on by their replies (router job `work`, words as fallback), late ones flagged, chat sent and received. `src/work/desk.ts`, `/api/work/*`.
- Send in WhatsApp opens the chat (`eccf0d4`): the link reads Baileys' hidden-id → number files and sends them to the hub (`POST /api/whatsapp/phones`, `wa_chats.phone`). 774 of 855 hidden-id chats get a number; the rest open WhatsApp's chat picker.
- Manus AI provider (`7bf6349`): API v2 `task.create` + `task.listMessages`. Never picked by a router on its own (`ONLY_WHEN_ASKED`); every `ai.run` with Manus asks first (paid credits); a task waiting for confirmation comes back with its link and is never confirmed by the hub.

### App
- Footer with drawn icons: Home, Work, Assistant, Chats, Devices; Insights is a link on Home.
- Devices page: a card per device with Hub / Backup hub / In use, ready AI tools, file index age; tool chips with the reason on tap (`aac1b66`).
- Clearer error when the hub can't be reached (check Tailscale on the phone).
- Simulated power-cut tests of the app's failover: `tests/failover.test.ts`.
- Latest APK: `C:\development\AI Assistant\apk\orchestrator-2026-10-30-devices.apk` (built, **not installed**: the phone was unplugged). The phone has `orchestrator-2026-10-30-work2.apk`.

### Found and fixed outside the code
- Codex CLI 0.142 failed on every model: `gpt-5.5` was retired for ChatGPT sign-in. Updated to 0.166 (default `gpt-6-luna`, works on the Go plan) on the laptop; the owner did the same on Linux.
- Laptop Tailscale was blocked by Cloudflare WARP: WARP now excludes `100.64.0.0/10` and `controlplane.tailscale.com`.
- Phone Tailscale was stuck on "Starting…" (HyperOS stops it): opening the app fixed it once.

## Configured (where things are)

| What | Where | State |
|---|---|---|
| Linux hub | `http://100.104.185.17:4317`, `~/Desktop/ai-orchestrator`, systemd user service `orchestrator-hub`, linger on | `jarvis/next`, older than the newest commits |
| Brain | `~/Desktop/AI_Assistant`, services `assistant-brain`, `assistant-bridge` | `jarvis/next`, may be behind `3425d7a` |
| Codex CLI | laptop and Linux | 0.166, signed in with ChatGPT Go |
| Phone | Xiaomi `24094RAD4I`, app `dev.rogerchris.orchestrator` | hub `http://100.104.185.17:4317` |
| WhatsApp link | laptop only (`Orchestrator\data\whatsapp\auth`) | **stopped since 29 Oct**; starts with the laptop installer |
| Style book / people graph | laptop `data/style/` (80 people, 144-node graph); the hub has an older book | refresh with `orc style push` |
| Tailscale SSH to Linux | `ssh roger@100.104.185.17` | check mode: the owner approves each session in the browser; agents may read but not change the machine |

## Missed or not verified
- Laptop installer not run: the agent was not allowed to add scheduled tasks. Without it there is no backup hub and no live WhatsApp (no drafts, no Work updates).
- Linux hub and brain not on the newest commits: the hub needs them for hidden-id numbers, Manus and Devices; the brain for the date grouping and fast voice.
- Newest APK not installed.
- Work flow end to end (a real reply moving a task) not tried on the phone; covered by tests only.
- Manus not tried against the real service (no `MANUS_API_KEY`).
- Fast voice model not tried with live speech.
- Live evaluation through the hub: 14/17 before the plain-Codex fix reached Linux; 16/17 against a local stand-in. Re-run once Linux is updated: `python -m app.agent_eval --model codex --hub http://100.104.185.17:4317 --out eval.json` (needs `ORC_TOKEN` in the environment).
- `risky_write` eval case still fails safe: Codex will not attempt a write from its read-only sandbox, so no approval is asked.
- The brain's task extractor turns notes-to-self voice notes into tasks; they are instructions to the assistant.
- UI rework beyond the footer, Work and Devices (Home, Chats, Assistant) not started.
- BIOS "Restore AC Power Loss → Power On" on the Linux machine (ASUS B85M-G): owner to set.

## Owner to-do
1. Linux: `cd ~/Desktop/ai-orchestrator && deploy/linux/update.sh` and `cd ~/Desktop/AI_Assistant && deploy/linux/update.sh`.
2. Laptop (PowerShell): `powershell -ExecutionPolicy Bypass -File "C:\development\AI Assistant\worktrees\orc-next\deploy\windows\install.ps1" -Root "C:\development\AI Assistant\Orchestrator" -WhatsApp`.
3. Phone: `adb install -r "C:\development\AI Assistant\apk\orchestrator-2026-10-30-devices.apk"`, then Settings → Notifications → Turn on.
4. Phone: Tailscale app Autostart on, battery No restrictions, Always-on VPN.
5. Optional: `MANUS_API_KEY` in the hub's `.env`, then restart.
6. Still open from before: the voice API key, `builds.androidNode: omen` / `builds.androidHere: true`, `PLANNER_BASE_URL=hub` and `PLANNER_MODEL=auto` in the brain's `.env`.

## Planned (next)

### Hermes Agent (Nous Research)
Open-source, model-agnostic agent framework (MIT) that runs on a server and speaks MCP. Plan:
- Run it on the Linux hub as another agent next to Claude, Codex, Gemini and Manus.
- Connect it through the hub's MCP at `/mcp` as an outside agent with its own token and scopes (Settings → Outside agents): memory read, the devices it may touch, risk ceiling "safe" first.
- Or add it as a provider like Manus if it has a task API; same rules: only when asked, anything risky asks first.
- Check first: install size on the 8 GB machine, and which model it thinks with (local, or the hub's `raw:auto`).

### Phonon-2 (assumed: Fermion Research's on-device speech recognition, released 15 Oct 2026; the owner wrote "phonom 2", confirm)
- Use it for speech-to-text where Groq Whisper is used now: calls (`src/calls`), Talk, voice notes (`orc style learn` uses Whisper large-v3-turbo on the laptop).
- It runs locally, so voice keeps working without the Groq key or the internet.
- Check first: platforms, hardware needs, Tamil/Tanglish quality (described as English-focused), licence.

### Also planned
- Home, Chats and Assistant screens: the same rework as Devices (cards, bigger tap targets).
- Extractor: notes-to-self voice notes become requests to the assistant, not tasks.
- Work: a "remind them" draft for late tasks; a Work summary on Home.
- Make the eval's `risky_write` pass with Codex (describe a write as a request for approval, not a file write).

## Rules that still hold
- Safety model: safe / ask / never; nothing that sends, pays, deletes, publishes or enters passwords without the owner's tap. `learn.UNSAFE` keeps blocking lessons about approvals, passwords, deleting and payments.
- No Telegram. No WhatsApp sending: replies are drafts the owner sends.
- Never print or commit secrets (`.env`, tokens, `git.github-token`, `fcm-service-account.json`, `data/`).
- Anything to remove goes to `C:\development\AI Assistant\_to_delete\`.
- Commits as `Roger-Chris <rogerchris190306@gmail.com>`; log changes in `docs/ROADMAP.md`.
