#!/usr/bin/env bash
# Builds the server for the app's local network address and restarts it. It
# serves the files that deploy.sh publishes. Sends nothing to the bulbs.
set -euo pipefail
cd "$(dirname "$0")/.."

install_dir="$HOME/.local/share/lights-lan"
unit_dir="$HOME/.config/systemd/user"

bun build service/lan-main.ts --target=bun --outfile="$install_dir/site.js"
install -m 0644 deploy/lights-lan.service "$unit_dir/lights-lan.service"
systemctl --user daemon-reload

systemctl --user enable lights-lan.service
systemctl --user restart lights-lan.service
systemctl --user --no-pager --lines=5 status lights-lan.service
