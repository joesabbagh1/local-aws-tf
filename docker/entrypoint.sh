#!/bin/sh
# LocalCloud app container entrypoint.
#
# The emulator containers are created on the HOST docker daemon and publish their ports on the
# host's loopback (127.0.0.1:9297-9300) with TLS certificates for 127.0.0.1. The backend inside
# this container expects them on its own loopback, so forward each port through the host. That
# keeps every endpoint (health checks, AWS SDKs, terraform) on https://127.0.0.1:<port> with the
# emulator's own certificate — no code or TLS changes needed.
set -e

for port in 9297 9298 9299 9300; do
  socat TCP-LISTEN:"$port",bind=127.0.0.1,fork,reuseaddr TCP:host.docker.internal:"$port" &
done

exec "$@"
