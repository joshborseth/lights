import { Array, Match, Option, pipe } from 'effect'
import { Document, Html, HtmlBuilder } from 'foldkit/html'
import {
  ChevronLeft,
  type IconNode,
  Palette,
  Pencil,
  Plus,
  Power,
  Settings2,
  Sparkles,
  Sun,
  Thermometer,
  X,
  Zap,
} from 'lucide'

import { Alert } from '@/components/ui/alert'
import { badge } from '@/components/ui/badge'
import { button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Empty } from '@/components/ui/empty'
import { input } from '@/components/ui/input'
import * as Slider from '@/components/ui/slider'
import { spinner } from '@/components/ui/spinner'
import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { type Message as AutomationsMessage } from './automations'
import * as AutomationsView from './automationsView'
import {
  type Light,
  MAX_BRIGHTNESS,
  type Preset,
  PresetLook,
  SavablePresetLook,
  Setting,
  WARM_WHITE,
  shortLightName,
} from './domain'
import { type HouseBulb, HouseFocus, placedBulbs, roomById } from './house'
import { houseSceneSpec } from './houseElement'
import { type HouseRoom, ROOMS } from './housePlan'
import {
  type Activity,
  Connection,
  type EditingPreset,
  Message,
  type Model,
  PRESET_COLOR_TEMP_RANGE,
  PresetEditor,
  type Screen,
  SliderId,
  Startup,
  Target,
  type TargetStatus,
  activityOf,
  canControl,
  draftSetting,
  isEditorBusy,
  isMixed,
  isStrugglingToConnect,
  presetEditorProblem,
  roomLights,
  roomTarget,
  sliderDomId,
  sliderModelOf,
  statesWithDrafts,
  targetStatus,
  wholeHouseTarget,
} from './main'
import { type Message as ManageMessage } from './manage'
import * as ManageView from './manageView'
import { sheetGrabberSpec } from './sheetGrabber'

const MIN_GLOW_LEVEL = 0.3
const OFF_GLOW = 'oklch(0.42 0.008 70)'
const ROOM_ANCHOR_HEIGHT = 0.9

const CAPTION = 'text-xs text-muted-foreground'
const GLASS =
  'bg-[oklch(0.17_0.012_265/0.72)] ring-1 ring-white/10 backdrop-blur-xl'
const ROUND_GLASS_BUTTON = cn(
  GLASS,
  'pointer-events-auto grid size-11 place-items-center rounded-full text-foreground transition-transform active:scale-95',
)
const ANCHOR =
  'pointer-events-auto absolute top-0 left-0 invisible will-change-transform data-placed:visible'
const COLOR_INPUT =
  'h-11 w-full cursor-pointer rounded-lg border border-input bg-transparent p-1 [&::-moz-color-swatch]:rounded-md [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch]:rounded-md [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0'
const SHEET = cn(
  'fixed inset-x-0 bottom-0 z-30 flex max-h-[62dvh] animate-in flex-col gap-4 overflow-y-auto overscroll-contain rounded-t-[1.75rem] px-5 pt-5 pb-[max(env(safe-area-inset-bottom),1.25rem)] duration-300 ease-out fade-in slide-in-from-bottom-6',
  'bg-[oklch(0.17_0.012_265/0.86)] ring-1 ring-white/10 backdrop-blur-2xl',
  'no-scrollbar md:top-4 md:right-4 md:bottom-auto md:left-auto md:max-h-[calc(100dvh-2rem)] md:w-96 md:rounded-[1.75rem] md:pb-5 md:slide-in-from-right-6 md:slide-in-from-bottom-0',
)
const PAGE =
  'fixed inset-0 z-40 animate-in overflow-y-auto overscroll-contain bg-background duration-200 ease-out fade-in slide-in-from-bottom-3'
const PAGE_COLUMN =
  'mx-auto max-w-xl pr-[max(env(safe-area-inset-right),1rem)] pl-[max(env(safe-area-inset-left),1rem)]'
const SECTION = 'flex flex-col gap-3'
const SECTION_TITLE = 'px-1 text-sm font-medium text-muted-foreground'
const PRIMARY_GLOW_FILL = 'slider-fill [--glow:var(--primary)] [--level:0.6]'

const brightnessPercent = (brightness: number): number =>
  Math.max(1, Math.round((brightness / MAX_BRIGHTNESS) * 100))

const formatPercent = (brightness: number): string =>
  `${brightnessPercent(brightness)}%`

const WARM_FROM_MIREDS = 286
const COOL_UP_TO_MIREDS = 200

const temperatureName = (mireds: number): string => {
  if (mireds >= WARM_FROM_MIREDS) {
    return 'Warm'
  }
  return mireds <= COOL_UP_TO_MIREDS ? 'Cool' : 'Neutral'
}

const onCount = (model: Model, lights: ReadonlyArray<Light>): number =>
  Array.filter(lights, light => model.states[light.name]?.power === 'ON').length

const glowColor = (status: TargetStatus): string =>
  status.isOn ? Option.getOrElse(status.maybeHex, () => WARM_WHITE) : OFF_GLOW

const glowLevel = (status: TargetStatus): number =>
  status.isOn ? Math.max(MIN_GLOW_LEVEL, status.brightness / MAX_BRIGHTNESS) : 0

const glowAttribute = (status: TargetStatus, h: HtmlBuilder<Message>) =>
  h.Style({
    '--glow': glowColor(status),
    '--level': String(glowLevel(status)),
  })

const isReady = (model: Model): boolean => model.startup._tag === 'Ready'

const isSettingPower = (model: Model, target: Target): boolean =>
  Option.exists(
    activityOf(model, target),
    activity => activity._tag === 'SettingPower',
  )

const isBusyActivity = (maybeActivity: Option.Option<Activity>): boolean =>
  Option.exists(maybeActivity, activity => activity._tag !== 'NoResponse')

const hasNoResponse = (model: Model, target: Target): boolean =>
  Option.exists(
    activityOf(model, target),
    activity => activity._tag === 'NoResponse',
  )

const shownBrightness = (
  model: Model,
  target: Target,
  status: TargetStatus,
): number =>
  Option.match(draftSetting(model, target, 'Brightness'), {
    onNone: () => status.brightness,
    onSome: setting =>
      Setting.match(setting, {
        Brightness: ({ value }) => value,
        ColorTemp: () => status.brightness,
        Color: () => status.brightness,
      }),
  })

