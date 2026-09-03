#!/usr/bin/env bash
set -euo pipefail

# Decrypts and restores a backup produced by scripts/backup.sh into the running production
# docker-compose stack. DESTRUCTIVE: drops and recreates the avos_leaf database first. Does not
# touch the leaffiles volume — only the database (accounts, folder/document metadata) is restored.
#
# Usage: scripts/restore.sh <path-to-avos-leaf-TIMESTAMP.sql.enc>

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${LEAF_ENCRYPTION_KEY:?LEAF_ENCRYPTION_KEY must be set (see .env / DEPLOY.md)}"

ENC_FILE="${1:?Usage: scripts/restore.sh <path-to-backup.sql.enc>}"
[ -f "$ENC_FILE" ] || { echo "No such file: $ENC_FILE" >&2; exit 1; }

TMP_SQL="$(mktemp)"
cleanup() { rm -f "$TMP_SQL"; }
trap cleanup EXIT

echo "Decrypting $ENC_FILE..."
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 \
  -pass env:LEAF_ENCRYPTION_KEY \
  -in "$ENC_FILE" -out "$TMP_SQL"

echo
echo "This will DROP and recreate the 'avos_leaf' database, replacing all current data with"
echo "the contents of $ENC_FILE."
read -r -p "Type 'restore' to continue: " CONFIRM
[ "$CONFIRM" = "restore" ] || { echo "Aborted."; exit 1; }

echo "Dropping and recreating database..."
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U avos_leaf -d postgres -c "DROP DATABASE IF EXISTS avos_leaf;"
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U avos_leaf -d postgres -c "CREATE DATABASE avos_leaf OWNER avos_leaf;"

echo "Restoring dump..."
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U avos_leaf -d avos_leaf < "$TMP_SQL"

echo
echo "Restore complete. Restart the API so it reconnects cleanly:"
echo "  docker compose -f docker-compose.prod.yml --env-file .env restart api"
