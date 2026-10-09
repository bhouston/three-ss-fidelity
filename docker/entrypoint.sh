#!/bin/sh
set -eu
if [ "$#" -gt 0 ] && [ "$1" != '--describe' ]; then exec "$@"; fi
exec python3 /app/docker/dockergrid.py "$@"
