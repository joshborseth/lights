import { Array, Option, Order, pipe } from 'effect'
import { Document, Html, HtmlBuilder } from 'foldkit/html'
import { Palette, Pencil, Plus } from 'lucide'

import { Alert } from '@/components/ui/alert'
import { badge } from '@/components/ui/badge'
import { button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Empty } from '@/components/ui/empty'
import { input } from '@/components/ui/input'
import * as Slider from '@/components/ui/slider'
import { spinner } from '@/components/ui/spinner'
import { switch_ } from '@/components/ui/switch'
import { icon } from '@/lib/icons'

import {
  type Group,
  type Light,
  MAX_BRIGHTNESS,
  PRESET_GROUPS,
  type Preset,
  PresetLook,
  SavablePresetLook,
  Setting,
} from './domain'
import {
  Connection,
  type EditingPreset,
  Message,
  type Model,
  PRESET_COLOR_TEMP_RANGE,
  PresetEditor,
  SliderId,
  Target,
  type TargetStatus,
  draftSetting,
  isExpanded,
  lightsOfTarget,
  presetEditorProblem,
  sliderDomId,
  sliderModelOf,
  targetId,
  targetStatus,
} from './main'

const ROOM_ORDER: ReadonlyArray<string> = [
  'Living Room',
  'Kitchen',
  'Bedroom',
  'Bathroom',
]
const OTHER_ROOM = 'Other'

const GROUP_ORDER: ReadonlyArray<string> = [
  'All Lights',
  'Rest of the House',
  'Bedroom',
]

const WARM_WHITE = '#ffdfae'
const MIN_GLOW_LEVEL = 0.3
const OFF_GLOW = 'oklch(0.42 0.008 70)'

const SECTION = 'flex flex-col gap-3'
const SECTION_TITLE = 'px-1 text-sm font-medium text-muted-foreground'
const CAPTION = 'text-xs text-muted-foreground'
const THUMB =
  'h-5 w-3 rounded-full border-0 bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.25),0_1px_4px_rgb(0_0_0/0.4)] ring-white/40'
const TRACK = 'rounded-lg bg-muted data-horizontal:h-9'
const COLOR_INPUT =
  'h-11 w-full cursor-pointer rounded-lg border border-input bg-transparent p-1 [&::-moz-color-swatch]:rounded-md [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch]:rounded-md [&::-webkit-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0'

const brightnessPercent = (brightness: number): number =>
  Math.round((brightness / MAX_BRIGHTNESS) * 100)

const formatPercent = (brightness: number): string =>
  `${brightnessPercent(brightness)}%`

const roomOf = (light: Light): string =>
  pipe(
    Array.findFirst(ROOM_ORDER, room => light.name.startsWith(room)),
    Option.getOrElse(() => OTHER_ROOM),
  )

const groupRank = (group: Group): number =>
  pipe(
    Array.findFirstIndex(GROUP_ORDER, name => name === group.name),
    Option.getOrElse(() => GROUP_ORDER.length),
  )

const onCount = (model: Model, lights: ReadonlyArray<Light>): number =>
  Array.filter(lights, light => model.states[light.name]?.power === 'ON').length

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: 'Lights',
  body: h.main(
    [h.Class('min-h-dvh')],
    [
      h.div(
        [
          h.Class(
            'mx-auto flex max-w-xl flex-col gap-8 px-4 pt-[max(env(safe-area-inset-top),2rem)] pb-16',
          ),
        ],
        [
          headerView(model, h),
          problemView(model, h),
          ...(Array.isReadonlyArrayEmpty(model.lights)
            ? [emptyView(model, h)]
            : [
                groupsView(model, h),
                ...roomsView(model, h),
                presetsView(model, h),
              ]),
        ],
      ),
    ],
  ),
})

const connectionLabel = (model: Model): string =>
  Connection.match(model.connection, {
    Connecting: () => 'Connecting…',
    WaitingToReconnect: () => 'Reconnecting…',
    Connected: () => (model.isBridgeOnline ? 'Live' : 'Zigbee offline'),
  })

const connectionDotClass = (model: Model): string =>
  Connection.match(model.connection, {
    Connecting: () => 'animate-pulse bg-primary',
    WaitingToReconnect: () => 'animate-pulse bg-primary',
    Connected: () =>
      model.isBridgeOnline ? 'bg-emerald-400' : 'bg-destructive',
  })

