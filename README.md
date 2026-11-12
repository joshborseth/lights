# lights

A [Foldkit](https://foldkit.dev) app for controlling Zigbee lights through Zigbee2MQTT.

Controls bulbs, groups, and presets over Zigbee2MQTT's WebSocket API, pairs new bulbs and manages groups from the Devices page, and runs automations such as the PR merge flash, Music colors (bulbs follow the album cover of the song playing on the TV, and with Light show on, move with its beats, sections, and drops), and Screen colors (bulbs follow the picture of a film or show playing in Joshflix) through a small service in `service/`. See the [migration plan](docs/migration-plan.md).

## Develop

```bash
bun install
bun dev
```

## Check

```bash
bun run typecheck
bun run test
bun run lint
bun run build
```

## Install on a phone

The app has one address, `http://192.168.1.67:8445`. It works on the home network without Tailscale. Away from home it works while Tailscale is connected, through a subnet route for that one address.

The address is plain HTTP, so browsers give it no service worker. The app needs a connection to open, and Android Chrome adds a shortcut instead of installing it.

1. Open the address in Safari. On Android, use Chrome.
2. Choose Share, then Add to Home Screen.

To connect on its own away from home, turn on VPN On Demand and Use Tailscale Subnets in the Tailscale app. Deploys reach the phone the next time the app loads. An origin change, such as a new port, needs a fresh install.

## Deploy

Agents merge and deploy each finished task with the [`merge-and-deploy`](.agents/skills/merge-and-deploy/SKILL.md) skill. To deploy by hand:

```bash
./scripts/deploy-main.sh               # latest main
./scripts/deploy-main.sh --extension   # latest main and the preset extension
./scripts/deploy.sh                    # this checkout, app only
node scripts/deploy-extension.mjs      # this checkout, preset extension only
./scripts/deploy-automations.sh        # this checkout, automations service only
./scripts/deploy-lan.sh                # this checkout, local network server only
```
