#!/usr/bin/env bash
# Builds the app and publishes it to the tailnet-only site.
set -euo pipefail
cd "$(dirname "$0")/.."
bun run build
sudo mkdir -p /srv/lights
sudo rm -rf /srv/lights/dist
sudo cp -r dist /srv/lights/dist
sudo tailscale serve --bg --https=8444 --set-path=/api http://127.0.0.1:8080/api
sudo tailscale serve --bg --https=8444 /srv/lights/dist
