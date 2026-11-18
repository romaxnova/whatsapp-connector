#!/bin/sh
# Volumes are often mounted owned by root (on Railway always), so the server could not write to them as
# the unprivileged "node" user. Started as root, this hands the data directory to that user and then runs
# the command as it; started as any other user (docker run --user ...), it just runs the command.
set -e
if [ "$(id -u)" = "0" ]; then
  dir="${DATA_DIR:-${RAILWAY_VOLUME_MOUNT_PATH:-/data}}"
  case "$dir" in
    / | /app | /app/* | /bin | /bin/* | /etc | /etc/* | /lib | /lib/* | /proc | /proc/* | /sys | /sys/* | /usr | /usr/*)
      echo "Refusing to use $dir as the data directory: set DATA_DIR to a volume such as /data" >&2
      exit 1
      ;;
  esac
  mkdir -p "$dir"
  # Only what the user does not own yet; -h changes a symbolic link itself, never what it points to.
  find "$dir" ! -user node -exec chown -h node:node {} +
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