const headerView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Class('flex items-center justify-between px-1')],
    [
      h.div(
        [],
        [
          h.h1([h.Class('text-2xl font-semibold tracking-tight')], ['Lights']),
          Array.isReadonlyArrayEmpty(model.lights)
            ? h.empty
            : h.p(
                [h.Class(`mt-0.5 tabular-nums ${CAPTION}`)],
                [
                  `${onCount(model, model.lights)} of ${model.lights.length} on`,
                ],
              ),
        ],
      ),
      h.div(
        [h.Role('status')],
        [
          badge<Message>(
            { variant: 'secondary', className: 'h-6 gap-1.5 px-2.5' },
            [
              h.span([
                h.Class(`size-1.5 rounded-full ${connectionDotClass(model)}`),
              ]),
              connectionLabel(model),
            ],
            h,
          ),
        ],
      ),
    ],
  )

const problemView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.maybeProblem, {
    onNone: () => h.empty,
    onSome: problem =>
      Alert<Message>(
        { variant: 'destructive' },
        [Alert.description<Message>({}, [problem], h)],
        h,
      ),
  })

const emptyView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Empty<Message>(
    { className: 'py-24' },
    [
      Empty.header<Message>(
        {},
        [
          Empty.media<Message>(
            {},
            [
              spinner<Message>(
                { className: 'size-5 text-muted-foreground' },
                h,
              ),
            ],
            h,
          ),
          Empty.description<Message>(
            {},
            [
              model.connection._tag === 'Connected'
                ? 'Waiting for your lights…'
                : 'Connecting to your lights…',
            ],
            h,
          ),
        ],
        h,
      ),
    ],
    h,
  )

const glowColor = (status: TargetStatus): string =>
  status.isOn ? Option.getOrElse(status.maybeHex, () => WARM_WHITE) : OFF_GLOW

const glowLevel = (status: TargetStatus): number =>
  status.isOn ? Math.max(MIN_GLOW_LEVEL, status.brightness / MAX_BRIGHTNESS) : 0

const glowAttribute = (status: TargetStatus, h: HtmlBuilder<Message>) =>
  h.Style({
    '--glow': glowColor(status),
    '--level': String(glowLevel(status)),
  })

const groupsView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class(SECTION), h.AriaLabel('Groups')],
    Array.map(
      Array.sortBy(Order.mapInput(Order.Number, groupRank))(model.groups),
      group => groupCardView(model, group, h),
    ),
  )

const groupCardView = (
  model: Model,
  group: Group,
  h: HtmlBuilder<Message>,
): Html => {
  const target = Target.Group({ name: group.name })
  const status = targetStatus(model, target)
  const lights = lightsOfTarget(model, target)
  return h.keyed('article')(
    group.name,
    [h.AriaLabel(group.name), glowAttribute(status, h)],
    [
      Card<Message>(
        { className: 'bulb-glow transition-shadow' },
        [
          Card.content<Message>(
            { className: 'flex flex-col gap-4' },
            [
              targetControlsView(
                model,
                target,
                group.name,
                `${onCount(model, lights)} of ${lights.length} on`,
                status,
                h,
              ),
              PRESET_GROUPS.includes(group.name)
                ? presetChipsView(model, group.name, h)
                : h.empty,
            ],
            h,
          ),
        ],
        h,
      ),
    ],
  )
}