const targetLevelLabel = (
  model: Model,
  target: Target,
  status: TargetStatus,
): string => {
  if (!status.hasReported) {
    return 'Not reporting'
  }
  return status.isOn
    ? `${formatPercent(shownBrightness(model, target, status))} brightness`
    : 'Off'
}

const roomStateLabel = (
  model: Model,
  lights: ReadonlyArray<Light>,
  status: TargetStatus,
): string => {
  if (!status.hasReported) {
    return 'Not reporting'
  }
  const count = onCount(model, lights)
  if (count === 0) {
    return 'Off'
  }
  if (lights.length === 1) {
    return 'On'
  }
  return count === lights.length ? 'All on' : `${count} of ${lights.length} on`
}

// ROOT

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: 'Lights',
  body: h.main(
    [h.Class('fixed inset-0 overflow-hidden bg-background')],
    [
      Option.match(model.maybeHouseFailure, {
        onNone: () => houseStageView(model, h),
        onSome: reason => roomListStageView(model, reason, h),
      }),
      ...(model.screen === 'House'
        ? [topBarView(model, h), dockView(model, h), sheetView(model, h)]
        : []),
      messageView(model, h),
      screenView(model, h),
    ],
  ),
})

// STAGE

const houseStageView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const bulbs = placedBulbs(model.lights, model.groups, statesWithDrafts(model))
  const scene = houseSceneSpec.withMessage(h)
  return scene(
    [
      scene.Bulbs(bulbs),
      scene.HouseFocus(model.focus),
      scene.OnPickedBulb(({ name }) => Message.PickedHouseBulb({ name })),
      scene.OnPickedRoom(({ roomId }) => Message.PickedHouseRoom({ roomId })),
      scene.OnClearedPick(() => Message.ClearedHousePick()),
      scene.OnFailedScene(({ reason }) => Message.FailedHouseScene({ reason })),
      h.Role('group'),
      h.AriaLabel('3D view of the house'),
      h.Class('house-stage absolute inset-0 block touch-none'),
    ],
    isReady(model) && model.screen === 'House'
      ? anchorViews(model, bulbs, h)
      : [],
  )
}

const anchorAttributes = (
  id: string,
  x: number,
  y: number,
  z: number,
  h: HtmlBuilder<Message>,
) => [
  h.DataAttribute('anchor', id),
  h.DataAttribute('anchor-x', String(x)),
  h.DataAttribute('anchor-y', String(y)),
  h.DataAttribute('anchor-z', String(z)),
]

const focusedRoom = (
  focus: HouseFocus,
  bulbs: ReadonlyArray<HouseBulb>,
): Option.Option<HouseRoom> =>
  HouseFocus.match(focus, {
    Overview: () => Option.none(),
    Scenes: () => Option.none(),
    Room: ({ roomId }) => roomById(roomId),
    Bulb: ({ name }) =>
      pipe(
        Array.findFirst(bulbs, bulb => bulb.name === name),
        Option.flatMap(bulb => roomById(bulb.roomId)),
      ),
  })

const anchorViews = (
  model: Model,
  bulbs: ReadonlyArray<HouseBulb>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const isLive = canControl(model)
  return Option.match(focusedRoom(model.focus, bulbs), {
    onNone: () =>
      model.focus._tag === 'Overview'
        ? Array.map(ROOMS, room => roomPillView(model, room, isLive, h))
        : [],
    onSome: room =>
      Array.map(
        Array.filter(bulbs, bulb => bulb.roomId === room.id),
        bulb => bulbPuckView(model, room, bulb, h),
      ),
  })
}

const roomPillBody = (
  model: Model,
  room: HouseRoom,
  target: Target,
  isLive: boolean,
  h: HtmlBuilder<Message>,
): Html => {
  const status = targetStatus(model, target)
  return h.div(
    [
      h.Class(
        cn(
          GLASS,
          'glow-transition flex h-10 translate-x-(--spread-x) items-center gap-1 rounded-full pr-3 pl-1 shadow-lg shadow-black/30',
          !isLive && 'opacity-60',
        ),
      ),
      glowAttribute(status, h),
      h.Inert(!isLive),
    ],
    [
      powerOrbView(
        target,
        room.label,
        status,
        isSettingPower(model, target),
        'size-8',
        'size-3.5',
        h,
      ),
      h.button(
        [
          h.Type('button'),
          h.AriaLabel(`${room.label} controls`),
          h.OnClick(Message.PickedHouseRoom({ roomId: room.id })),
          h.Class('flex h-full flex-col justify-center pl-1 text-left'),
        ],
        [
          h.span(
            [h.Class('text-xs leading-tight font-medium whitespace-nowrap')],
            [room.label],
          ),
          h.span(
            [
              h.Class(
                'text-[10px] leading-tight text-muted-foreground tabular-nums',
              ),
            ],
            [
              hasNoResponse(model, target)
                ? 'No response'
                : roomStateLabel(model, roomLights(model, room), status),
            ],
          ),
        ],
      ),
    ],
  )
}

