#!/bin/sh
# Writes a dump of the database (and, when STORAGE_DIR is readable, an archive
# of the uploaded files) to BACKUP_DIR, then removes dumps older than
# BACKUP_KEEP_DAYS. Run it from cron, or as the `backup` service of
# docker-compose.yml. Copy BACKUP_DIR off the machine as well: a backup on the
# disk it protects is not a backup.
#
# The uploaded files are stored encrypted with APP_ENCRYPTION_KEY, and so are
# the secrets inside the database. Keep that key somewhere other than with the
# backups: without it neither can be read, with it both can.
set -eu

: "${DATABASE_URL:?DATABASE_URL is not set}"
BACKUP_DIR="${BACKUP_DIR:-./var/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"
DUMP="$BACKUP_DIR/pms-$STAMP.dump"

# Custom format: compressed, and restorable table by table with pg_restore.
pg_dump --format=custom --no-owner --no-privileges --file="$DUMP.partial" "$DATABASE_URL"
# A dump that cannot be listed is no use: check before calling it a backup.
pg_restore --list "$DUMP.partial" >/dev/null
mv "$DUMP.partial" "$DUMP"
echo "[backup] database: $DUMP ($(du -h "$DUMP" | cut -f1))"

if [ -n "${STORAGE_DIR:-}" ] && [ -d "$STORAGE_DIR" ]; then
  FILES="$BACKUP_DIR/pms-files-$STAMP.tar.gz"
  tar -czf "$FILES.partial" -C "$STORAGE_DIR" .
  mv "$FILES.partial" "$FILES"
  echo "[backup] files: $FILES ($(du -h "$FILES" | cut -f1))"
fi

find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'pms-*.dump' -o -name 'pms-files-*.tar.gz' \) \
  -mtime "+$KEEP_DAYS" -print -delete | sed 's/^/[backup] removed /'
find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.partial' -mmin +120 -delete
