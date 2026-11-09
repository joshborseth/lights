# lights

A [Foldkit](https://foldkit.dev) app for controlling Zigbee lights through Zigbee2MQTT.

Controls bulbs, groups, and presets over Zigbee2MQTT's WebSocket API, pairs new bulbs and manages groups from the Manage tab, and runs automations such as the PR merge flash through a small service in `service/`. See the [migration plan](docs/migration-plan.md).

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

The app is a PWA, so it can live on the home screen. It has two addresses:

| Address                    | Reachable from                 | Home screen install                  |
| -------------------------- | ------------------------------ | ------------------------------------ |
| The tailnet HTTPS URL      | Any device on the tailnet      | Full PWA that opens offline          |
| `http://192.168.1.67:8445` | Any device on the home network | Works, but needs the network to open |

The local address is plain HTTP, so browsers give it no service worker, and Android Chrome adds a shortcut instead of installing it. Each address is a separate app on the phone.

1. Open one of the addresses in Safari. On Android, use Chrome.
2. Choose Share, then Add to Home Screen. On Android, choose Install app.

To let the tailnet app connect on its own, turn on VPN On Demand in the Tailscale app. Deploys reach the phone the next time the app opens or returns to the foreground. An origin change, such as a new port, needs a fresh install.

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
