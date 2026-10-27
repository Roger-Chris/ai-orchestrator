#!/bin/sh
# Wait up to two minutes for this machine's Tailscale IP. Never fails: without Tailscale the hub
# still starts on loopback (and says so in its log).
i=0
while [ "$i" -lt 60 ]; do
  tailscale ip -4 >/dev/null 2>&1 && exit 0
  i=$((i + 1))
  sleep 2
done
echo "Tailscale is not up after 2 minutes; the hub will serve on loopback only" >&2
exit 0
