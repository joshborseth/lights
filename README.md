# lights

A [Foldkit](https://foldkit.dev) app for controlling Zigbee lights through Zigbee2MQTT.

Controls bulbs, groups, and presets over Zigbee2MQTT's WebSocket API. See the [migration plan](docs/migration-plan.md).

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

## Deploy

```bash
./scripts/deploy.sh                  # app
node scripts/deploy-extension.mjs    # preset extension
```
