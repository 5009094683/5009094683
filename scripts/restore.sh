#!/bin/sh
# Restores a dump made by scripts/backup.sh into the database named by
# DATABASE_URL, replacing what is there. Stop the API and the worker first.
#
#   DATABASE_URL=postgres://... scripts/restore.sh var/backups/pms-20270110T020000Z.dump --yes
#
# To restore the uploaded files as well, unpack the matching archive into
# STORAGE_DIR:  tar -xzf pms-files-<stamp>.tar.gz -C "$STORAGE_DIR"
set -eu

: "${DATABASE_URL:?DATABASE_URL is not set}"
DUMP="${1:-}"
CONFIRM="${2:-}"

if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "Usage: scripts/restore.sh <dump file> --yes" >&2
  exit 2
fi
if [ "$CONFIRM" != "--yes" ]; then
  echo "This replaces everything in the database at:" >&2
  echo "  $(printf '%s' "$DATABASE_URL" | sed -E 's#(://[^:/@]+):[^@]*@#\1:***@#')" >&2
  echo "Run it again with --yes as the second argument to go ahead." >&2
  exit 2
fi

pg_restore --list "$DUMP" >/dev/null
# One transaction: the restore either completes or leaves the database as it was.
pg_restore --clean --if-exists --no-owner --no-privileges --single-transaction \
  --dbname="$DATABASE_URL" "$DUMP"
echo "[restore] restored $DUMP"
echo "[restore] start the API and the worker; they apply any newer migrations by themselves"