const roomsView = (
  model: Model,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  Array.getSomes(
    Array.map([...ROOM_ORDER, OTHER_ROOM], room => {
      const lights = Array.filter(model.lights, light => roomOf(light) === room)
      return Array.isReadonlyArrayEmpty(lights)
        ? Option.none()
        : Option.some(
            h.section(
              [h.Class(SECTION), h.AriaLabel(room)],
              [
                h.h2([h.Class(SECTION_TITLE)], [room]),
                Card<Message>(
                  { className: 'gap-0 py-0' },
                  Array.map(lights, light => lightRowView(model, light, h)),
                  h,
                ),
              ],
            ),
          )
    }),
  )

const lightRowView = (
  model: Model,
  light: Light,
  h: HtmlBuilder<Message>,
): Html => {
  const target = Target.Light({ name: light.name })
  const status = targetStatus(model, target)
  return h.keyed('article')(
    light.address,
    [
      h.AriaLabel(light.name),
      glowAttribute(status, h),
      h.Class('not-first:border-t border-border p-4'),
    ],
    [
      targetControlsView(
        model,
        target,
        light.name,
        status.isOn ? formatPercent(status.brightness) : 'Off',
        status,
        h,
      ),
    ],
  )
}

const targetControlsView = (
  model: Model,
  target: Target,
  name: string,
  detail: string,
  status: TargetStatus,
  h: HtmlBuilder<Message>,
): Html => {
  const isOpen = isExpanded(model, target)
  const hasColorControls =
    Option.isSome(status.maybeColorTempRange) || status.supportsColor
  return h.div(
    [h.Class('flex flex-col gap-3')],
    [
      h.div(
        [h.Class('flex items-center gap-3')],
        [
          bulbDotView(status, h),
          h.div(
            [h.Class('min-w-0 flex-1')],
            [
              h.p([h.Class('truncate font-medium')], [name]),
              h.p([h.Class(`tabular-nums ${CAPTION}`)], [detail]),
            ],
          ),
          hasColorControls ? colorButtonView(target, name, isOpen, h) : h.empty,
          powerSwitchView(target, name, status, h),
        ],
      ),
      sliderView(
        model,
        SliderId.TargetBrightness({ target }),
        `${name} brightness`,
        Option.match(draftSetting(model, target, 'Brightness'), {
          onNone: () => status.brightness,
          onSome: setting =>
            Setting.match(setting, {
              Brightness: ({ value }) => value,
              ColorTemp: () => status.brightness,
              Color: () => status.brightness,
            }),
        }),
        formatPercent,
        { filledTrackClass: 'bg-(--glow)' },
        h,
      ),
      isOpen && hasColorControls
        ? colorControlsView(model, target, name, status, h)
        : h.empty,
    ],
  )
}

const bulbDotView = (status: TargetStatus, h: HtmlBuilder<Message>): Html =>
  h.span([
    h.Class(
      status.isOn
        ? 'size-3 shrink-0 rounded-full bg-(--glow) shadow-[0_0_14px_var(--glow)]'
        : 'size-3 shrink-0 rounded-full bg-muted',
    ),
  ])

const colorButtonView = (
  target: Target,
  name: string,
  isOpen: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  button<Message>(
    {
      variant: 'ghost',
      size: 'icon-lg',
      onClick: Message.ClickedExpand({ target }),
      className: 'text-muted-foreground aria-expanded:text-foreground',
      attributes: [h.AriaLabel(`${name} color`), h.AriaExpanded(isOpen)],
    },
    icon(h, Palette),
    h,
  )

const powerSwitchView = (
  target: Target,
  name: string,
  status: TargetStatus,
  h: HtmlBuilder<Message>,
): Html =>
  switch_<Message>(
    {
      id: `${targetId(target)}-power`,
      label: `${name} power`,
      isChecked: status.isOn,
      onToggle: () => Message.ClickedPower({ target }),
      className:
        'data-checked:bg-(--glow) data-[size=default]:h-7 data-[size=default]:w-12',
      thumbClass:
        'bg-white shadow-sm dark:data-checked:bg-white dark:data-unchecked:bg-foreground group-data-[size=default]/switch:size-6 group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-3px)] group-data-[size=default]/switch:data-unchecked:translate-x-px',
      labelClass: 'sr-only',
      wrapperClass: 'gap-0',
    },
    h,
  )

type SliderClasses = Readonly<{
  filledTrackClass: string
  trackClass?: string
}>

const sliderView = (
  model: Model,
  sliderId: SliderId,
  label: string,
  value: number,
  formatValue: (value: number) => string,
  classes: SliderClasses,
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
        trackClass: classes.trackClass ?? TRACK,
        filledTrackClass: classes.filledTrackClass,
        thumbClass: THUMB,
      },
      h,
    ),
    toParentMessage: message => Message.GotSliderMessage({ sliderId, message }),
  })

