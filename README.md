# AI Orchestrator

A brain that decides **how** to get a piece of work done and **who** should do it. It breaks the work into steps, sends each step to the model best at that kind of work across your **Claude**, **ChatGPT**, **Gemini** and **Perplexity** subscriptions, spreads the steps across **all your devices over Tailscale**, has a *different* model review important output, and merges everything into one result.

It drives the official CLIs (`claude`, `codex`, `gemini`), which log in with your **subscriptions**, so there are no per-token API bills. Perplexity Pro has no CLI, so it uses the API credit that comes with Pro.

```
        you: web UI · CLI · OpenAI-compatible API · MCP
                              │
                              ▼
   classify (instant) ─► planner (Claude) ─► step graph ─► synthesize final answer
   kind + complexity     picks specialist    parallel where      (+ cross-model
                         agents per step     independent         review steps)
                                                  │
                each step → router scores every (device, model):
                capability × your ratings × load × agent preference
                                                  │
           ┌──────────── desktop ─────────────┐  tailnet  ┌────────── laptop ──────────┐
           │ claude · codex · gemini · pplx   │ ◀───────▶ │ claude · gemini            │
           └──────────────────────────────────┘           └────────────────────────────┘
```

## What it does

- **Routes by kind of work.** System design, UI/UX, coding, debugging, review, reasoning/logic, math, research, writing, long documents, images/PDFs, **PCB design**, **3D/CAD models** and data analysis each have a capability score per model ([src/brain/capabilities.ts](src/brain/capabilities.ts)). Research goes to Perplexity, giant inputs to Gemini, agentic coding and architecture to Claude, hard math and logic to ChatGPT, and so on. You can override any score in config.
- **Plans big tasks.** A planner splits "design a board, its enclosure and the app" into specialist steps (`pcb-designer`, `cad-modeler`, `ui-ux-designer`, `researcher`, `reviewer`…) and runs independent steps in parallel.
- **Cross-model review.** A reviewer step never runs on the model that wrote the work.
- **Design first (Elephant-Goldfish).** In Design mode, Claude (the "elephant", with the whole task and codebase) drafts a design document. Fresh Gemini and ChatGPT sessions (the "goldfish") review only the document, so they catch what the author took for granted. The run then waits for you: approve (with notes on which findings to address), send it back for a revision round, or cancel. Nothing is built before you approve; the approved design is saved to `docs/designs/` when the run may edit files. Based on Google's [Elephant-Goldfish Model](https://github.com/google/elephant-goldfish-model).
- **Memory.** Every finished run is remembered (task, approved design, result). Before planning, related past runs are handed to the planner. Kept locally in SQLite; optionally mirrored to a NotebookLM notebook, which the brain can also ask about new tasks.
- **Code maps (Graphify).** For a git working folder, the planner gets a [Graphify](https://github.com/Graphify-Labs/graphify) map of the code: which files form each community and which abstractions everything depends on. It uses it to give parallel steps different files, so they can run side by side (and, once workers can edit, on different devices). Built offline with `graphify update`, no model calls, refreshed when HEAD moves.
- **Survives usage limits.** When a subscription says "limit reached", the step falls back to the next-best model or device, and that subscription cools down until its reset time.
- **Learns.** 👍/👎 on any step shifts future routing for that kind of work.
- **Uses all your devices.** Every device runs the same app. They find each other on your tailnet, advertise which subscriptions they have logged in, and take steps from each other.
- **Plugs into other harnesses.**
  - **OpenAI-compatible API** at `/v1`: point any tool that speaks the OpenAI API at it.
  - **MCP server** (`orc mcp`): Claude Code, Codex or Gemini CLI can hand work to the brain.
- **Your agents.** Agents are YAML files in [agents/](agents). Copy one and edit it to make your own.

## Quick start (each device)

Requires Node 22.13+.

```bash
git clone https://github.com/Roger-Chris/ai-orchestrator.git
cd ai-orchestrator
npm install
npm run orc -- init          # creates orchestrator.config.yaml and a .env with ORC_TOKEN
npm run orc -- doctor --live # checks every subscription with a tiny prompt
npm start                    # http://localhost:4317
```

Log each CLI in once with **your** account:

| Subscription | CLI | Login |
|---|---|---|
| Claude Pro/Max | `npm i -g @anthropic-ai/claude-code` | run `claude`, then `/login` |
| ChatGPT Go/Plus/Pro | `npm i -g @openai/codex@latest` (or the Codex desktop app) | `codex login`, then **Sign in with ChatGPT** |
| Google AI Pro | Antigravity CLI (`agy`): `irm https://antigravity.google/cli/install.ps1 \| iex` (Windows) or `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | run `agy` once and sign in with Google |
| Perplexity Pro (optional) | none | the API is billed separately from Pro. If you have API credit, put `PERPLEXITY_API_KEY=` in `.env`; without it, research goes to Claude, ChatGPT and Gemini, which search the web themselves |

Since June 2026 the Gemini CLI's Google sign-in no longer works for Google AI Pro, so the orchestrator uses the Antigravity CLI when it's installed. It still falls back to `gemini` if you have a `GEMINI_API_KEY` or a work licence.

On Windows the orchestrator automatically uses the Codex desktop app's bundled CLI when present. Older npm `codex` versions reject current models for ChatGPT-plan accounts.

## Multiple devices over Tailscale

1. Install Tailscale on every device and log them into the same tailnet.
2. On every device, run the quick start above and use the **same `ORC_TOKEN`**: copy it from the first device's `.env`.
3. Keep `server.host: tailscale` (the default in the example config). The server then listens only on loopback and the device's Tailscale IP, never on your LAN or the internet.
4. Run `npm start` on each device. Each one discovers the others through `tailscale status` within about 20 seconds. You can also list peers explicitly under `cluster.peers`.

Submit work on any device. Steps run wherever the best free subscription is, and the UI shows which device ran what (`Claude @ laptop`). Without branch work, steps that **edit files** stay on the device you submitted from, and steps sent to other devices run read-only. To use it from your phone, see [The app](#the-app-talk-to-your-agents-from-anywhere).

### Coding on branches across devices

Tick **Branches across devices** (or pass `--branches`) to let other devices write code too:

1. Your laptop checks that the working folder is a git repo with a remote, and makes sure its latest commit is on the remote. If it isn't, it pushes it as `orc/<run>/base`. Your own branches are never pushed or changed. Uncommitted changes are not included.
2. The planner uses the Graphify code map to give each coding step its own files, and orders steps so the ones that change shared code go first.
3. Each coding step goes to a device with `node.acceptBranchWork: true` and a coding model (Claude, ChatGPT or Gemini) that is free. That device clones the repo into its `workRoot` (and later just fetches), creates `orc/<run>-<step>` from the base, merges in the branches of steps this one depends on, lets the model edit, and runs the tests (`branches.testCommand`, auto-detected by default). If the tests fail, the model gets `branches.fixAttempts` tries to fix them. Then it commits and pushes the branch.
4. The run view lists the branches with their device, model, changed files, diff and test result. **Merge** (or **Merge all with passing tests**) merges them into the branch you have checked out in the working folder. A conflict stops the merge and leaves your folder unchanged. Merges stay local until you push.

On each worker: set `node.acceptBranchWork: true`, make sure `git` can push to your repos (`gh auth login` or an SSH key), and install your project's toolchain (Node, Python…) so the tests can run there.

## The app: talk to your agents from anywhere

The orchestrator serves a React app (installable on your phone) at the hub's address. It works like a chat:

- **Conversations.** Each message is a task. Follow-ups in the same conversation see the earlier messages and results, so "make it 2 mm thicker" knows what "it" is. Start a message with `@coder`, `@researcher`, `@pcb-designer`… to send it to one specialist.
- **Agents ask you.** With *Agents may ask me* on (the default), an agent that needs a decision only you can make stops and asks instead of guessing. The step shows its question with a reply box; your answer goes back to it and it carries on.
- **Step in.** Every step has controls for its state: **Stop** a step while it works; with *Pause after each step* on, each step waits for **Continue**, **Edit** (your version is what later steps use) or **Redo…** (with instructions); finished answers can be edited too. Your edits are saved as corrections in memory, so similar tasks later see what you changed. The models themselves don't learn from edits: your subscriptions don't allow retraining them.
- **Watch.** Live output from each step, which model on which device is doing it, designs waiting for approval, branches to merge, devices and usage under Settings.
- **Notifications.** Your phone gets a notification when an agent asks something, a step is paused, a design needs approval, or a run finishes or fails.

Modes (⚙ in the message box): *Brain decides* (simple tasks go straight to the best model, complex ones get planned), *Plan and split*, *One model*, *Design first* (Elephant-Goldfish design, your approval, then the build).

Access controls what agents may do in the chosen folder on the hub: read-only (the default), edit files, or full. It is a ceiling: an agent's own `permission` can lower it, never raise it.

### Set up the always-on PC as the hub

1. On the PC: install Node 22.13+, Git and Tailscale (log in), clone this repo, `npm install`, `npm run orc -- init`, log in the CLIs (`claude`, `codex`, `agy`), then `npm start`. `npm start` builds the app first.
2. Give the app an HTTPS address on your tailnet (needed to install it and for notifications):
   ```bash
   tailscale serve --bg 4317
   ```
   It prints `https://<pc-name>.<tailnet>.ts.net`. Only your tailnet devices can open it. Don't use `tailscale funnel`, which would put it on the public internet.
3. Keep the PC from sleeping (Windows: Settings → System → Power → Sleep: Never) and start the orchestrator on boot (Task Scheduler → *At log on* → `npm start` in the repo folder), so it's always there.
4. On your phone (Tailscale on): open the `https://…ts.net` address, paste `ORC_TOKEN` from the PC's `.env` when asked, then:
   - Android (Chrome): ⋮ → **Install app**.
   - iPhone (Safari): Share → **Add to Home Screen**, and open it from there (iPhone only allows notifications for home-screen apps).
   - In the app: Settings → Notifications → **Turn on**, then **Send a test**.

Requests that come through `tailscale serve` always need the token, even though the proxy runs on the PC itself.

### The Android app

[mobile/](mobile) is a native Android app (React Native with Expo) that does everything the web app does: conversations, answering agents, Continue/Edit/Redo/Stop, design approval, merging branches, devices and usage. You install it from an APK file; it is not on the Play Store. It talks to the hub over Tailscale with the same `ORC_TOKEN`, which it keeps in Android's encrypted storage.

**Build and install** (on a PC with Android Studio's SDK, plugged into the phone with USB debugging on):

```bash
cd mobile
npm install
npx expo prebuild --platform android --clean
cd android && ./gradlew assembleRelease
adb install -r app/build/outputs/apk/release/app-release.apk
```

Or copy `app-release.apk` to the phone and open it (allow installing from your file manager). On first launch, enter the hub's Tailscale address (for example `http://my-pc:4317`) and the token.

**Notifications (optional, about 5 minutes).** Android apps outside the Play Store still receive notifications through Firebase Cloud Messaging, so this needs a free Firebase project:

1. In the [Firebase console](https://console.firebase.google.com) create a project, then **Add app → Android** with package name `dev.rogerchris.orchestrator`. Download `google-services.json` into `mobile/`.
2. In the project's **Settings → Service accounts**, click **Generate new private key**. Save the file on the hub as `fcm-service-account.json` in the orchestrator folder (or point `server.fcmServiceAccount` at it) and restart the hub. Keep it private; it is in `.gitignore`.
3. Rebuild and reinstall the app (the build includes Firebase only when `google-services.json` is there), then in the app: **Settings → Notifications → Turn on**, then **Send a test**.

Without Firebase the app works the same, except that you see what needs you when you open it rather than as a notification. On Xiaomi/Redmi phones, also allow **Autostart** for the app (Settings → Apps → Orchestrator) so notifications arrive while it is closed.

**CLI**

```bash
npm run orc -- run "Research the best LiPo charger ICs under $2, then design the charging circuit as SKiDL" -v
npm run orc -- run "Refactor src/utils for readability and run the tests" --agent coder --permission edit --cwd ../my-app
npm run orc -- run "Add offline sync to the notes app" --mode design --permission edit --cwd ../notes  # asks you to approve
npm run orc -- nodes      # devices and which subscriptions each has ready
npm run orc -- agents
```

**OpenAI-compatible:** base URL `http://localhost:4317/v1`, any API key from loopback (or `ORC_TOKEN` from other devices). Models:

| Model | Behaviour |
|---|---|
| `orchestrator` | Auto mode |
| `orchestrator-plan` | Always plan |
| `auto` | Best single model |
| `claude`, `codex`, `gemini`, `perplexity` | That provider only |
| `agent:<name>` | A specific agent |

**MCP**, e.g. for Claude Code. The `orc serve` server must be running:

```bash
claude mcp add orchestrator -- npx tsx /path/to/ai-orchestrator/src/cli.ts mcp
```

## Configuration

See [orchestrator.config.example.yaml](orchestrator.config.example.yaml). Commonly changed settings:

- `providers.<name>.model` / `deepModel`: the deep model is used for system design, reasoning, math, debugging and PCB steps.
- `providers.<name>.maxConcurrent`: keep this low for tight plans like ChatGPT Go.
- `routing.overrides`: e.g. `{ pcb_design: { codex: 9 } }`.
- `brain.defaultPermission`: `read` is the safe default.
- `memory.notebooklm`: mirror memory to NotebookLM. Install `uv tool install "notebooklm-py[browser]"`, run `notebooklm login`, create a notebook (`notebooklm create "AI Orchestrator memory" --json`) and put its id in `memory.notebooklm.notebook`. notebooklm-py is unofficial and uses undocumented Google APIs, so it can break; local memory keeps working regardless.
- `context.graphify`: `auto` uses Graphify when installed (`uv tool install graphifyy`); `off` disables code maps. Add `graphify-out/` to your project's `.gitignore`.

## Project layout

```
src/
  brain/       classifier, capability matrix, router, planner, design mode, orchestrator (DAG executor)
  providers/   claude / codex / gemini CLI adapters, perplexity API, pool with throttling + cooldowns
  cluster/     tailscale discovery, peer health, remote step execution (NDJSON stream)
  server/      REST + SSE API, OpenAI-compatible /v1, device-to-device /node/*
  store/       SQLite (node:sqlite): runs, events, ratings, cooldowns, usage, memory (FTS5)
  memory/      long-term memory of runs, optional NotebookLM mirror
  context/     Graphify code maps for planning
  server/push.ts  phone notifications (Web Push)
agents/        specialist agents (YAML)
web/           the app: React + Vite, installable (manifest, service worker); built to web/dist by npm start
tests/         unit + end-to-end tests with fake providers, including two-device HTTP and real-git branch tests
```

## Security notes

- Without `server.token` the server only listens on loopback. With a token, non-loopback requests need `Authorization: Bearer <token>`.
- Agents run real CLIs. `edit` and `full` let them change files and run commands in the folder you choose. Use `read` unless you mean it.
- The subscription CLIs keep their own logins. This app never reads or stores your passwords or tokens.

## Development

```bash
npm test          # vitest; fake providers, no quota used
npm run typecheck # server and app
npm run dev       # auto-restart server
npm run dev:web   # the app with hot reload on http://localhost:5173 (talks to the server on 4317)
```
