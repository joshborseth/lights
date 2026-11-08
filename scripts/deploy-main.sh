#!/usr/bin/env bash
# Deploys the latest origin/main from a throwaway checkout, and confirms the
# live site serves that build. Deploys run one at a time and fetch after taking
# the lock, so a slower deploy cannot replace a newer merge with older code.
# Pass --extension to also hot-load extension/presets.mjs.
set -euo pipefail

with_extension=false
case "${1:-}" in
  --extension) with_extension=true ;;
  "") ;;
  *)
    echo "Usage: $0 [--extension]" >&2
    exit 2
    ;;
esac

git_dir="$(git -C "$(dirname "$0")" rev-parse --path-format=absolute --git-common-dir)"
exec 9>"$git_dir/lights-deploy.lock"
echo "Waiting for any other deploy to finish..."
flock 9

checkout="$(mktemp -d "${XDG_CACHE_HOME:-$HOME/.cache}/lights-deploy.XXXXXX")"
cleanup() {
  git --git-dir="$git_dir" worktree remove --force "$checkout" || rm -rf "$checkout"
}
trap cleanup EXIT

git --git-dir="$git_dir" fetch origin main
git --git-dir="$git_dir" worktree add --detach "$checkout" origin/main
cd "$checkout"

bun install --frozen-lockfile
./scripts/deploy.sh
./scripts/deploy-automations.sh
if [ "$with_extension" = true ]; then
  node scripts/deploy-extension.mjs
fi

host="$(tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")')"
curl --fail --silent --show-error "https://$host:8444/" | cmp - dist/index.html
echo "Deployed $(git rev-parse --short HEAD)."
