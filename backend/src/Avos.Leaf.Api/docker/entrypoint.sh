#!/bin/bash
# Runs the API and its internal-TLS Caddy sidecar as siblings in the same container. If either
# exits, the other is killed and the container exits with the failing process's status, so
# Docker's restart policy sees the failure instead of a half-alive container.
set -e

dotnet Avos.Leaf.Api.dll &
api_pid=$!

caddy run --config /app/docker/Caddyfile --adapter caddyfile &
caddy_pid=$!

wait -n "$api_pid" "$caddy_pid"
exit_code=$?

kill "$api_pid" "$caddy_pid" 2>/dev/null || true
exit "$exit_code"
