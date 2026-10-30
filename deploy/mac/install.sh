#!/usr/bin/env bash
# Sets up (or refreshes) the Orchestrator on the Mac mini as a coding device (Jarvis D4): a
# LaunchAgent that runs `orc serve`, takes branch work, keeps a shared-memory replica synced
# through the Linux hub and sends its file index there. Safe to run again: npm ci, config check,
# plist rewrite, restart. Nothing is deleted.
#   HUB=http://100.104.185.17:4317 deploy/mac/install.sh
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LABEL="dev.rogerchris.orchestrator"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/orchestrator"

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }
warn() { printf '! %s\n' "$*"; }

say "Checking tools"
[ "$(uname)" = "Darwin" ] || die "this script is for macOS; Linux uses deploy/linux/install.sh"
case "$REPO" in *[[:space:]]*) die "the repo path has a space in it ($REPO); clone it somewhere without one" ;; esac
command -v git >/dev/null || die "git is missing: xcode-select --install"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "node is missing: brew install node@22"
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "Node $("$NODE" --version) is too old: the orchestrator needs 22.13+"
command -v tailscale >/dev/null || [ -d /Applications/Tailscale.app ] || warn "Tailscale is not installed: the hub and the phone can't reach this Mac"
for cli in claude codex agy; do
  command -v "$cli" >/dev/null || warn "$cli is not on PATH; that subscription stays unused here until you install it and log in"
done

say "npm ci"
(cd "$REPO" && npm ci --no-audit --no-fund)

say "Config"
CFG="$REPO/orchestrator.config.yaml"
if [ ! -f "$CFG" ]; then
  (cd "$REPO" && node_modules/.bin/tsx src/cli.ts init)
  # A coding device: takes branch work. Its assistant folders: ~/Developer and ~/Documents.
  sed -i '' -e 's/^\(  acceptBranchWork:\) false/\1 true/' "$CFG" || true
  echo "created $CFG (acceptBranchWork: true)"
else
  cp "$CFG" "$CFG.bak-$(date +%Y%m%d-%H%M%S)"
  echo "keeping the existing config (backup made)"
fi
if [ -n "${HUB:-}" ]; then
  touch "$REPO/.env"
  chmod 600 "$REPO/.env"
  if grep -q '^MEMORY_HUB=' "$REPO/.env"; then
    echo "MEMORY_HUB is already set in .env; leaving it"
  else
    printf '\nMEMORY_HUB=%s\n' "$HUB" >> "$REPO/.env"
    echo "MEMORY_HUB=$HUB added to .env (shared memory and the file index go through the Linux hub)"
  fi
else
  warn "HUB is not set: run again with HUB=http://<linux hub>:4317 so this Mac joins the shared memory"
fi
grep -q '^ORC_TOKEN=' "$REPO/.env" 2>/dev/null || warn "ORC_TOKEN is not in .env: copy the same token the other devices use, or peers can't call this Mac"

say "LaunchAgent"
mkdir -p "$(dirname "$PLIST")" "$LOGS"
[ -f "$PLIST" ] && cp "$PLIST" "$PLIST.bak-$(date +%Y%m%d-%H%M%S)"
sed -e "s|@REPO@|$REPO|g" -e "s|@PATH@|$PATH|g" -e "s|@LOGS@|$LOGS|g" "$REPO/deploy/mac/$LABEL.plist.in" > "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "running: launchctl print gui/$(id -u)/$LABEL | grep state"

say "Check"
sleep 4
curl -fsS "http://127.0.0.1:4317/api/health" && echo || warn "the node did not answer yet; see $LOGS/orchestrator.log"
cat <<NOTE

Next on this Mac:
- System Settings > Privacy & Security > Screen Recording: allow Terminal/node, so screenshots (screen.shot) work.
- System Settings > Privacy & Security > Accessibility: allow node if you use apps.close / gui.task.
- In orchestrator.config.yaml set actions.roots (e.g. [~/Developer, ~/Documents]); the file index uses them.
- It appears in the phone app's Devices tab once the hub sees it on the tailnet.
NOTE