const roomPillView = (
  model: Model,
  room: HouseRoom,
  isLive: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(roomTarget(model, room), {
    onNone: () => h.empty,
    onSome: target =>
      h.keyed('div')(
        room.id,
        [
          ...anchorAttributes(
            room.id,
            room.labelSpot.x,
            ROOM_ANCHOR_HEIGHT,
            room.labelSpot.z,
            h,
          ),
          h.Class(ANCHOR),
        ],
        [roomPillBody(model, room, target, isLive, h)],
      ),
  })

const bulbPuckLabel = (
  model: Model,
  room: HouseRoom,
  bulb: HouseBulb,
): string =>
  pipe(
    Array.findFirst(model.lights, light => light.name === bulb.name),
    Option.match({
      onNone: () => bulb.name,
      onSome: light => shortLightName(roomLights(model, room), light),
    }),
  )

const bulbPuckView = (
  model: Model,
  room: HouseRoom,
  bulb: HouseBulb,
  h: HtmlBuilder<Message>,
): Html => {
  const target = Target.Light({ name: bulb.name })
  const status = targetStatus(model, target)
  const isSelected =
    model.focus._tag === 'Bulb' && model.focus.name === bulb.name
  return h.keyed('button')(
    bulb.name,
    [
      ...anchorAttributes(bulb.name, bulb.x, bulb.y, bulb.z, h),
      h.Type('button'),
      h.AriaLabel(bulb.name),
      h.AriaPressed(String(isSelected)),
      h.OnClick(Message.PickedHouseBulb({ name: bulb.name })),
      h.Class(
        cn(ANCHOR, 'glow-transition flex flex-col items-center gap-1 pt-2'),
      ),
      glowAttribute(status, h),
    ],
    [
      h.span([
        h.Class(
          cn(
            'size-6 rounded-full transition-transform',
            status.isOn
              ? 'bg-(--glow) shadow-[0_0_20px_var(--glow)]'
              : 'bg-white/15',
            isSelected ? 'scale-115 ring-3 ring-white' : 'ring-2 ring-white/60',
          ),
        ),
      ]),
      h.span(
        [
          h.Class(
            cn(
              GLASS,
              'max-w-28 translate-x-(--spread-x) truncate rounded-full px-2 py-0.5 text-[11px] font-medium',
              isSelected && 'bg-white text-black',
            ),
          ),
        ],
        [bulbPuckLabel(model, room, bulb)],
      ),
    ],
  )
}

const roomListStageView = (
  model: Model,
  reason: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Class(
        'house-stage absolute inset-0 flex flex-col justify-center gap-4 px-6',
      ),
    ],
    [
      Alert<Message>(
        {},
        [
          Alert.description<Message>(
            {},
            [
              `The 3D view couldn't start on this device: ${reason}. The rooms below still work.`,
            ],
            h,
          ),
        ],
        h,
      ),
      h.div(
        [h.Class('flex flex-wrap justify-center gap-2')],
        Array.map(ROOMS, room =>
          Option.match(roomTarget(model, room), {
            onNone: () => h.empty,
            onSome: target =>
              h.keyed('div')(
                room.id,
                [],
                [roomPillBody(model, room, target, canControl(model), h)],
              ),
          }),
        ),
      ),
    ],
  )

// TOP BAR

const connectionLabel = (model: Model): string =>
  Startup.match(model.startup, {
    Loading: () => 'Connecting…',
    Ready: () =>
      Connection.match(model.connection, {
        Connecting: () => 'Reconnecting…',
        WaitingToReconnect: () => 'Reconnecting…',
        Connected: () => (model.isBridgeOnline ? 'Live' : 'Zigbee offline'),
      }),
  })

const connectionDotClass = (model: Model): string =>
  model.startup._tag === 'Loading' || model.connection._tag !== 'Connected'
    ? 'animate-pulse bg-primary'
    : model.isBridgeOnline
      ? 'bg-emerald-400'
      : 'bg-destructive'

const SCREEN_BUTTONS: ReadonlyArray<
  Readonly<{ screen: Screen; label: string; node: IconNode }>
> = [
  { screen: 'Automations', label: 'Automations', node: Zap },
  { screen: 'Devices', label: 'Devices', node: Settings2 },
]

const houseSummary = (model: Model): string =>
  model.startup._tag === 'Loading' || Array.isReadonlyArrayEmpty(model.lights)
    ? 'Lights'
    : `${onCount(model, model.lights)} of ${model.lights.length} on`

const backToOverviewView = (h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type('button'),
      h.AriaLabel('Back to the whole house'),
      h.OnClick(Message.ClearedHousePick()),
      h.Class(ROUND_GLASS_BUTTON),
    ],
    [icon(h, ChevronLeft, 'size-5')],
  )

const summaryView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('drop-shadow-[0_1px_8px_rgb(0_0_0/0.6)]')],
    [
      h.h1(
        [h.Class('text-2xl font-semibold tracking-tight tabular-nums')],
        [houseSummary(model)],
      ),
      h.p(
        [
          h.Role('status'),
          h.Class(
            'mt-0.5 flex items-center gap-1.5 text-xs text-foreground/70',
          ),
        ],
        [
          h.span([
            h.Class(`size-1.5 rounded-full ${connectionDotClass(model)}`),
          ]),
          connectionLabel(model),
        ],
      ),
    ],
  )

const topBarView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const isInRoom = model.focus._tag === 'Room' || model.focus._tag === 'Bulb'
  return h.div(
    [
      h.Class(
        'pointer-events-none absolute inset-x-0 top-0 z-20 flex items-start justify-between bg-linear-to-b from-black/45 to-transparent pt-[max(calc(env(safe-area-inset-top)+0.5rem),1rem)] pr-[max(env(safe-area-inset-right),1rem)] pb-10 pl-[max(env(safe-area-inset-left),1.25rem)]',
      ),
    ],
    [
      isInRoom ? backToOverviewView(h) : summaryView(model, h),
      isInRoom
        ? h.empty
        : h.div(
            [h.Class('flex gap-2')],
            Array.map(SCREEN_BUTTONS, ({ screen, label, node }) =>
              h.keyed('button')(
                screen,
                [
                  h.Type('button'),
                  h.AriaLabel(label),
                  h.OnClick(Message.ClickedOpenScreen({ screen })),
                  h.Class(ROUND_GLASS_BUTTON),
                ],
                [icon(h, node, 'size-[18px]')],
              ),
            ),
          ),
    ],
  )
}

// MESSAGES

const messageView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Class(
        'pointer-events-none absolute inset-x-0 top-[calc(env(safe-area-inset-top)+6rem)] z-50 flex flex-col items-center gap-2 px-4',
      ),
    ],
    [
      Option.match(model.maybeProblem, {
        onNone: () => h.empty,
        onSome: problem =>
          h.div(
            [h.Class('pointer-events-auto max-w-md')],
            [
              Alert<Message>(
                { variant: 'destructive' },
                [Alert.description<Message>({}, [problem], h)],
                h,
              ),
            ],
          ),
      }),
      model.screen === 'House' ? startupNoticeView(model, h) : h.empty,
    ],
  )

