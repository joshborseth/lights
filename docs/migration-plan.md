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

Windfront cannot be uninstalled. Zigbee2MQTT's WebSocket API comes from its frontend extension, so `frontend.enabled` stays `true`. The swap means nobody needs to open Windfront: the Devices page pairs new bulbs and edits groups.

## Architecture

```
Browser (Foldkit SPA)
   | same-origin WebSocket, /api
lights-lan (Bun, http://192.168.1.67:8445)  --- static files from dist/
   |
Zigbee2MQTT /api  ->  Zigbee radio
```

`lights-lan` only serves files and relays requests, so there is no application backend. Zigbee2MQTT already sends every device, group, and state change over its WebSocket as `{ topic, payload }`, and accepts commands in the same shape. A read-only connection test confirmed this against the live system: `bridge/devices`, `bridge/groups` (with scenes), and per-light state all arrive on connect.

Foldkit pieces, following the `websocket-chat` example this repo was scaffolded from:

- `ManagedResource` owns the socket, and the Model decides when it is live.
- A `Subscription` turns frames into Messages.
- A `Command` sends each light command.
- Effect `Schema` decodes each known topic at the boundary. Unknown topics are ignored.
- The screen is one tree built from Zigbee2MQTT's groups: a group nests under the smallest group that fully contains it. A group that cuts across the tree, such as one spanning two rooms, is listed separately. Every level has the same controls.
- The UI uses [foldcn](https://foldcn.elianiva.com) components, copied into `src/components/ui/`. Its Slider handles brightness and temperature with large touch targets. Only the slider being dragged keeps state, in `maybeActiveSlider`, so no bulb needs its own Slider Submodel. Foldcn has no color picker, so color stays a native input.

The app can be added to a phone's home screen. `pwa/service-worker.js` is inactive, because browsers allow service workers only over HTTPS and the app is served over plain HTTP. If the app moves back to HTTPS, it caches only the app's own built files, never touches `/api` or `/automations`, and never queues a command. When the app returns to the foreground after 5 seconds or more, it replaces its socket, because a suspended phone can leave a socket that looks connected but is dead.

The main screen is the house: a full-screen 3D cutaway of the home that the user controls directly. Automations and Devices are buttons that open full-screen pages over it, and Scenes has its own editing page. `screen` and `focus` in the Model hold where the user is, so the app needs no client-side routes and no server fallback for deep links.

The house has three levels of focus, and each one shows only what it can act on:

- **Overview.** Each room with lights floats a control pinned to that spot in the 3D view: tap its orb to toggle the room, tap its name or the room itself to go in. A dock offers All off and whole-house Scenes.
- **Room.** The camera flies in, rooms between it and the camera are cut away, and the rest dim. A sheet (a side panel on wide screens) holds power, brightness, temperature, color, and that room's scenes. Each bulb appears as a button at its real fixture.
- **Bulb.** The same sheet, for one bulb.

Rooms use their Zigbee2MQTT group when it has bulbs in it. A room without one, such as a Kitchen group left empty, sends the same command to each of its bulbs, so every command still follows the rules below.

- The floor plan in `src/housePlan.ts` is estimated from photos of the living room, kitchen, stairs, bedroom, closet, and bathroom, so sizes are approximate. There is no hallway: the bedroom door opens straight off the great room. The walk-in closet is its own room in the bedroom's southwest corner, behind open double doors, with its own light space so its bulb lights the bedroom only through the doorway. The nook east of it, with the hamper and the UFO light, is an annex of the bedroom. The bathroom door is on the kitchen wall, and its position along that wall is inferred. The bathroom keeps its modeled outline, so its walkway and tub are drawn shorter than they really are. Each room lists its furniture and the fixtures that hold bulbs.
- A bulb goes in the room whose non-empty group contains it, then the room its name starts with, and otherwise the Stairs. A room inside another, such as the Closet inside the Bedroom, then takes the bulb if the bulb is in its group or named after it, so the Closet bulb can stay in the Bedroom group. The Bedroom controls still drive it through that group. Within a room, bulbs take the fixtures in name order, and any extras stand on their own.
- `src/houseElement.ts` is a custom element that takes the bulbs and focus as properties and reports taps as events. `src/houseScene.ts` holds the three.js renderer and loads as its own chunk, so the first paint does not wait for it. The floating controls are ordinary view elements inside it, marked with `data-anchor`, and the renderer only sets their screen position.
- `src/houseControls.ts` turns touch, mouse, and wheel input into camera moves, in place of three.js OrbitControls. It listens on the whole scene element, so a drag or pinch that starts on a floating control still moves the camera, and a drag never presses the control. Pinch and wheel zoom toward the spot under the fingers. When zoomed in, the pivot can drift toward the edge of the focused area, and it returns to the middle as the view zooms back out. Turning and zooming glide after release, and the zoom limits give a little and spring back. A touch while the camera is moving, whether gliding or flying, only stops it: the flight lands at once, and the touch does not count as a tap. Changing focus within the same room, or resizing, keeps the user's zoom and tilt. Changing room frames the new room from scratch.
- Each bulb has a shadow map baked once from the static house, so walls block light, light spills through doorways, and furniture casts shadows. A separate fill term reaches only surfaces in the bulb's own light space. Shadows sample fixed directions around each bulb, so they hold still while the camera moves, and only shadow edges take the full set of samples. Frames are drawn only when something moves or fades.
- The scene shows reported state, except that a drag previews in the house as well as on the slider until the bulb reports back.

The Automations page has three screens, also kept in the Model: a list with one row per automation, a detail page, and Connections for what automations share (GitHub, lights, the service). Unsaved edits stay in one save bar across screens.

The Devices page pairs bulbs, renames and removes them, moves them between groups, and creates, renames, and removes groups. It uses Zigbee2MQTT's `bridge/request/*` API over the same socket, so it needs no backend.

- Each change is a plan of requests, sent one at a time. The next one goes out only when `bridge/response/*` reports the previous one succeeded. Requests carry a `transaction` tagged per app instance, so a second open app can't confirm them.
- A device whose friendly name is still its address is waiting for setup. That comes from `bridge/devices`, so it survives a reload. The pairing window comes from the retained `bridge/info`.
- Groups nest only through shared bulbs, so moving a bulb also updates the groups around its old and new room. `moveLightChange` and its neighbors in `src/domain.ts` hold those rules. Adding to an empty group changes only that group, because it has no place in the tree yet.
- Renaming a group also updates the PR flash, Music colors, and Screen colors if they pointed at that group.

### Automations service

The house and its controls need no backend. The Automations page does, because Zigbee2MQTT's socket only relays what Zigbee2MQTT itself publishes, and something must keep watching GitHub when no browser is open.

```
Browser  --- /automations ---> lights-lan
                                  |
                       lights-automations (Bun, 127.0.0.1:8093)
                          |                 |
                     GitHub API        MQTT broker  ->  bulbs
```

`service/` is one always-on user service, `lights-automations`. The watcher and its API live in the same process, so the app controls the watcher without needing permission to manage systemd. If the process dies, systemd restarts it and the page shows "Not responding" until it returns.

- `src/automation.ts` holds the settings and status types and the validation shared by the service and the app. The service validates every save with it.
- Settings: `~/.config/pr-merge-lights/config.json`. MQTT login: `mqtt.env` in the same folder. It is never sent to the browser.
- State: `~/.local/state/pr-merge-lights/` holds `seen.json`, `control.json`, and `activity.json`.
- GitHub logins come from `gh auth token --user <account>`, read once and refreshed on a 401. Unchanged event feeds use ETags, which do not count against the rate limit.
- Writes must be JSON, which makes browsers preflight them. The service answers no preflights, so other sites cannot send commands.
- A merge older than the catch-up window is recorded but never flashes, so downtime or a newly added account cannot replay old merges.

#### Music colors

While a song plays, the bulbs in one group take the color of its album cover. The music server (`~/.t3/projects/music`, `music.service`) sends each song and the one color its cover reads as (the same color its full player is tinted with) over a WebSocket, `ws://127.0.0.1:4310/now-playing` (override with `MUSIC_FEED_URL`). `service/music.ts` listens there and reconnects every 5 seconds when it can't.

- Off by default. Settings save as soon as they change, with no save bar, to `~/.config/pr-merge-lights/music.json`, and are served at `/automations/music`.
- On the TV the bulbs change with the music. The service tells the music server whose songs it follows (`Follow`: `Tv`, `Tv` and `Web`, or nothing while off), on every connect and every settings change. While it follows the TV, the TV holds each song it jumps to until the song is loaded and its color known (at most 3 seconds), then starts it, and the frame carries a `cue` for that moment. A song that follows the last with no gap gets its `cue` about half a second ahead. A cue is painted at its moment, with no waiting, and a new cue or none cancels one still pending.
- Anything without a cue (music on a phone, a music server built before cues) must stay current for 1.5 seconds before the bulbs follow it, so a run of skips doesn't flicker them. Each song is applied once; changing a setting applies it again to the song already playing.
- Only bulbs that are on change, and they all take the same color. Brightness stays where it is. The color goes as x and y with no `transition`, pushed to at least 70% saturation because bulbs wash pale colors out to white.
- A black, white, or grey cover (the music server sends `color: null`) sends `color_temp` 370 (warm white) to bulbs that take color temperature.
- Only on the TV (on by default) ignores music playing on a phone. A song skipped for that reason is applied when playback moves to the TV.
- It stops an overlapping Rainbow the way the flash does: a group command in x and y, twice. It runs under the flash's lock, so neither one restores colors over the other.
- Which bulbs take color or color temperature comes from `bridge/devices`, read the same way as the app's `toLight`.

#### Screen colors

While a film or show plays in Joshflix on the TV, the bulbs in one group take the color on screen. About once a second the TV sends a 48×27 copy of its picture to the Joshflix relay (`~/.t3/projects/joshflix`, `joshflix-relay.service`), which finds the one color it reads as and sends it over a read-only WebSocket, `ws://127.0.0.1:8788/api/v1/screen/feed` (override with `SCREEN_FEED_URL`). Frames look like `{"_tag":"ScreenColors","playing":true,"title":"Dune","color":"#c8742f"}`. `service/screen.ts` listens there and reconnects every 5 seconds when it can't.

- Off by default. Settings save as soon as they change, to `~/.config/pr-merge-lights/screen.json`, and are served at `/automations/screen`.
- The service connects to the feed only while Screen colors is on. The TV reads its picture only while someone listens, so turning it off also stops the TV's work.
- The relay smooths the color: a new one goes out only after the picture's color has clearly changed and held for 1.5 seconds, and at most every 2 seconds. The service then waits 400 ms more before it sends commands. Each color is applied once; after a pause or stop, the next color is applied again.
- Commands are Music colors' (`applyColor` in `service/music.ts`): only bulbs that are on change, all to the same color, as x and y with no `transition`, brightness untouched, Rainbow stopped the same way, under the same lock.
- A dark or grey picture (`color: null`), a pause, the end of a film, or the TV going quiet leaves the lights as they are. It never switches to warm white.

Deploy with `scripts/deploy-automations.sh`. The Python watcher it replaced was deleted on 2026-11-08. The 9 PM all-off timer still runs `~/pr-merge-lights/lights_off.py`, so keep that folder.

## Rules for commands to the bulbs

The existing scripts learned these the hard way, and the app has to follow them:

- **Off is exactly `{"state":"OFF"}`.** Any `transition` key, even 0, makes Zigbee2MQTT send a level-0 move instead, and several bulbs stay on at minimum brightness.
- **Never send `transition` for color.** IKEA bulbs freeze and drop new colors until a fade finishes.
- **After turning a color bulb back on, send its color again by itself.** IKEA bulbs can drop a color that arrives while they fade on, and Zigbee2MQTT still reports the color it sent. The PR flash restores each bulb, waits 1.2 seconds, and repeats a color-only command twice.
- **The PR flash sends color as x and y, never hue and saturation.** The kitchen's KAJPLATS bulbs have no hue and saturation mode. After a hue and saturation command they stay on that color while acknowledging x and y commands, and Zigbee2MQTT reports the color it sent. A color temperature command clears it.
- **Before a flash, ask a bulb only for `state`.** Zigbee2MQTT replies with the brightness and color the bulb was last given. A brightness read from the bulb can be its minimum after a quick off and on, and the flash would then restore it almost dark.
- **Throttle sliders to one command per 400 ms, and always send the final value.** Faster updates get dropped.
- **Apply presets with `preset/set`.** Send `{"name": ..., "group": ...}` for any group, or `{"name": ..., "light": ...}` for one bulb. The extension refuses any `group` that Zigbee2MQTT does not report as a group, and any `light` that it does not report as a light.
- **Offer a bulb only the presets it can show.** A Color or Rainbow preset needs color support, and a White preset needs color temperature.
- **Any other command to a target stops every Rainbow loop that shares a bulb with it.** That is the intended way to end it. A command to one bulb stops a Rainbow on a group that contains it, and a command to a group stops loops on its bulbs and on groups that overlap it. Groups that share no bulb are left alone.
- **A preset ends any Rainbow loop that overlaps its target.** Without this, the loop repaints the target on its next frame. A preset on one bulb stops a Rainbow on a group that contains it, and the other bulbs hold their last color.
- **Send On and Off twice, 400 ms apart, for groups and bulbs.** A Rainbow frame already in flight can undo the first one, and the repeat reaches bulbs that missed it.
- **Show reported state, not assumed state.** A slider may lead while dragging, but the next state frame from the bulb wins.
- **A group slider keeps its own level.** It moves when dragged, and otherwise only when every bulb in the group, on or off, has ended up above it or below it. It then moves to the nearest bulb.
- **Stop a Rainbow loop with x and y, not hex.** The extension treats a group command carrying a recent Rainbow hex as its own echo and keeps looping. Per-light commands never stop the loop.

## Milestones

Windfront stays available until the cutover.

### 0-4. Built and deployed (2026-11-08)

- Live view with automatic reconnect, plus controls for each bulb and group.
- Preset apply, create, edit, and delete. Rainbow cannot be edited or deleted.
- `extension/presets.mjs` is the source for the live extension. It adds a retained `preset/list` topic and `preset/save` and `preset/delete` commands, so preset editing needs no separate server.
- Published on a tailnet-only port with Tailscale Serve, with `/api` proxied to Zigbee2MQTT. The WebSocket path was tested through Serve. `lights-lan` has since replaced this; see Decisions.

Deploy the app with `scripts/deploy.sh`. Hot-load the extension with `node scripts/deploy-extension.mjs`. When a change spans both, load the extension first: an older extension treats a bulb preset as a preset for All Lights.

**Still to do:** the first run against real bulbs, with Josh watching. All testing so far used recorded frames and preset saves, so no light commands have been sent.

Then use it from the phone for about a week.

### 5. Cutover

- Change the Zigbee2MQTT port mapping in `/srv/homeassistant/compose.yaml` to `127.0.0.1:8080:8080`, and recreate that container. Expect a short Zigbee outage.
- Update the Zigbee2MQTT section of that folder's README.
- Open Windfront through a tailnet-only proxy only for what the Devices page doesn't cover, such as firmware updates.

**Rollback:** restore the port line. Nothing else changes, because the app holds no state of its own.

## Decisions

- The app has one address, `http://192.168.1.67:8445`, served by `service/lan-main.ts`. Anyone on the home network can use it. Away from home, tailnet devices reach it through a subnet route for `192.168.1.67/32`, and the server also answers on the machine's Tailscale IP. Plain HTTP means no service worker.
- Presets can be edited in the app.
- Home Assistant stays for the TV and music.
- Automations run in a small service on loopback, reached through `lights-lan`, because they must keep running with no browser open.
- The everyday control surface is the 3D house, not a list of switches.
