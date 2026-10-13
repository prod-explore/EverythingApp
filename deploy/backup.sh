#!/usr/bin/env bash
# Consistent backup of the EverythingApp database from a running compose stack, copied out of the container.
#
#   deploy/backup.sh [target-dir] [keep]        e.g.  deploy/backup.sh /srv/backups/everythingapp 14
#
# The copy is made with SQLite's online backup API (safe while the server runs). It contains every chat — ghost chats
# included — and the provider keys encrypted with KEY_VAULT_SECRET, which is NOT part of the backup: keep it in your
# password manager. Treat the file like the chats it holds (the script makes it owner-only; encrypt it before it leaves
# the machine).
#
# Restore (see docs/adr/0014-data-lifecycle.md):
#   docker compose stop everythingapp-web
#   docker compose run --rm --no-deps -v "$PWD/backup.db:/restore.db:ro" everythingapp-web \
#       node dist/tools/db-backup.js restore /restore.db --yes
#   docker compose start everythingapp-web
set -euo pipefail

TARGET="${1:-./backups}"
KEEP="${2:-14}"
SERVICE="${EVERYTHINGAPP_SERVICE:-everythingapp-web}"
CONTAINER="${EVERYTHINGAPP_CONTAINER:-everythingapp-web}"

umask 077
mkdir -p "$TARGET"

# The tool writes to the data volume (…/.everythingapp/backups) and prunes there; we then copy the newest file out.
OUT="$(docker compose exec -T "$SERVICE" node dist/tools/db-backup.js backup --keep "$KEEP")"
echo "$OUT"
FILE="$(printf '%s\n' "$OUT" | sed -n 's/^Backup written: \(.*\) — [0-9].*/\1/p' | head -n1)"
[ -n "$FILE" ] || { echo "Could not read the backup path from the tool output" >&2; exit 1; }

docker cp "$CONTAINER:$FILE" "$TARGET/$(basename "$FILE")"
chmod 600 "$TARGET/$(basename "$FILE")"
# Same retention on the host side.
ls -1 "$TARGET"/everythingapp-*.db 2>/dev/null | sort | head -n "-$KEEP" | xargs -r rm -f --
echo "Copied to $TARGET/$(basename "$FILE")"
