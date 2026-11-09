#!/usr/bin/env bash
# Builds the app and publishes the files that lights-lan serves.
set -euo pipefail
cd "$(dirname "$0")/.."
bun run build
sudo mkdir -p /srv/lights
sudo rm -rf /srv/lights/dist
sudo cp -r dist /srv/lights/dist
