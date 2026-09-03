#!/bin/bash
# Runs the Next.js standalone server and its internal-TLS Caddy sidecar as siblings in the same
# container — same reasoning as avos-vault's frontend entrypoint (TLS can't be wrapped around
# Next.js's standalone output, so it happens in this separate sidecar instead).
set -e

node server.js &
node_pid=$!

caddy run --config /app/docker/Caddyfile --adapter caddyfile &
caddy_pid=$!

wait -n "$node_pid" "$caddy_pid"
exit_code=$?

kill "$node_pid" "$caddy_pid" 2>/dev/null || true
exit "$exit_code"
