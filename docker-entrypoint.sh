#!/bin/sh
# Runs the app as PUID:PGID (default 1000:1000) so files in the bind-mounted
# ./data folder belong to your user on the host, not root. PUID=0 keeps root.
set -e
mkdir -p /data
if [ "$(id -u)" = "0" ] && [ "${PUID:-1000}" != "0" ]; then
  chown -R "${PUID:-1000}:${PGID:-1000}" /data 2>/dev/null \
    || echo "[entrypoint] warning: couldn't chown /data to ${PUID}:${PGID}" >&2
  export HOME=/data
  exec setpriv --reuid="${PUID:-1000}" --regid="${PGID:-1000}" --clear-groups "$@"
fi
exec "$@"