const noticeCard = (
  title: string,
  description: string,
  withSpinner: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class(cn(GLASS, 'pointer-events-auto max-w-sm rounded-2xl p-4'))],
    [
      Empty<Message>(
        { className: 'p-0' },
        [
          Empty.header<Message>(
            {},
            [
              withSpinner
                ? Empty.media<Message>(
                    {},
                    [
                      spinner<Message>(
                        { className: 'size-5 text-muted-foreground' },
                        h,
                      ),
                    ],
                    h,
                  )
                : h.empty,
              Empty.title<Message>({}, [title], h),
              Empty.description<Message>({}, [description], h),
            ],
            h,
          ),
        ],
        h,
      ),
    ],
  )

const unreachableNotice = (h: HtmlBuilder<Message>): Html =>
  noticeCard(
    "Can't reach Zigbee2MQTT",
    'Still trying. Check that this device is on the home network or connected to Tailscale.',
    true,
    h,
  )

const startupNoticeView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Startup.match(model.startup, {
    Loading: () =>
      isStrugglingToConnect(model.connection)
        ? unreachableNotice(h)
        : h.p(
            [h.Class('sr-only')],
            [
              model.connection._tag === 'Connected'
                ? 'Loading your lights…'
                : 'Connecting to your lights…',
            ],
          ),
    Ready: () => {
      if (Array.isReadonlyArrayNonEmpty(model.lights)) {
        return reconnectingNoticeView(model, h)
      }
      return model.connection._tag === 'Connected'
        ? noticeCard(
            'No lights found',
            'Lights paired with Zigbee2MQTT show up here.',
            false,
            h,
          )
        : unreachableNotice(h)
    },
  })

const reconnectingNoticeView = (model: Model, h: HtmlBuilder<Message>): Html =>
  canControl(model)
    ? h.empty
    : h.div(
        [h.Class('delayed-reveal')],
        [
          badge<Message>(
            {
              variant: 'secondary',
              className: cn(GLASS, 'h-8 gap-2 px-3 shadow-lg'),
            },
            [
              spinner<Message>(
                { className: 'size-3.5 text-muted-foreground' },
                h,
              ),
              connectionLabel(model),
            ],
            h,
          ),
        ],
      )

// DOCK

const dockButton = (
  label: string,
  node: IconNode,
  message: Message,
  isPressed: Option.Option<boolean>,
  isBusy: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(message),
      ...Option.match(isPressed, {
        onNone: () => [],
        onSome: pressed => [h.AriaPressed(String(pressed))],
      }),
      h.Class(
        cn(
          GLASS,
          'pointer-events-auto flex h-14 items-center gap-2.5 rounded-full px-6 text-[15px] font-medium shadow-xl shadow-black/40 transition-transform active:scale-95',
        ),
      ),
    ],
    [
      h.span(
        [h.Class(cn(isBusy && 'pending-spinner pending-spinner-around'))],
        [icon(h, node, 'size-[18px]')],
      ),
      label,
    ],
  )

const dockView = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (
    model.focus._tag !== 'Overview' ||
    !isReady(model) ||
    Array.isReadonlyArrayEmpty(model.lights)
  ) {
    return h.empty
  }
  const isLive = canControl(model)
  return h.nav(
    [
      h.AriaLabel('Whole house'),
      h.Inert(!isLive),
      h.Class(
        cn(
          'pointer-events-none absolute inset-x-0 bottom-[max(env(safe-area-inset-bottom),1.25rem)] z-20 flex animate-in justify-center gap-2.5 duration-300 fade-in slide-in-from-bottom-3',
          !isLive && 'opacity-60',
        ),
      ),
    ],
    [
      Option.match(wholeHouseTarget(model), {
        onNone: () => h.empty,
        onSome: target => {
          const anyOn = targetStatus(model, target).isOn
          return dockButton(
            anyOn ? 'All off' : 'All on',
            Power,
            Message.ClickedPower({ target }),
            Option.none(),
            isSettingPower(model, target),
            h,
          )
        },
      }),
      dockButton(
        'Scenes',
        Sparkles,
        Message.ClickedScenes(),
        Option.none(),
        false,
        h,
      ),
    ],
  )
}

// SHEET

const sheetView = (model: Model, h: HtmlBuilder<Message>): Html => {
  if (!isReady(model)) {
    return h.empty
  }
  const bulbs = placedBulbs(model.lights, model.groups, model.states)
  return HouseFocus.match(model.focus, {
    Overview: () => h.empty,
    Scenes: () => scenesSheetView(model, h),
    Room: ({ roomId }) =>
      Option.match(roomById(roomId), {
        onNone: () => h.empty,
        onSome: room => roomSheetView(model, room, h),
      }),
    Bulb: ({ name }) =>
      Option.match(
        Array.findFirst(model.lights, light => light.name === name),
        {
          onNone: () => h.empty,
          onSome: light => bulbSheetView(model, light, bulbs, h),
        },
      ),
  })
}

const sheetFrame = (
  ariaLabel: string,
  isBusy: boolean,
  isLive: boolean,
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [
      h.AriaLabel(ariaLabel),
      h.AriaBusy(isBusy),
      h.DataAttribute('scene-panel', ''),
      h.Class(SHEET),
    ],
    [
      sheetGrabberView(h),
      h.div(
        [
          h.Class(
            cn(
              'flex flex-col gap-4 transition-opacity',
              !isLive && 'opacity-50',
            ),
          ),
          h.Inert(!isLive),
        ],
        children,
      ),
    ],
  )

const sheetGrabberView = (h: HtmlBuilder<Message>): Html => {
  const grabber = sheetGrabberSpec.withMessage(h)
  return grabber(
    [
      grabber.OnDismissed(() => Message.ClearedHousePick()),
      h.Class(
        '-mx-5 -mt-5 flex h-7 shrink-0 cursor-grab touch-none items-start justify-center pt-2.5 md:hidden',
      ),
    ],
    [h.span([h.Class('h-1 w-9 rounded-full bg-white/25')])],
  )
}

const closeSheetButton = (h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type('button'),
      h.AriaLabel('Close'),
      h.OnClick(Message.ClearedHousePick()),
      h.Class(
        'grid size-9 shrink-0 place-items-center rounded-full bg-white/8 text-muted-foreground hover:text-foreground',
      ),
    ],
    [icon(h, X, 'size-4')],
  )

