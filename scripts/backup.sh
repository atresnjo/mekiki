#!/bin/sh
# glance's database, dumped and sent off this machine. run it from the checkout, on a schedule:
#
#   17 3 * * *  cd /srv/glance && scripts/backup.sh >> /var/log/glance-backup.log 2>&1
#
# where the dump goes off the machine, any of (set in the environment, or in backup.env beside this checkout):
#   GLANCE_BACKUP_RCLONE=remote:bucket/glance   rclone copies each dump there
#   RESTIC_REPOSITORY=… RESTIC_PASSWORD=…       restic backs each dump up
# GLANCE_BACKUP_PING_URL (healthchecks.io, uptime kuma's push url…) is called after a good backup:
# have it alert when a day goes by without one
set -eu

[ -f backup.env ] && . ./backup.env
dir=${GLANCE_BACKUP_DIR:-./backups}
keep=${GLANCE_BACKUP_KEEP:-14}
mkdir -p "$dir"

file="$dir/glance-$(date -u +%Y%m%dT%H%M%SZ).dump"
# written beside its name, then renamed: a dump cut short is never taken for a whole one
docker compose exec -T postgres pg_dump -U glance -d glance -Fc > "$file.part"
# a dump pg_restore can't list is no backup
docker compose exec -T postgres pg_restore --list < "$file.part" > /dev/null
mv "$file.part" "$file"
echo "$(date -u +%FT%TZ) dumped $(du -h "$file" | cut -f1) to $file"

sent=no
if [ -n "${GLANCE_BACKUP_RCLONE:-}" ]; then
  rclone copy "$file" "$GLANCE_BACKUP_RCLONE"
  sent=yes
fi
if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  restic backup --quiet --tag glance "$file"
  restic forget --quiet --tag glance --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
  sent=yes
fi
if [ "$sent" = no ]; then
  # still a failure: a backup on the machine it protects isn't one
  echo "no GLANCE_BACKUP_RCLONE or RESTIC_REPOSITORY: the dump is only on this machine" >&2
  exit 1
fi

# the newest $keep stay here too, for a quick restore
ls -1t "$dir"/glance-*.dump | tail -n +"$((keep + 1))" | while read -r old; do rm -f "$old"; done

if [ -n "${GLANCE_BACKUP_PING_URL:-}" ]; then curl -fsS -m 10 --retry 3 "$GLANCE_BACKUP_PING_URL" > /dev/null; fi
