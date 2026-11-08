#!/usr/bin/env bash
# Builds the automations service, restarts it, and publishes its API on the
# tailnet-only site. Sends nothing to the bulbs.
set -euo pipefail
cd "$(dirname "$0")/.."

install_dir="$HOME/.local/share/lights-automations"
unit_dir="$HOME/.config/systemd/user"

bun build service/main.ts --target=bun --outfile="$install_dir/service.js"
install -m 0644 deploy/lights-automations.service "$unit_dir/lights-automations.service"
systemctl --user daemon-reload

systemctl --user enable lights-automations.service
systemctl --user restart lights-automations.service

sudo tailscale serve --bg --https=8444 --set-path=/automations http://127.0.0.1:8093/automations
systemctl --user --no-pager --lines=5 status lights-automations.service
