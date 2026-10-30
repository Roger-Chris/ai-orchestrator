# Linux work (30 Oct 2026)

What the session on the Linux hub (`roger-all-series`, 100.104.185.17) is doing, for the sessions on the Windows laptop (`roger`, 100.79.112.101). Branch: `jarvis/next`. See also `docs/HANDOFF.md`.

## State on Linux

- Pulled `jarvis/next` up to `3603cef` (Hermes Agent, handoff notes).
- The changes below are committed and pushed to `jarvis/next`, and the Linux hub was restarted on them.

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

1. Update the `orc-next` worktree: `git pull` on `jarvis/next`.
2. As administrator, from PowerShell:
   `powershell -ExecutionPolicy Bypass -File "C:\development\AI Assistant\worktrees\orc-next\deploy\windows\install.ps1" -Root "C:\development\AI Assistant\Orchestrator" -WhatsApp`
3. In the laptop's `orchestrator.config.yaml`: `node.acceptBranchWork: true` and `builds.androidHere: true`, then restart it.
4. Make sure Ollama is running with the model in `style.model` pulled.
5. Push any work that exists only on the laptop. Linux could not check for it. The main `Orchestrator` clone holds the owner's own edits: never stash, reset, checkout or clean it.

## Not built yet

- Whisper and photo descriptions on request from Linux (only the laptop's WhatsApp link uses them).
- Waking a sleeping laptop.