const powerOrbView = (
  target: Target,
  label: string,
  status: TargetStatus,
  isPending: boolean,
  sizeClass: string,
  iconClass: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.Role('switch'),
      h.AriaChecked(status.isOn),
      h.AriaLabel(`${label} power`),
      h.AriaBusy(isPending),
      h.OnClick(Message.ClickedPower({ target })),
      h.Class(
        cn(
          sizeClass,
          'grid shrink-0 place-items-center rounded-full transition-[background-color,box-shadow,transform] duration-300 active:scale-90',
          status.isOn
            ? 'bg-(--glow) text-black/75 shadow-[0_0_22px_-2px_var(--glow)]'
            : 'bg-white/10 text-foreground/70',
          isPending && 'pending-spinner',
        ),
      ),
    ],
    [icon(h, Power, iconClass)],
  )

const targetHeaderView = (
  model: Model,
  target: Target,
  label: string,
  title: string,
  detail: string,
  status: TargetStatus,
  h: HtmlBuilder<Message>,
  maybeEyebrow: Option.Option<Html>,
): Html =>
  h.div(
    [h.Class('flex items-center gap-3')],
    [
      powerOrbView(
        target,
        label,
        status,
        isSettingPower(model, target),
        'size-14',
        'size-6',
        h,
      ),
      h.div(
        [h.Class('min-w-0 flex-1')],
        [
          Option.getOrElse(maybeEyebrow, () => h.empty),
          h.h2([h.Class('truncate text-xl font-semibold')], [title]),
          h.p(
            [
              h.Class(
                cn(
                  'tabular-nums',
                  CAPTION,
                  hasNoResponse(model, target) && 'text-destructive',
                ),
              ),
            ],
            [hasNoResponse(model, target) ? 'No response' : detail],
          ),
        ],
      ),
      closeSheetButton(h),
    ],
  )

type SliderOptions = Readonly<{
  filledTrackClass: string
  trackClass?: string
  showsValueWhileDragging?: boolean
}>

const sliderView = (
  model: Model,
  sliderId: SliderId,
  label: string,
  value: number,
  formatValue: (value: number) => string,
  options: SliderOptions,
  h: HtmlBuilder<Message>,
): Html =>
  h.submodel({
    slotId: sliderDomId(sliderId),
    model: sliderModelOf(model, sliderId),
    view: Slider.view,
    viewInputs: Slider.styledViewInputs(
      {
        value,
        ariaLabel: label,
        formatValue,
        ignoresTouch: model.pageScroll._tag === 'Moving',
        ...options,
      },
      h,
    ),
    toParentMessage: message => Message.GotSliderMessage({ sliderId, message }),
  })

const sliderRowView = (
  node: IconNode,
  slider: Html,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex h-9 items-center gap-3')],
    [icon(h, node, 'size-[18px] shrink-0 text-muted-foreground'), slider],
  )

const HUE_TRACK =
  'bg-[linear-gradient(to_right,#ff0000,#ffff00,#00ff00,#00ffff,#0000ff,#ff00ff,#ff0000)]'
const TEMPERATURE_TRACK =
  'bg-linear-to-r from-sky-200 via-orange-50 to-amber-400'

const draftedColorTemp = (
  model: Model,
  target: Target,
  fallback: number,
): number =>
  Option.match(draftSetting(model, target, 'ColorTemp'), {
    onNone: () => fallback,
    onSome: setting =>
      Setting.match(setting, {
        ColorTemp: ({ value }) => value,
        Brightness: () => fallback,
        Color: () => fallback,
      }),
  })

const draftedHue = (model: Model, target: Target, fallback: number): number =>
  Option.match(draftSetting(model, target, 'Color'), {
    onNone: () => fallback,
    onSome: setting =>
      Setting.match(setting, {
        Color: ({ hue }) => hue,
        Brightness: () => fallback,
        ColorTemp: () => fallback,
      }),
  })

const targetSlidersView = (
  model: Model,
  target: Target,
  name: string,
  status: TargetStatus,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-0.5')],
    [
      sliderRowView(
        Sun,
        sliderView(
          model,
          SliderId.TargetBrightness({ target }),
          `${name} brightness`,
          shownBrightness(model, target, status),
          formatPercent,
          { filledTrackClass: 'slider-fill', showsValueWhileDragging: true },
          h,
        ),
        h,
      ),
      Option.match(status.maybeColorTempRange, {
        onNone: () => h.empty,
        onSome: range =>
          sliderRowView(
            Thermometer,
            sliderView(
              model,
              SliderId.TargetColorTemp({ target }),
              `${name} temperature`,
              draftedColorTemp(
                model,
                target,
                Option.getOrElse(status.maybeColorTemp, () => range.min),
              ),
              temperatureName,
              {
                trackClass: TEMPERATURE_TRACK,
                filledTrackClass: 'bg-transparent',
              },
              h,
            ),
            h,
          ),
      }),
      status.supportsColor
        ? sliderRowView(
            Palette,
            sliderView(
              model,
              SliderId.TargetHue({ target }),
              `${name} color`,
              draftedHue(
                model,
                target,
                Option.getOrElse(status.maybeHue, () => 0),
              ),
              hue => `Hue ${hue}`,
              { trackClass: HUE_TRACK, filledTrackClass: 'bg-transparent' },
              h,
            ),
            h,
          )
        : h.empty,
    ],
  )

const presetSwatch = (preset: Preset): string =>
  PresetLook.match(preset.look, {
    Color: ({ hex }) => hex,
    White: () => WARM_WHITE,
    Rainbow: () =>
      'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)',
  })

const presetDotView = (
  preset: Preset,
  sizeClass: string,
  h: HtmlBuilder<Message>,
  isApplying = false,
): Html =>
  h.span([
    h.Class(
      cn(
        sizeClass,
        'shrink-0 rounded-full',
        isApplying && 'pending-spinner pending-spinner-around',
      ),
    ),
    h.Style({ background: presetSwatch(preset) }),
  ])

const canShowPreset =
  (status: TargetStatus) =>
  (preset: Preset): boolean =>
    PresetLook.match(preset.look, {
      Color: () => status.supportsColor,
      Rainbow: () => status.supportsColor,
      White: () => Option.isSome(status.maybeColorTempRange),
    })

