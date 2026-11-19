#!/usr/bin/env bash
# Prepares a development machine: PostgreSQL server, the dev database role, and
# workspace dependencies. Safe to run repeatedly. Runs to completion and exits;
# long-running services belong in scripts/cloud-agent-start.sh.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

pg_server_bin() {
  ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -n 1
}

if [ -z "$(pg_server_bin)" ] || ! command -v psql >/dev/null 2>&1; then
  echo "[install] installing PostgreSQL"
  $SUDO apt-get update -y
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    postgresql postgresql-contrib
else
  echo "[install] PostgreSQL already installed: $(psql --version)"
fi

# The dev role and database live in the data directory, so creating them here
# bakes them into an environment snapshot. The server is started only for the
# duration of this step if it is not already running.
started_here=0
if ! pg_isready -q -h localhost -p 5432; then
  $SUDO service postgresql start
  started_here=1
  for _ in $(seq 1 30); do
    pg_isready -q -h localhost -p 5432 && break
    sleep 1
  done
fi
pg_isready -h localhost -p 5432

run_psql() {
  $SUDO -u postgres psql -v ON_ERROR_STOP=1 -qAt "$@"
}

if [ "$(run_psql -c "SELECT 1 FROM pg_roles WHERE rolname = 'pms'")" != "1" ]; then
  echo "[install] creating role pms"
  run_psql -c "CREATE ROLE pms LOGIN PASSWORD 'pms' CREATEDB"
fi
if [ "$(run_psql -c "SELECT 1 FROM pg_database WHERE datname = 'pms'")" != "1" ]; then
  echo "[install] creating database pms"
  run_psql -c "CREATE DATABASE pms OWNER pms"
fi

if [ "$started_here" -eq 1 ]; then
  $SUDO service postgresql stop
fi

if [ -f package.json ] && [ -f pnpm-lock.yaml ]; then
  echo "[install] installing workspace dependencies"
  pnpm install --frozen-lockfile
elif [ -f package.json ]; then
  echo "[install] no lockfile yet; running pnpm install"
  pnpm install
fi

echo "[install] done"
