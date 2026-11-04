#!/bin/sh
# mekiki's database, dumped and sent off this machine. run it from the checkout, on a schedule:
#
#   17 3 * * *  cd /srv/mekiki && scripts/backup.sh >> /var/log/mekiki-backup.log 2>&1
#
# where the dump goes off the machine, any of (set in the environment, or in backup.env beside this checkout):
#   MEKIKI_BACKUP_RCLONE=remote:bucket/mekiki   rclone copies each dump there
#   RESTIC_REPOSITORY=… RESTIC_PASSWORD=…       restic backs each dump up
# MEKIKI_BACKUP_PING_URL (healthchecks.io, uptime kuma's push url…) is called after a good backup:
# have it alert when a day goes by without one
set -eu

[ -f backup.env ] && . ./backup.env
dir=${MEKIKI_BACKUP_DIR:-./backups}
keep=${MEKIKI_BACKUP_KEEP:-14}
mkdir -p "$dir"

file="$dir/mekiki-$(date -u +%Y%m%dT%H%M%SZ).dump"
# written beside its name, then renamed: a dump cut short is never taken for a whole one
docker compose exec -T postgres pg_dump -U mekiki -d mekiki -Fc > "$file.part"
# a dump pg_restore can't list is no backup
docker compose exec -T postgres pg_restore --list < "$file.part" > /dev/null
mv "$file.part" "$file"
echo "$(date -u +%FT%TZ) dumped $(du -h "$file" | cut -f1) to $file"

sent=no
if [ -n "${MEKIKI_BACKUP_RCLONE:-}" ]; then
  rclone copy "$file" "$MEKIKI_BACKUP_RCLONE"
  sent=yes
fi
if [ -n "${RESTIC_REPOSITORY:-}" ]; then
  restic backup --quiet --tag mekiki "$file"
  restic forget --quiet --tag mekiki --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune
  sent=yes
fi
if [ "$sent" = no ]; then
  # still a failure: a backup on the machine it protects isn't one
  echo "no MEKIKI_BACKUP_RCLONE or RESTIC_REPOSITORY: the dump is only on this machine" >&2
  exit 1
fi

# the newest $keep stay here too, for a quick restore
ls -1t "$dir"/mekiki-*.dump | tail -n +"$((keep + 1))" | while read -r old; do rm -f "$old"; done

if [ -n "${MEKIKI_BACKUP_PING_URL:-}" ]; then curl -fsS -m 10 --retry 3 "$MEKIKI_BACKUP_PING_URL" > /dev/null; fi