const isApplyingPreset = (
  model: Model,
  target: Target,
  preset: Preset,
): boolean =>
  Option.exists(
    activityOf(model, target),
    activity =>
      activity._tag === 'ApplyingPreset' && activity.preset === preset.name,
  )

const presetChipsView = (
  model: Model,
  target: Target,
  status: TargetStatus,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5')],
    Array.map(Array.filter(model.presets, canShowPreset(status)), preset => {
      const isApplying = isApplyingPreset(model, target, preset)
      return h.keyed('div')(
        preset.name,
        [],
        [
          button<Message>(
            {
              variant: 'secondary',
              onClick: Message.ClickedPreset({ target, preset: preset.name }),
              className: cn(
                'h-10 gap-2 rounded-full bg-white/8 pr-4 pl-3 hover:bg-white/12',
                isApplying && 'ring-1 ring-primary/60',
              ),
              attributes: [
                h.AriaLabel(`${preset.name} on ${target.name}`),
                h.AriaBusy(isApplying),
              ],
            },
            [presetDotView(preset, 'size-3.5', h, isApplying), preset.name],
            h,
          ),
        ],
      )
    }),
  )

const bulbChipsView = (
  model: Model,
  lights: ReadonlyArray<Light>,
  h: HtmlBuilder<Message>,
): Html =>
  lights.length < 2
    ? h.empty
    : h.div(
        [h.Class('no-scrollbar -mx-5 flex gap-2 overflow-x-auto px-5')],
        Array.map(lights, light => {
          const status = targetStatus(model, Target.Light({ name: light.name }))
          return h.keyed('button')(
            light.address,
            [
              h.Type('button'),
              h.AriaLabel(`Open ${light.name}`),
              h.OnClick(Message.PickedHouseBulb({ name: light.name })),
              h.Class(
                'glow-transition flex h-10 shrink-0 items-center gap-2 rounded-full pr-4 pl-3 text-sm whitespace-nowrap ring-1 ring-white/10 hover:bg-white/8',
              ),
              glowAttribute(status, h),
            ],
            [
              h.span([
                h.Class(
                  cn(
                    'size-2.5 rounded-full',
                    status.isOn
                      ? 'bg-(--glow) shadow-[0_0_10px_var(--glow)]'
                      : 'bg-white/20',
                  ),
                ),
              ]),
              shortLightName(lights, light),
            ],
          )
        }),
      )

const roomDetail = (
  model: Model,
  target: Target,
  lights: ReadonlyArray<Light>,
  status: TargetStatus,
): string => {
  const level = targetLevelLabel(model, target, status)
  return lights.length < 2
    ? level
    : `${roomStateLabel(model, lights, status)}${isMixed(model, lights) ? ' · mixed' : ''}`
}

