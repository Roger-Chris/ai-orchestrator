# Linux work (30 Oct 2026)

What the session on the Linux hub (`roger-all-series`, 100.104.185.17) is doing, for the sessions on the Windows laptop (`roger`, 100.79.112.101). Branch: `main` (the owner merged `jarvis/next` and wants no separate working branches). See also `docs/HANDOFF.md`.

## State on Linux

- Pulled `jarvis/next` up to `3603cef` (Hermes Agent, handoff notes).
- The changes below are committed and pushed to `main`, and the Linux hub was restarted on them.

## Confirmed from Linux (31 Oct 2026)

- The laptop shows in `/api/nodes` as `roger`, online, with claude, codex, gemini, groq and local ready. The hub lists `local` as "runs on roger".
- A real prompt through the laptop's `/node/exec` was answered by `qwen3:8b` in 24 s (the first call, so it may include loading the model). A hub job has not yet gone end to end through the router onto the laptop.
- Linux's `builds.androidNode` is now `roger`. Android builds still need `builds.androidHere: true` in the laptop's config, which the owner edits.
- Still to try: a reboot of the laptop, to see both tasks come back at logon.

## WhatsApp link moves to Linux (31 Oct 2026): Windows, please read

The link now runs on Linux as its own service (`orchestrator-whatsapp`), so new messages reach the hub with the laptop off. It is a new linked device with its own QR scan: the laptop's sign-in is not copied. Live voice notes go to Groq's Whisper and live photos to Gemini (`whatsapp.media: online`); history's voice notes are not downloaded on Linux.

**Live since 31 Oct 2026, 17:58 IST: the owner scanned the QR and Linux is receiving messages, so do the steps below now.** A real text, voice note and photo arrived and a draft was written, on the first link in a terminal. The service then took over and connected; no new message has been checked through the service itself yet. History came with the link: the hub went from 4,848 messages (30 Oct backup) to 30,448. A photo's description took a minute or two (cause not found), against the link's 3-minute hold.

On the laptop:
1. `git pull` and restart the orchestrator.
2. Stop and disable the scheduled task `Orchestrator WhatsApp link`. Keep `data\whatsapp\auth` and all messages: nothing is deleted. The owner removes the old device on the phone (Linked devices).
3. Leave `whatsapp.hub` set. `orc style learn` now pulls the hub's new messages first (`orc style pull` does only that), then run `orc style graph` and `orc style push` as before. Learning, the graph and the GPU stay on the laptop.

The earlier request below still stands: push the book and graph now.

## WhatsApp style files: Windows, please send them

Linux has an older `data/style/stylebook.json` (29 Oct) and no people graph. The graph should be on the laptop in `C:\development\AI Assistant\Orchestrator\data\style\`: `graph\graphify-out\graph.json` and `graph.html`, and the full profiles in `graph\people.md`. Linux could not open that folder to confirm.

`orc style push` now also sends the graph (`PUT /api/style/graph`). On the next update, in the `Orchestrator` folder, with `whatsapp.hub` set to `http://100.104.185.17:4317`:

1. Update the code to this `main`.
2. Run `npm run orc -- style graph` if `graph.json` is missing or older than the style book.
3. Run `npm run orc -- style push`, and check that it prints "People graph sent".
4. Run it again after every `orc style learn` or `orc style graph`, and say so in `WINDOWS_WORK.md`.

What each thing does without the laptop:

- Works once the push is done: reply suggestions for WhatsApp notifications on the phone (`/api/whatsapp/suggest`), written on Linux from the style book and the messages it holds.
- Works since the link moved: new messages, voice notes and photos reach Linux and drafts are written with the laptop off.
- Waits for the laptop: `orc style learn` (the GPU work) and refreshing the book and graph.

## The goal

The owner's AI tools and agents keep working while they travel. Neither machine is "the" worker: each uses the other when it is available, from any network. Tailscale is the secure channel (`/node/*` also needs `ORC_TOKEN`). SSH is not part of the design.

## What changed

- `Cluster.borrowFor` (`src/cluster/cluster.ts`): when this machine can't run the `local` Ollama model, the model router (`src/ai/route.ts`) and tool registry (`src/ai/tools.ts`) use an online peer's copy through `/node/exec`. Only `local` is borrowable, never subscription tools. It stays a last resort unless picked in Settings -> AI hub.
- `Cluster.refresh`: a peer that left the tailnet is marked offline at the next poll (it used to stay "online" until a job failed).
- `deploy/windows/install.ps1`: opens port 4317 for Tailscale addresses (100.64.0.0/10) only; needs administrator, warns otherwise.
- `tests/borrow.test.ts` is new, and `CLAUDE.md` has a section on this.

Tests: 249 of 253 pass, typecheck clean. The 4 failures are in `tests/failover.test.ts`: `expo-secure-store` can't be found because `mobile/node_modules` is not installed on Linux. Everything was tested with simulated devices, never with the real laptop.

## What Linux needs from the laptop

Seen from Linux: Tailscale answers, but ports 22, 3389 and 4317 are closed (445 is open), so the orchestrator is not running there and the hub lists no peers.

1. Update the `orc-next` worktree: `git pull origin main`. Work on `main` from now on.
2. As administrator, from PowerShell:
   `powershell -ExecutionPolicy Bypass -File "C:\development\AI Assistant\worktrees\orc-next\deploy\windows\install.ps1" -Root "C:\development\AI Assistant\Orchestrator" -WhatsApp`
3. In the laptop's `orchestrator.config.yaml`: `node.acceptBranchWork: true` and `builds.androidHere: true`, then restart it.
4. Make sure Ollama is running with the model in `style.model` pulled.
5. Push any work that exists only on the laptop. Linux could not check for it. The main `Orchestrator` clone holds the owner's own edits: never stash, reset, checkout or clean it.

## Not built yet

- Nothing listed for now. Voice notes and photos work on Linux with `whatsapp.media: online`; waking the laptop is built (`cluster.wake`) but not yet tried on a sleeping laptop.
