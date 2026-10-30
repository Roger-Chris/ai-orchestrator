#!/usr/bin/env bash
# Run Hermes Agent next to the hub, in a container (safe to re-run). Hermes has its own terminal, so
# it stays in the container: on the host it could read the hub's .env and get around every scope.
# It sees only ~/.hermes, and its API answers on this machine only.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA="$HOME/.hermes"
HUB_IP="$(tailscale ip -4 2>/dev/null | head -1 || true)"

command -v docker >/dev/null || { echo "Docker is needed: sudo apt install docker.io && sudo usermod -aG docker \$USER, then log in again."; exit 1; }
command -v openssl >/dev/null || { echo "openssl is needed."; exit 1; }
[ -n "$HUB_IP" ] || { echo "Tailscale is needed: Hermes reaches the hub at this machine's Tailscale address."; exit 1; }

mkdir -p "$DATA"
chmod 700 "$DATA"
touch "$DATA/.env"
chmod 600 "$DATA/.env"

# The key the hub uses to call Hermes: the same value on both sides.
if ! grep -q '^API_SERVER_KEY=' "$DATA/.env"; then
  echo "API_SERVER_KEY=$(openssl rand -hex 32)" >> "$DATA/.env"
fi
key="$(grep '^API_SERVER_KEY=' "$DATA/.env" | head -1 | cut -d= -f2-)"
if ! grep -q '^HERMES_API_KEY=' "$REPO/.env" 2>/dev/null; then
  echo "HERMES_API_KEY=$key" >> "$REPO/.env"
  added_key=1
fi

# Written once: your later edits to the config are kept.
if [ ! -f "$DATA/config.yaml" ]; then
  read -rsp "Outside agent token for Hermes (app: Settings -> Outside agents; Enter to skip): " token
  echo
  {
    cat <<'YAML'
# Hermes thinks with its own key: it needs native tool calling and at least 64k of context.
providers:
  groq:
    api: https://api.groq.com/openai/v1
    key_env: GROQ_API_KEY
model:
  default: openai/gpt-oss-120b
  provider: custom:groq
approvals:
  mode: manual
  unattended_mode: deny
  cron_mode: deny
  single_query_mode: deny
YAML
    if [ -n "$token" ]; then
      cat <<YAML
mcp_servers:
  orchestrator:
    url: "http://$HUB_IP:4317/mcp"
    headers:
      Authorization: "Bearer $token"
YAML
    fi
  } > "$DATA/config.yaml"
  chmod 600 "$DATA/config.yaml"
fi

if ! grep -Eq '^(GROQ_API_KEY|OPENROUTER_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY)=.' "$DATA/.env"; then
  echo "Hermes has no model key yet. Add one (a separate key, not the hub's) to $DATA/.env, for example:"
  echo "  GROQ_API_KEY=..."
  echo "Then run this script again. The default config uses Groq; change the model in $DATA/config.yaml for another service."
  exit 1
fi

docker rm -f hermes >/dev/null 2>&1 || true
docker run -d \
  --name hermes \
  --restart unless-stopped \
  --memory=1500m --cpus=1 \
  -e PUID="$(id -u)" -e PGID="$(id -g)" \
  -e API_SERVER_ENABLED=true \
  -e API_SERVER_HOST=0.0.0.0 \
  -e API_SERVER_MODEL_NAME=hermes-agent \
  -v "$DATA":/opt/data \
  -p 127.0.0.1:8642:8642 \
  nousresearch/hermes-agent:stable gateway run >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS -m 2 http://127.0.0.1:8642/health >/dev/null 2>&1; then
    echo "Hermes is running on 127.0.0.1:8642 (logs: docker logs -f hermes)."
    if [ -n "${added_key:-}" ]; then
      echo "HERMES_API_KEY was added to the hub's .env. Restart the hub: systemctl --user restart orchestrator-hub"
    fi
    exit 0
  fi
  sleep 2
done
echo "Hermes did not answer in time: docker logs hermes"
exit 1