const roomSheetView = (
  model: Model,
  room: HouseRoom,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(roomTarget(model, room), {
    onNone: () => h.empty,
    onSome: target => {
      const status = targetStatus(model, target)
      const lights = roomLights(model, room)
      return sheetFrame(
        room.label,
        isBusyActivity(activityOf(model, target)),
        canControl(model),
        [
          h.div(
            [h.Class('flex flex-col gap-4'), glowAttribute(status, h)],
            [
              targetHeaderView(
                model,
                target,
                room.label,
                room.label,
                roomDetail(model, target, lights, status),
                status,
                h,
                Option.none(),
              ),
              targetSlidersView(model, target, room.label, status, h),
            ],
          ),
          presetChipsView(model, target, status, h),
          Option.isSome(model.maybeHouseFailure)
            ? bulbChipsView(model, lights, h)
            : h.empty,
        ],
        h,
      )
    },
  })

const bulbSheetView = (
  model: Model,
  light: Light,
  bulbs: ReadonlyArray<HouseBulb>,
  h: HtmlBuilder<Message>,
): Html => {
  const target = Target.Light({ name: light.name })
  const status = targetStatus(model, target)
  const maybeRoom = pipe(
    Array.findFirst(bulbs, bulb => bulb.name === light.name),
    Option.flatMap(bulb => roomById(bulb.roomId)),
  )
  const title = Option.match(maybeRoom, {
    onNone: () => light.name,
    onSome: room => shortLightName(roomLights(model, room), light),
  })
  return sheetFrame(
    light.name,
    isBusyActivity(activityOf(model, target)),
    canControl(model),
    [
      h.div(
        [h.Class('flex flex-col gap-4'), glowAttribute(status, h)],
        [
          targetHeaderView(
            model,
            target,
            light.name,
            title,
            targetLevelLabel(model, target, status),
            status,
            h,
            Option.map(maybeRoom, room =>
              h.button(
                [
                  h.Type('button'),
                  h.AriaLabel(`Back to ${room.label}`),
                  h.OnClick(Message.PickedHouseRoom({ roomId: room.id })),
                  h.Class(
                    'flex items-center gap-0.5 text-xs font-medium text-muted-foreground hover:text-foreground',
                  ),
                ],
                [icon(h, ChevronLeft, 'size-3.5 -ml-0.5'), room.label],
              ),
            ),
          ),
          targetSlidersView(model, target, light.name, status, h),
        ],
      ),
      presetChipsView(model, target, status, h),
    ],
    h,
  )
}

const presetTileView = (
  model: Model,
  target: Target,
  preset: Preset,
  h: HtmlBuilder<Message>,
): Html => {
  const isApplying = isApplyingPreset(model, target, preset)
  return h.keyed('button')(
    preset.name,
    [
      h.Type('button'),
      h.AriaLabel(`${preset.name} on ${target.name}`),
      h.AriaBusy(isApplying),
      h.OnClick(Message.ClickedPreset({ target, preset: preset.name })),
      h.Class(
        cn(
          'relative flex h-22 flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl bg-white/6 text-sm font-medium ring-1 ring-white/8 transition-transform active:scale-95',
          isApplying && 'ring-primary/60',
        ),
      ),
    ],
    [presetDotView(preset, 'size-7', h, isApplying), preset.name],
  )
}

const scenesSheetView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(wholeHouseTarget(model), {
    onNone: () =>
      sheetFrame(
        'Scenes',
        false,
        canControl(model),
        [
          scenesHeaderView(h),
          h.p(
            [h.Class(CAPTION)],
            [
              'Scenes for the whole house need a group with every light in it. Add one in Devices.',
            ],
          ),
        ],
        h,
      ),
    onSome: target =>
      sheetFrame(
        'Scenes',
        isBusyActivity(activityOf(model, target)),
        canControl(model),
        [
          scenesHeaderView(h),
          h.div(
            [h.Class('grid grid-cols-3 gap-2.5')],
            Array.map(
              Array.filter(
                model.presets,
                canShowPreset(targetStatus(model, target)),
              ),
              preset => presetTileView(model, target, preset, h),
            ),
          ),
        ],
        h,
      ),
  })

const scenesHeaderView = (h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex items-center justify-between gap-3')],
    [
      h.div(
        [],
        [
          h.h2([h.Class('text-xl font-semibold')], ['Scenes']),
          h.p([h.Class(CAPTION)], ['For the whole house']),
        ],
      ),
      h.div(
        [h.Class('flex items-center gap-2')],
        [
          button<Message>(
            {
              variant: 'ghost',
              size: 'sm',
              onClick: Message.ClickedOpenScreen({ screen: 'Scenes' }),
              className: 'text-muted-foreground',
            },
            [icon(h, Pencil, 'size-3.5', 'inline-start'), 'Edit'],
            h,
          ),
          closeSheetButton(h),
        ],
      ),
    ],
  )

// SCREENS

const SCREEN_TITLES: Readonly<Record<Exclude<Screen, 'House'>, string>> = {
  Scenes: 'Scenes',
  Devices: 'Devices',
  Automations: 'Automations',
}

const screenView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Match.value(model.screen).pipe(
    Match.withReturnType<Html>(),
    Match.when('House', () => h.empty),
    Match.when('Scenes', screen =>
      pageView(screen, scenesPageContent(model, h), h),
    ),
    Match.when('Devices', screen =>
      pageView(
        screen,
        h.submodel({
          slotId: 'manage',
          model: model.manage,
          view: ManageView.view,
          viewInputs: {
            context: {
              lights: model.lights,
              groups: model.groups,
              newDevices: model.newDevices,
            },
            pairing: model.pairing,
            isLive: canControl(model),
          },
          toParentMessage: (message: ManageMessage) =>
            Message.GotManageMessage({ message }),
        }),
        h,
      ),
    ),
    Match.when('Automations', screen =>
      pageView(
        screen,
        h.submodel({
          slotId: 'automations',
          model: model.automations,
          view: AutomationsView.view,
          viewInputs: {
            groupNames: Array.map(model.groups, group => group.name),
          },
          toParentMessage: (message: AutomationsMessage) =>
            Message.GotAutomationsMessage({ message }),
        }),
        h,
      ),
    ),
    Match.exhaustive,
  )

const pageView = (
  screen: Exclude<Screen, 'House'>,
  content: Html,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class(PAGE)],
    [
      h.header(
        [
          h.Class(
            'sticky top-0 z-10 bg-background/90 pt-[max(calc(env(safe-area-inset-top)+0.5rem),1rem)] pb-2 backdrop-blur-xl',
          ),
        ],
        [
          h.div(
            [h.Class(cn(PAGE_COLUMN, 'flex items-center gap-2'))],
            [
              h.button(
                [
                  h.Type('button'),
                  h.AriaLabel('Back to the house'),
                  h.OnClick(Message.ClickedBackToHouse()),
                  h.Class(
                    '-ml-1 grid size-11 place-items-center rounded-full text-foreground hover:bg-white/8',
                  ),
                ],
                [icon(h, ChevronLeft, 'size-6')],
              ),
              h.h1(
                [h.Class('text-2xl font-semibold tracking-tight')],
                [SCREEN_TITLES[screen]],
              ),
            ],
          ),
        ],
      ),
      h.div(
        [
          h.Class(
            cn(PAGE_COLUMN, 'pt-3 pb-[calc(env(safe-area-inset-bottom)+4rem)]'),
          ),
        ],
        [content],
      ),
    ],
  )

const scenesPageContent = (model: Model, h: HtmlBuilder<Message>): Html => {
  const isBusy = isEditorBusy(model.presetEditor)
  return h.section(
    [h.Class(SECTION), h.AriaLabel('Presets')],
    [
      h.div(
        [h.Class('flex items-center justify-between')],
        [
          h.h2([h.Class(SECTION_TITLE)], ['Presets']),
          button<Message>(
            {
              variant: 'ghost',
              size: 'sm',
              onClick: Message.ClickedNewPreset(),
              isDisabled: isBusy,
              className: 'text-muted-foreground',
            },
            [icon(h, Plus, 'size-3.5', 'inline-start'), 'New preset'],
            h,
          ),
        ],
      ),
      PresetEditor.match(model.presetEditor, {
        Closed: () => h.empty,
        Open: ({ editing, maybeFailure }) =>
          presetEditorView(model, editing, maybeFailure, h),
        Saving: ({ editing }) =>
          presetEditorView(model, editing, Option.none(), h),
        Deleting: ({ editing }) =>
          presetEditorView(model, editing, Option.none(), h),
      }),
      Card<Message>(
        { className: 'gap-0 py-0' },
        [
          h.ul(
            [],
            Array.map(model.presets, preset =>
              h.keyed('li')(
                preset.name,
                [
                  h.Class(
                    'not-first:border-t flex h-13 items-center gap-3 border-border px-4',
                  ),
                ],
                [
                  presetDotView(preset, 'size-4', h),
                  h.span([h.Class('flex-1 truncate')], [preset.name]),
                  PresetLook.match(preset.look, {
                    Rainbow: () =>
                      badge<Message>({ variant: 'secondary' }, ['Built in'], h),
                    Color: () => editPresetButtonView(preset, isBusy, h),
                    White: () => editPresetButtonView(preset, isBusy, h),
                  }),
                ],
              ),
            ),
          ),
        ],
        h,
      ),
    ],
  )
}

