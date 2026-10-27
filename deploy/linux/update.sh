#!/usr/bin/env bash
# Pull the latest code and re-run the installer (npm ci, web build, unit, restart).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

git -C "$REPO" pull --ff-only
exec "$REPO/deploy/linux/install.sh"
