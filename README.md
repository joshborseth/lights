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

## Deploy

Agents merge and deploy each finished task with the [`merge-and-deploy`](.agents/skills/merge-and-deploy/SKILL.md) skill. To deploy by hand:

```bash
./scripts/deploy-main.sh               # latest main
./scripts/deploy-main.sh --extension   # latest main and the preset extension
./scripts/deploy.sh                    # this checkout, app only
node scripts/deploy-extension.mjs      # this checkout, preset extension only
./scripts/deploy-automations.sh        # this checkout, automations service only
```
