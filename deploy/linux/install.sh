#!/usr/bin/env bash
# Sets up (or refreshes) the Orchestrator hub as a systemd user service on Linux.
# Safe to run again at any time: npm ci, web build, unit rewrite, restart.
# Walk-through: "Linux hub" in README.md.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

say() { printf '\n== %s\n' "$*"; }
die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }
warn() { printf '! %s\n' "$*"; }

say "Checking tools"
case "$REPO" in *[[:space:]]*) die "the repo path has a space in it ($REPO); clone it somewhere without one" ;; esac
command -v systemctl >/dev/null || die "systemd is required"
command -v git >/dev/null || die "git is missing: sudo apt install git"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || die "node is missing: install Node 22 LTS"
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "Node $("$NODE" --version) is too old: the hub needs 22.13+"
command -v tailscale >/dev/null || warn "tailscale is not installed: the phone and other devices can't reach the hub"
for cli in claude codex agy; do
  command -v "$cli" >/dev/null || warn "$cli is not on PATH; that subscription stays unused until you install it and log in"
done

say "npm ci"
(cd "$REPO" && npm ci --no-audit --no-fund)

say "Config"
if [ ! -f "$REPO/orchestrator.config.yaml" ]; then
  (cd "$REPO" && node_modules/.bin/tsx src/cli.ts init)
  # Fresh config on a small machine: one step per subscription at a time, fewer steps in parallel.
  # Coding on branches stays off here (acceptBranchWork: false): that's for the Omen and the Mac mini.
  sed -i -e 's/^\(    maxConcurrent:\) 2/\1 1/' -e 's/^\(  maxParallelSteps:\) 4/\1 2/' "$REPO/orchestrator.config.yaml"
  echo "set maxConcurrent: 1 per provider and maxParallelSteps: 2 for an 8 GB machine"
else
  echo "keeping the existing orchestrator.config.yaml"
fi
if [ -f "$REPO/.env" ]; then
  sed -i 's/\r$//' "$REPO/.env"   # a .env copied from Windows has CRLF endings
  chmod 600 "$REPO/.env"
fi
grep -q '^ORC_TOKEN=' "$REPO/.env" 2>/dev/null || die "no ORC_TOKEN in .env (run: npm run orc -- init)"
[ -f "$REPO/fcm-service-account.json" ] || warn "no fcm-service-account.json: phone notifications are off until you copy it here"

say "Building the web app"
(cd "$REPO" && npm run build:web)

say "systemd user unit"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$unit_dir"
sed -e "s|@REPO@|$REPO|g" -e "s|@PATH@|$PATH|g" \
  "$REPO/deploy/linux/orchestrator-hub.service.in" >"$unit_dir/orchestrator-hub.service"
echo "wrote $unit_dir/orchestrator-hub.service"
systemctl --user daemon-reload

# Without lingering, user services stop at logout and don't start at boot.
if ! loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
  say "Letting your services run without a login (loginctl enable-linger)"
  loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER"
fi

say "Starting the hub"
systemctl --user enable orchestrator-hub >/dev/null
systemctl --user restart orchestrator-hub
up=no
for _ in $(seq 45); do
  if "$NODE" -e "fetch('http://127.0.0.1:4317/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
    up=yes
    break
  fi
  sleep 2
done
[ "$up" = yes ] || die "the hub did not answer on :4317: journalctl --user -u orchestrator-hub -n 50"
echo "hub is up: http://127.0.0.1:4317"
ip="$(tailscale ip -4 2>/dev/null | head -1 || true)"
if [ -n "$ip" ]; then echo "phone app address: http://$ip:4317"; fi

say "Done"
echo "Logs:    journalctl --user -u orchestrator-hub -f"
echo "Update:  deploy/linux/update.sh"
echo "Check the AI CLIs: npm run orc -- doctor --live"
