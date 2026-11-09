#!/usr/bin/env bash
# Builds the automations service and restarts it. Sends nothing to the bulbs.
set -euo pipefail
cd "$(dirname "$0")/.."

install_dir="$HOME/.local/share/lights-automations"
unit_dir="$HOME/.config/systemd/user"

bun build service/main.ts --target=bun --outfile="$install_dir/service.js"
install -m 0644 deploy/lights-automations.service "$unit_dir/lights-automations.service"
systemctl --user daemon-reload

systemctl --user enable lights-automations.service
systemctl --user restart lights-automations.service

systemctl --user --no-pager --lines=5 status lights-automations.service
