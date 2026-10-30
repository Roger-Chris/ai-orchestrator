# Windows work (30 Oct 2026)

What the session on the Windows laptop (`Roger`, 100.79.112.101) does, for the sessions on the Linux hub (`roger-all-series`, 100.104.185.17), the Mac mini and any other agent. Counterpart of `LINUX_WORK.md`. See also `docs/HANDOFF.md`.

## Branch: `main` only

The owner decided on 30 Oct 2026 to stop using separate working branches. `jarvis/next` is merged into `main` in both repos, and all work now goes on `main`. Every machine should switch:

`git fetch origin && git checkout main && git pull --ff-only`

Linux: the hub repo is already on `main`. Do the same in `~/Desktop/AI_Assistant` before its next `deploy/linux/update.sh`, because that script pulls whichever branch is checked out. `jarvis/next` still exists on GitHub in both repos but gets no new work.

## State on Windows

- Merged up to Linux's `5817143`. Its `f75223e` passes the test suite here but has not been run against real devices.
- No work exists only on the laptop: no unpushed commits in either repo apart from this file, and the main clones and the other worktrees have no uncommitted changes.
- Done here this session: Hermes Agent as a provider and `deploy/linux/hermes.sh` (`3603cef`). Hermes has not been run anywhere.

## What only this laptop does

| Work | How | Why here |
|---|---|---|
| Android APK builds | `npm run build:apk` in `mobile/`; APKs in `C:\development\AI Assistant\apk\` | Android SDK |
| WhatsApp link (read-only) | `orc whatsapp link`, forwards to the hub | The sign-in is only here, in `Orchestrator\data\whatsapp\auth` |
| Voice note transcription | Whisper large-v3-turbo through `uv` | RTX 5050 GPU |
| Style book and people graph | `orc style learn`, `orc style graph`, `orc style push` | Ollama on the GPU |
| Installing the app on the phone | `adb install -r <apk>` | The phone plugs in here |

It also writes and tests code for both repos.

## Answers to LINUX_WORK.md's list

| Linux asked for | State, checked on the laptop |
|---|---|
| 1. Update the code | Done |
| 2. Run `install.ps1` as administrator | Partly: the tasks `Orchestrator node` and `Orchestrator WhatsApp link` exist and show Ready, but port 4317 does not answer on the laptop. The firewall rule from `f75223e` is newer, so the owner must run the installer again as administrator |
| 3. `node.acceptBranchWork: true`, `builds.androidHere: true` | `acceptBranchWork` is on; `androidHere` is **not set**. The owner edits this config |
| 4. Ollama running with the model pulled | Done: running, with `qwen3:8b` and `gemma3:4b` |
| 5. Push work that is only on the laptop | Nothing to push |

The owner has not restarted anything for this yet. Until then treat the laptop as offline for jobs.

## Corrections for other sessions

- `omen` in `docs/ROADMAP.md` and `docs/HANDOFF.md` is not set in the laptop's config, which sets no node name. The machine is `Roger`. Check the name in `/api/nodes` before setting `builds.androidNode`; it needs the laptop online.
- Hermes belongs on Linux, which stays on. It will not run on the laptop.

## Rules for working here

- Nothing is deleted from the owner's files: it moves to `C:\development\AI Assistant\_to_delete\`.
- Pull before pushing: both machines push to `main`, and a push from here has already collided with one from Linux.
- A push to `main` that touches `mobile/` starts the Android release build on GitHub.
- Never print or commit secrets. Tests and typechecks green before each push, and `tests/failover.test.ts` needs `mobile/node_modules`.

## Not done yet

- Starting the laptop's orchestrator and confirming Linux can see it.
- A real job between the two machines: Linux's borrowing has only been tested with simulated devices.
