#!/bin/sh
# does a backup restore? `scripts/restore-check.sh [glance-….dump]` (default: the newest in ./backups)
#
# restores it into a throwaway postgres (not glance's), checks the tables are there and hold rows,
# and removes it again. run it after setting up backups, then monthly: an untested backup is a hope.
# to restore for real, see docs/operations.md
set -eu

file=${1:-$(ls -1t "${GLANCE_BACKUP_DIR:-./backups}"/glance-*.dump 2> /dev/null | head -n 1)}
[ -n "$file" ] && [ -f "$file" ] || { echo "no dump to check: pass one, or run scripts/backup.sh first" >&2; exit 1; }

name="glance-restore-check-$$"
docker run -d --rm --name "$name" -e POSTGRES_USER=glance -e POSTGRES_PASSWORD=check -e POSTGRES_DB=glance postgres:18-alpine > /dev/null
trap 'docker rm -f "$name" > /dev/null 2>&1' EXIT
until docker exec "$name" pg_isready -U glance -d glance -q 2> /dev/null; do sleep 1; done
# the image's entrypoint restarts postgres once after initializing: wait for the real one
sleep 3
until docker exec "$name" pg_isready -U glance -d glance -q 2> /dev/null; do sleep 1; done

docker exec -i "$name" pg_restore -U glance -d glance --no-owner --exit-on-error < "$file"
count() { docker exec "$name" psql -U glance -d glance -tAc "select count(*) from $1"; }
echo "restored $file:"
for table in reviews settings panels users auth_sessions drizzle.__drizzle_migrations; do
  echo "  $table: $(count "$table") rows"
done
[ "$(count drizzle.__drizzle_migrations)" -gt 0 ] || { echo "no migrations recorded: this isn't a glance database" >&2; exit 1; }
echo "ok"
