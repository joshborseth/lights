# lights

A [Foldkit](https://foldkit.dev) app for controlling Zigbee lights through Zigbee2MQTT.

Controls bulbs, groups, and presets over Zigbee2MQTT's WebSocket API, and runs automations such as the PR merge flash through a small service in `service/`. See the [migration plan](docs/migration-plan.md).

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

The app is a PWA, so it can live on the home screen. The phone must be on the tailnet.

1. Open the app's tailnet URL in Safari. On Android, use Chrome.
2. Choose Share, then Add to Home Screen. On Android, choose Install app.

To let the app connect on its own, turn on VPN On Demand in the Tailscale app. Deploys reach the phone the next time the app opens or returns to the foreground. An origin change, such as a new port, needs a fresh install.

## Deploy

Agents merge and deploy each finished task with the [`merge-and-deploy`](.agents/skills/merge-and-deploy/SKILL.md) skill. To deploy by hand:

```bash
./scripts/deploy-main.sh               # latest main
./scripts/deploy-main.sh --extension   # latest main and the preset extension
./scripts/deploy.sh                    # this checkout, app only
node scripts/deploy-extension.mjs      # this checkout, preset extension only
./scripts/deploy-automations.sh        # this checkout, automations service only
```
