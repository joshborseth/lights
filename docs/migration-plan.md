# Migration plan: Foldkit lights app

Replace Windfront, the Zigbee2MQTT web UI, with a small Foldkit app as the everyday way to control the lights on Josh's dev box.

## What runs today

| Piece | What it does | Plan |
| --- | --- | --- |
| Zigbee2MQTT 2.14.2 and the USB coordinator | Talks to the 7 bulbs and owns 3 groups: All Lights, Bedroom, Rest of the House | Keep |
| Mosquitto | MQTT broker for Zigbee2MQTT and the scripts below | Keep |
| `presets.mjs` extension and `presets.json` | 10 presets, including the coordinator-driven Rainbow loop | Keep |
| Windfront 2.15.0 | Today's lights UI, bundled with Zigbee2MQTT | Replace for daily use |
| 9 PM all-off timer | Publishes to MQTT | Keep, unaffected |
| PR-merge purple flash | Publishes to MQTT | Keep, unaffected |
| Home Assistant, Music Assistant | TV and music only. Home Assistant has no MQTT integration, so it does not control these lights | Out of scope |

Zigbee2MQTT and Mosquitto have to stay, because something must drive the radio. Only the UI layer changes, so the swap carries little risk: the new app is one more client.

Windfront cannot be uninstalled. Zigbee2MQTT's WebSocket API comes from its frontend extension, so `frontend.enabled` stays `true`. The swap means nobody needs to open Windfront, apart from pairing a new bulb.

## Architecture

```
Browser (Foldkit SPA)
   | same-origin WebSocket, /api
Tailscale Serve (tailnet only)  --- static files from dist/
   |
Zigbee2MQTT /api  ->  Zigbee radio
```

There is no backend to write or run. Zigbee2MQTT already sends every device, group, and state change over its WebSocket as `{ topic, payload }`, and accepts commands in the same shape. A read-only connection test confirmed this against the live system: `bridge/devices`, `bridge/groups` (with scenes), and per-light state all arrive on connect.

Foldkit pieces, following the `websocket-chat` example this repo was scaffolded from:

- `ManagedResource` owns the socket, and the Model decides when it is live.
- A `Subscription` turns frames into Messages.
- A `Command` sends each light command.
- Effect `Schema` decodes each known topic at the boundary. Unknown topics are ignored.
- `@foldkit/ui` `Slider` handles brightness and color temperature.

The app is one screen, so it needs no client-side routes and no server fallback for deep links.

## Rules for commands to the bulbs

The existing scripts learned these the hard way, and the app has to follow them:

- **Off is exactly `{"state":"OFF"}`.** Any `transition` key, even 0, makes Zigbee2MQTT send a level-0 move instead, and several bulbs stay on at minimum brightness.
- **Never send `transition` for color.** IKEA bulbs freeze and drop new colors until a fade finishes.
- **Throttle sliders to one command per 400 ms, and always send the final value.** Faster updates get dropped.
- **Recall presets per group with `{"scene_recall": <id>}`** on All Lights or Rest of the House.
- **Bedroom has no presets, on purpose.** Do not offer them there.
- **Any other command to a group stops its Rainbow loop.** That is the intended way to end it.
- **Send group Off twice, 400 ms apart.** A Rainbow frame already in flight can undo the first one.
- **Show reported state, not assumed state.** A slider may lead while dragging, but the next state frame from the bulb wins.

## Milestones

Each milestone ends in something usable. Windfront stays available until the cutover.

### 0. Foundation (done)

Private repo, Foldkit SPA scaffold with type check, tests, build, and lint passing.

### 1. Read-only live view

- Replace the chat example with the lights Model and frame decoding.
- Reconnect automatically with backoff. The example only has a manual retry.
- Show rooms, bulbs, on/off, brightness, color, and offline state.
- Proxy `/api` in the Vite dev server.
- Test with Foldkit Story and Scene tests using recorded frames.

This milestone sends no commands, so development cannot change the real lights.

### 2. Control

- On/off, brightness, color temperature, and color for each bulb and group.
- Apply the command rules above, with tests for each.
- The first run against real bulbs happens with Josh watching.

### 3. Presets

- Recall the 10 existing presets per group, including Rainbow.
- Recall only. Editing presets means writing `presets.json`, which needs a backend (see open decisions).

### 4. Deploy alongside Windfront

- Build `dist/` and publish it with Tailscale Serve on an unused tailnet-only port, with `/api` proxied to Zigbee2MQTT.
- Check first that Serve carries the WebSocket through a path proxy. This is the one unproven part of the design. If it fails, use a small reverse-proxy container, which needs its own approval.
- Use it from the phone for about a week.

### 5. Cutover

- Change the Zigbee2MQTT port mapping in `/srv/homeassistant/compose.yaml` to `127.0.0.1:8080:8080`, and recreate that container. Expect a short Zigbee outage.
- Update the Zigbee2MQTT section of that folder's README.
- Open Windfront through a tailnet-only proxy when a bulb needs pairing.

**Rollback:** restore the port line. Nothing else changes, because the app holds no state of its own.

## Open decisions

1. **Tailnet only, or LAN too?** The plan assumes tailnet only. Anyone at home without Tailscale could not use the app. LAN access would need a different hosting path and its own authentication.
2. **Edit presets in the app?** The plan assumes recall only. Editing needs a small server to write `presets.json`.
3. **Home Assistant stays?** The plan assumes yes, since it only handles the TV and music.
