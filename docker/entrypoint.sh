#!/bin/sh
# LocalCloud app container entrypoint.
#
# The emulator containers are created on the HOST docker daemon and publish their ports on the
# host's loopback (127.0.0.1:9297 and up, one port per environment) with TLS certificates for 127.0.0.1. The backend inside
# this container expects them on its own loopback, so forward each port through the host. That
# keeps every endpoint (health checks, AWS SDKs, terraform) on https://127.0.0.1:<port> with the
# emulator's own certificate — no code or TLS changes needed.
set -e

# Projects can add environments, each on the next free port after 9300, so forward a range:
# LOCALCLOUD_EMULATOR_PORTS=first-last (default 9297-9316, room for 20 environments).
range="${LOCALCLOUD_EMULATOR_PORTS:-9297-9316}"
first="${range%-*}"
last="${range#*-}"
port="$first"
while [ "$port" -le "$last" ]; do
  socat TCP-LISTEN:"$port",bind=127.0.0.1,fork,reuseaddr TCP:host.docker.internal:"$port" &
  port=$((port + 1))
done

exec "$@"
