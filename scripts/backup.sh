#!/usr/bin/env bash
set -euo pipefail

# Dumps the Postgres database from the running production docker-compose stack, encrypts it, and
# rotates old backups. Intended to run unattended from cron on the VPS — see the "Backups" section
# of DEPLOY.md for the cron entry.
#
# Usage: scripts/backup.sh
#
# Env (read from .env in the repo root if present, otherwise must already be exported):
#   LEAF_ENCRYPTION_KEY    - required. Same key that encrypts sensitive columns at the app layer
#                            (see DEPLOY.md) — reused here as the backup passphrase so there is
#                            only one secret to protect and back up safely, not two.
#   BACKUP_DIR             - where encrypted dumps are written (default: ./backups)
#   BACKUP_RETENTION_DAYS  - delete backups older than this many days (default: 14)
#
# This backs up avos-leaf's own database only — accounts, folder/document metadata. It does NOT
# back up the actual PDF bytes sitting under Leaf__StoragePath (the leaffiles volume) — that volume
# needs its own separate backup policy (e.g. a periodic tar of the Docker volume).

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${LEAF_ENCRYPTION_KEY:?LEAF_ENCRYPTION_KEY must be set (see .env / DEPLOY.md)}"
BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_FILE="$BACKUP_DIR/avos-leaf-$TIMESTAMP.sql"
ENC_FILE="$DUMP_FILE.enc"

cleanup() { rm -f "$DUMP_FILE"; }
trap cleanup EXIT

echo "[$(date -u +%FT%TZ)] Dumping database..."
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U avos_leaf avos_leaf > "$DUMP_FILE"

echo "[$(date -u +%FT%TZ)] Encrypting..."
# AES-256-CBC with PBKDF2 key stretching, passphrase = LEAF_ENCRYPTION_KEY. A plain database dump is
# not itself protected by the app's column-level encryption (that only covers specific fields), so
# the whole dump is encrypted at rest here too.
openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt \
  -pass env:LEAF_ENCRYPTION_KEY \
  -in "$DUMP_FILE" -out "$ENC_FILE"

echo "[$(date -u +%FT%TZ)] Backup written: $ENC_FILE ($(du -h "$ENC_FILE" | cut -f1))"

if [ -n "$BACKUP_RETENTION_DAYS" ]; then
  echo "[$(date -u +%FT%TZ)] Pruning backups older than $BACKUP_RETENTION_DAYS days..."
  find "$BACKUP_DIR" -maxdepth 1 -name 'avos-leaf-*.sql.enc' -mtime "+$BACKUP_RETENTION_DAYS" -print -delete
fi

echo "[$(date -u +%FT%TZ)] Backup complete."