const editPresetButtonView = (
  preset: Preset,
  isDisabled: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  button<Message>(
    {
      variant: 'ghost',
      size: 'icon-lg',
      onClick: Message.ClickedEditPreset({ preset: preset.name }),
      isDisabled,
      className: '-mr-2 text-muted-foreground',
      attributes: [h.AriaLabel(`Edit ${preset.name}`)],
    },
    icon(h, Pencil),
    h,
  )

const pendingButtonLabel = (
  isPending: boolean,
  pendingLabel: string,
  label: string,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html | string> =>
  isPending
    ? [spinner<Message>({ className: 'size-3.5' }, h), pendingLabel]
    : [label]

const presetEditorView = (
  model: Model,
  editing: EditingPreset,
  maybeFailure: Option.Option<string>,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeProblem = presetEditorProblem(model, editing)
  const isNew = Option.isNone(editing.maybeOriginalName)
  const isSaving = model.presetEditor._tag === 'Saving'
  const isDeleting = model.presetEditor._tag === 'Deleting'
  const isBusy = isEditorBusy(model.presetEditor)
  return h.form(
    [
      h.AriaLabel(isNew ? 'New preset' : 'Edit preset'),
      h.AriaBusy(isBusy),
      h.OnSubmit(Message.SubmittedEditor()),
      h.Class('animate-in duration-150 fade-in slide-in-from-top-1'),
    ],
    [
      Card<Message>(
        {},
        [
          Card.content<Message>(
            { className: 'flex flex-col gap-4' },
            [
              h.div(
                [
                  h.Class(
                    cn(
                      'flex flex-col gap-4 transition-opacity',
                      isBusy && 'opacity-60',
                    ),
                  ),
                  h.Inert(isBusy),
                ],
                [
                  input<Message>(
                    {
                      id: 'preset-name',
                      label: 'Preset name',
                      value: editing.name,
                      onInput: value => Message.UpdatedEditorName({ value }),
                      className: 'h-10',
                    },
                    h,
                  ),
                  h.div(
                    [h.Class('flex flex-col gap-1.5')],
                    [
                      h.div(
                        [h.Class(`flex justify-between px-1 ${CAPTION}`)],
                        [
                          h.span([], ['Brightness']),
                          h.span(
                            [h.Class('tabular-nums')],
                            [formatPercent(editing.brightness)],
                          ),
                        ],
                      ),
                      sliderView(
                        model,
                        SliderId.EditorBrightness(),
                        'Preset brightness',
                        editing.brightness,
                        formatPercent,
                        { filledTrackClass: PRIMARY_GLOW_FILL },
                        h,
                      ),
                    ],
                  ),
                  lookEditorView(model, editing, h),
                ],
              ),
              Option.match(maybeProblem, {
                onNone: () => h.empty,
                onSome: problem => h.p([h.Class(CAPTION)], [problem]),
              }),
              Option.match(maybeFailure, {
                onNone: () => h.empty,
                onSome: failure =>
                  h.p(
                    [h.Class('text-xs text-destructive'), h.Role('alert')],
                    [failure],
                  ),
              }),
              h.div(
                [h.Class('flex gap-2')],
                [
                  button<Message>(
                    {
                      type: 'submit',
                      size: 'lg',
                      isDisabled: Option.isSome(maybeProblem) || isBusy,
                      className: 'min-w-20 px-4',
                    },
                    pendingButtonLabel(isSaving, 'Saving…', 'Save', h),
                    h,
                  ),
                  button<Message>(
                    {
                      variant: 'secondary',
                      size: 'lg',
                      onClick: Message.ClickedCancelEditor(),
                      isDisabled: isBusy,
                      className: 'px-4',
                    },
                    'Cancel',
                    h,
                  ),
                  isNew
                    ? h.empty
                    : button<Message>(
                        {
                          variant: 'destructive',
                          size: 'lg',
                          onClick: Message.ClickedDeletePreset(),
                          isDisabled: isBusy,
                          className: 'ml-auto min-w-20 px-4',
                        },
                        pendingButtonLabel(
                          isDeleting,
                          'Deleting…',
                          'Delete',
                          h,
                        ),
                        h,
                      ),
                ],
              ),
            ],
            h,
          ),
        ],
        h,
      ),
    ],
  )
}

const temperatureSliderView = (
  model: Model,
  sliderId: SliderId,
  label: string,
  value: number,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-1.5')],
    [
      h.div(
        [h.Class(`flex justify-between px-1 ${CAPTION}`)],
        [h.span([], ['Cool']), h.span([], ['Warm'])],
      ),
      sliderView(
        model,
        sliderId,
        label,
        value,
        temperatureName,
        {
          trackClass: TEMPERATURE_TRACK,
          filledTrackClass: 'bg-transparent',
        },
        h,
      ),
    ],
  )

const lookEditorView = (
  model: Model,
  editing: EditingPreset,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-3')],
    [
      h.div(
        [h.Class('grid grid-cols-2 gap-1 rounded-lg bg-muted p-1')],
        [
          lookTabView(
            'White',
            editing.look._tag === 'White',
            SavablePresetLook.White({ colorTemp: 370 }),
            h,
          ),
          lookTabView(
            'Color',
            editing.look._tag === 'Color',
            SavablePresetLook.Color({ hex: '#ffa024' }),
            h,
          ),
        ],
      ),
      SavablePresetLook.match(editing.look, {
        White: ({ colorTemp }) =>
          temperatureSliderView(
            model,
            SliderId.EditorColorTemp(),
            'Preset temperature',
            Math.min(colorTemp, PRESET_COLOR_TEMP_RANGE.max),
            h,
          ),
        Color: ({ hex }) =>
          h.input([
            h.Type('color'),
            h.AriaLabel('Preset color'),
            h.Value(hex),
            h.OnInput(value =>
              Message.UpdatedEditorLook({
                look: SavablePresetLook.Color({ hex: value }),
              }),
            ),
            h.Class(COLOR_INPUT),
          ]),
      }),
    ],
  )

const lookTabView = (
  label: string,
  isSelected: boolean,
  look: SavablePresetLook,
  h: HtmlBuilder<Message>,
): Html =>
  button<Message>(
    {
      variant: isSelected ? 'secondary' : 'ghost',
      onClick: Message.UpdatedEditorLook({ look }),
      className: isSelected
        ? 'bg-card shadow-sm hover:bg-card'
        : 'text-muted-foreground',
      attributes: [h.AriaPressed(String(isSelected))],
    },
    label,
    h,
  )
