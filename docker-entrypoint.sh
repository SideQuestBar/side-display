#!/bin/sh
# Starts SideDisplay as the unprivileged `bun` user.
#
# When the container starts as root (the default, and how Home Assistant runs
# apps), the data directory may belong to root: hand it to `bun`, then drop
# privileges. When it is started as another user already, run as that user.
set -e

if [ "$(id -u)" = "0" ]; then
	chown -R bun:bun "${SIDEDISPLAY_DATA_DIR:-/data}" 2>/dev/null || true
	exec setpriv --reuid=bun --regid=bun --init-groups "$@"
fi

exec "$@"