const colorControlsView = (
  model: Model,
  target: Target,
  name: string,
  status: TargetStatus,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-3')],
    [
      Option.match(status.maybeColorTempRange, {
        onNone: () => h.empty,
        onSome: range =>
          temperatureSliderView(
            model,
            SliderId.TargetColorTemp({ target }),
            `${name} temperature`,
            Option.match(draftSetting(model, target, 'ColorTemp'), {
              onNone: () =>
                Option.getOrElse(status.maybeColorTemp, () => range.min),
              onSome: setting =>
                Setting.match(setting, {
                  ColorTemp: ({ value }) => value,
                  Brightness: () => range.min,
                  Color: () => range.min,
                }),
            }),
            h,
          ),
      }),
      status.supportsColor
        ? h.input([
            h.Type('color'),
            h.AriaLabel(`${name} color picker`),
            h.Value(
              Option.match(draftSetting(model, target, 'Color'), {
                onNone: () =>
                  Option.getOrElse(status.maybeHex, () => '#ffffff'),
                onSome: setting =>
                  Setting.match(setting, {
                    Color: ({ hex }) => hex,
                    Brightness: () => '#ffffff',
                    ColorTemp: () => '#ffffff',
                  }),
              }),
            ),
            h.OnInput(hex =>
              Message.UpdatedSetting({
                target,
                setting: Setting.Color({ hex }),
              }),
            ),
            h.Class(COLOR_INPUT),
          ])
        : h.empty,
    ],
  )

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
        mireds => `${mireds} mireds`,
        {
          trackClass:
            'rounded-lg bg-linear-to-r from-sky-200 via-orange-50 to-amber-400 data-horizontal:h-9',
          filledTrackClass: 'bg-transparent',
        },
        h,
      ),
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
): Html =>
  h.span([
    h.Class(`${sizeClass} shrink-0 rounded-full`),
    h.Style({ background: presetSwatch(preset) }),
  ])

const presetChipsView = (
  model: Model,
  group: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Class(
        'no-scrollbar -mx-(--card-spacing) flex gap-2 overflow-x-auto px-(--card-spacing)',
      ),
    ],
    Array.map(model.presets, preset =>
      h.keyed('div')(
        preset.name,
        [],
        [
          button<Message>(
            {
              variant: 'secondary',
              onClick: Message.ClickedPreset({ group, preset: preset.name }),
              className: 'h-9 gap-2 rounded-full pr-3.5 pl-2.5',
              attributes: [h.AriaLabel(`${preset.name} on ${group}`)],
            },
            [presetDotView(preset, 'size-3.5', h), preset.name],
            h,
          ),
        ],
      ),
    ),
  )

const presetsView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
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
              className: 'text-muted-foreground',
            },
            [icon(h, Plus, 'size-3.5', 'inline-start'), 'New preset'],
            h,
          ),
        ],
      ),
      PresetEditor.match(model.presetEditor, {
        Closed: () => h.empty,
        Open: ({ editing }) => presetEditorView(model, editing, h),
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
                    Color: () => editPresetButtonView(preset, h),
                    White: () => editPresetButtonView(preset, h),
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

const editPresetButtonView = (preset: Preset, h: HtmlBuilder<Message>): Html =>
  button<Message>(
    {
      variant: 'ghost',
      size: 'icon-lg',
      onClick: Message.ClickedEditPreset({ preset: preset.name }),
      className: '-mr-2 text-muted-foreground',
      attributes: [h.AriaLabel(`Edit ${preset.name}`)],
    },
    icon(h, Pencil),
    h,
  )

const presetEditorView = (
  model: Model,
  editing: EditingPreset,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeProblem = presetEditorProblem(model, editing)
  const isNew = Option.isNone(editing.maybeOriginalName)
  return h.form(
    [
      h.AriaLabel(isNew ? 'New preset' : 'Edit preset'),
      h.OnSubmit(Message.SubmittedEditor()),
    ],
    [
      Card<Message>(
        {},
        [
          Card.content<Message>(
            { className: 'flex flex-col gap-4' },
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
                    { filledTrackClass: 'bg-primary' },
                    h,
                  ),
                ],
              ),
              lookEditorView(model, editing, h),
              Option.match(maybeProblem, {
                onNone: () => h.empty,
                onSome: problem => h.p([h.Class(CAPTION)], [problem]),
              }),
              h.div(
                [h.Class('flex gap-2')],
                [
                  button<Message>(
                    {
                      type: 'submit',
                      size: 'lg',
                      isDisabled: Option.isSome(maybeProblem),
                      className: 'px-4',
                    },
                    'Save',
                    h,
                  ),
                  button<Message>(
                    {
                      variant: 'secondary',
                      size: 'lg',
                      onClick: Message.ClickedCancelEditor(),
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
                          className: 'ml-auto px-4',
                        },
                        'Delete',
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
