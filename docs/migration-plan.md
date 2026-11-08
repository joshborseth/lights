# Migration plan: Foldkit lights app

Replace Windfront, the Zigbee2MQTT web UI, with a small Foldkit app as the everyday way to control the lights on Josh's dev box.

## What runs today

| Piece                                      | What it does                                                                                         | Plan                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- | --------------------- |
| Zigbee2MQTT 2.14.2 and the USB coordinator | Talks to the 7 bulbs and owns 5 groups: All Lights, Rest of the House, Bedroom, Living Room, Kitchen | Keep                  |
| Mosquitto                                  | MQTT broker for Zigbee2MQTT and the scripts below                                                    | Keep                  |
| `presets.mjs` extension and `presets.json` | 10 presets, including the coordinator-driven Rainbow loop                                            | Keep                  |
| Windfront 2.15.0                           | Today's lights UI, bundled with Zigbee2MQTT                                                          | Replace for daily use |
| 9 PM all-off timer                         | Publishes to MQTT                                                                                    | Keep, unaffected      |
| PR-merge purple flash                      | Runs in the automations service, see below                                                           | Replaced              |
| Home Assistant, Music Assistant            | TV and music only. Home Assistant has no MQTT integration, so it does not control these lights       | Out of scope          |

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
- The screen is one tree built from Zigbee2MQTT's groups: a group nests under the smallest group that fully contains it. A group that cuts across the tree, such as one spanning two rooms, is listed separately. Every level has the same controls.
- The UI uses [foldcn](https://foldcn.elianiva.com) components, copied into `src/components/ui/`. Its Slider handles brightness and temperature with large touch targets. Only the slider being dragged keeps state, in `maybeActiveSlider`, so no bulb needs its own Slider Submodel. Foldcn has no color picker, so color stays a native input.

The app installs to a phone's home screen as a PWA. `pwa/service-worker.js` caches only the app's own built files, so the app opens without the tailnet and then reports that it cannot connect. It never touches `/api` or `/automations`, and it never queues a command. The build generates `sw.js` from it. When the app returns to the foreground after 5 seconds or more, it replaces its socket, because a suspended phone can leave a socket that looks connected but is dead.

The app has two tabs, Lights and Automations, kept in the Model. It needs no client-side routes and no server fallback for deep links.

The Automations tab has three screens, also kept in the Model: a list with one row per automation, a detail page, and Connections for what automations share (GitHub, lights, the service). Unsaved edits stay in one save bar across screens.

### Automations service

The Lights tab still needs no backend. The Automations tab does, because Zigbee2MQTT's socket only relays what Zigbee2MQTT itself publishes, and something must keep watching GitHub when no browser is open.

```
Browser  --- /automations ---> Tailscale Serve (tailnet only)
                                  |
                       lights-automations (Bun, 127.0.0.1:8093)
                          |                 |
                     GitHub API        MQTT broker  ->  bulbs
```

`service/` is one always-on user service, `lights-automations`. The watcher and its API live in the same process, so the app controls the watcher without needing permission to manage systemd. If the process dies, systemd restarts it and the tab shows "Not responding" until it returns.

- `src/automation.ts` holds the settings and status types and the validation shared by the service and the app. The service validates every save with it.
- Settings: `~/.config/pr-merge-lights/config.json`. MQTT login: `mqtt.env` in the same folder. It is never sent to the browser.
- State: `~/.local/state/pr-merge-lights/` holds `seen.json`, `control.json`, and `activity.json`.
- GitHub logins come from `gh auth token --user <account>`, read once and refreshed on a 401. Unchanged event feeds use ETags, which do not count against the rate limit.
- Writes must be JSON, which makes browsers preflight them. The service answers no preflights, so other sites cannot send commands.
- A merge older than the catch-up window is recorded but never flashes, so downtime or a newly added account cannot replay old merges.

Deploy with `scripts/deploy-automations.sh`. The Python watcher it replaced was deleted on 2026-11-08. The 9 PM all-off timer still runs `~/pr-merge-lights/lights_off.py`, so keep that folder.

## Rules for commands to the bulbs

The existing scripts learned these the hard way, and the app has to follow them:

- **Off is exactly `{"state":"OFF"}`.** Any `transition` key, even 0, makes Zigbee2MQTT send a level-0 move instead, and several bulbs stay on at minimum brightness.
- **Never send `transition` for color.** IKEA bulbs freeze and drop new colors until a fade finishes.
- **Throttle sliders to one command per 400 ms, and always send the final value.** Faster updates get dropped.
- **Apply presets with `preset/set`.** Send `{"name": ..., "group": ...}` for All Lights or Rest of the House, or `{"name": ..., "light": ...}` for one bulb. The extension refuses other groups, and any `light` that Zigbee2MQTT does not report as a light.
- **The Bedroom group has no presets, on purpose.** Do not offer them there. Each bedroom bulb can still take a preset on its own.
- **Offer a bulb only the presets it can show.** A Color or Rainbow preset needs color support, and a White preset needs color temperature.
- **Any other command to a target stops every Rainbow loop that shares a bulb with it.** That is the intended way to end it. A command to one bulb stops a Rainbow on a group that contains it, and a command to a group stops loops on its bulbs and on groups that overlap it. Groups that share no bulb are left alone.
- **A preset ends any Rainbow loop that overlaps its target.** Without this, the loop repaints the target on its next frame. A preset on one bulb stops a Rainbow on a group that contains it, and the other bulbs hold their last color.
- **Send On and Off twice, 400 ms apart, for groups and bulbs.** A Rainbow frame already in flight can undo the first one, and the repeat reaches bulbs that missed it.
- **Show reported state, not assumed state.** A slider may lead while dragging, but the next state frame from the bulb wins.
- **A group slider keeps its own level.** It moves when dragged, and otherwise only when every bulb in the group, on or off, has ended up above it or below it. It then moves to the nearest bulb.
- **Stop a Rainbow loop with hue and saturation, not hex.** The extension treats a group command carrying a recent Rainbow hex as its own echo and keeps looping. Per-light commands never stop the loop.

## Milestones

Windfront stays available until the cutover.

### 0-4. Built and deployed (2026-11-08)

- Live view with automatic reconnect, plus controls for each bulb and group.
- Preset apply, create, edit, and delete. Rainbow cannot be edited or deleted.
- `extension/presets.mjs` is the source for the live extension. It adds a retained `preset/list` topic and `preset/save` and `preset/delete` commands, so preset editing needs no separate server.
- Published on a tailnet-only port with Tailscale Serve, with `/api` proxied to Zigbee2MQTT. The WebSocket path was tested through Serve.

Deploy the app with `scripts/deploy.sh`. Hot-load the extension with `node scripts/deploy-extension.mjs`. When a change spans both, load the extension first: an older extension treats a bulb preset as a preset for All Lights.

**Still to do:** the first run against real bulbs, with Josh watching. All testing so far used recorded frames and preset saves, so no light commands have been sent.

Then use it from the phone for about a week.

### 5. Cutover

- Change the Zigbee2MQTT port mapping in `/srv/homeassistant/compose.yaml` to `127.0.0.1:8080:8080`, and recreate that container. Expect a short Zigbee outage.
- Update the Zigbee2MQTT section of that folder's README.
- Open Windfront through a tailnet-only proxy when a bulb needs pairing.

**Rollback:** restore the port line. Nothing else changes, because the app holds no state of its own.

## Decisions

- The app is tailnet only.
- Presets can be edited in the app.
- Home Assistant stays for the TV and music.
- Automations run in a small tailnet-only service, because they must keep running with no browser open.
