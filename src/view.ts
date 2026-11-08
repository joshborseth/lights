import { Array, Option, Order, pipe } from 'effect'
import { Document, Html, HtmlBuilder } from 'foldkit/html'

import {
  type Group,
  type Light,
  MAX_BRIGHTNESS,
  MIN_BRIGHTNESS,
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
  PresetEditor,
  Target,
  type TargetStatus,
  draftSetting,
  isExpanded,
  presetEditorProblem,
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

const CARD = 'rounded-2xl bg-stone-900 p-4 ring-1 ring-stone-800'
const SLIDER = 'h-8 w-full accent-amber-300'
const CAPTION = 'text-xs text-stone-400'
const QUIET_BUTTON =
  'rounded-lg bg-stone-800 px-3 py-2 text-sm text-stone-200 hover:bg-stone-700'

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

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: 'Lights',
  body: h.main(
    [h.Class('min-h-screen bg-stone-950 text-stone-100')],
    [
      h.div(
        [h.Class('mx-auto flex max-w-xl flex-col gap-6 px-4 py-6')],
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

const headerView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.header(
    [h.Class('flex items-baseline justify-between')],
    [
      h.h1([h.Class('text-2xl font-semibold')], ['Lights']),
      h.span([h.Class(CAPTION), h.Role('status')], [connectionLabel(model)]),
    ],
  )

const problemView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.maybeProblem, {
    onNone: () => h.empty,
    onSome: problem =>
      h.p(
        [
          h.Class('rounded-lg bg-red-950 p-3 text-sm text-red-200'),
          h.Role('alert'),
        ],
        [problem],
      ),
  })

const emptyView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.p(
    [h.Class('py-16 text-center text-stone-400')],
    [
      model.connection._tag === 'Connected'
        ? 'Waiting for your lights…'
        : 'Connecting to your lights…',
    ],
  )

const groupsView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('flex flex-col gap-3'), h.AriaLabel('Groups')],
    Array.map(
      Array.sortBy(Order.mapInput(Order.Number, groupRank))(model.groups),
      group =>
        h.keyed('div')(
          group.name,
          [],
          [
            targetCardView(
              model,
              Target.Group({ name: group.name }),
              group.name,
              h,
              PRESET_GROUPS.includes(group.name)
                ? presetChipsView(model, group.name, h)
                : h.empty,
            ),
          ],
        ),
    ),
  )

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
              [h.Class('flex flex-col gap-3'), h.AriaLabel(room)],
              [
                h.h2([h.Class('text-sm font-medium text-stone-400')], [room]),
                ...Array.map(lights, light =>
                  h.keyed('div')(
                    light.address,
                    [],
                    [
                      targetCardView(
                        model,
                        Target.Light({ name: light.name }),
                        light.name,
                        h,
                        h.empty,
                      ),
                    ],
                  ),
                ),
              ],
            ),
          )
    }),
  )

const swatchColor = (status: TargetStatus): string =>
  status.isOn ? Option.getOrElse(status.maybeHex, () => '#fcd34d') : '#292524'

const targetCardView = (
  model: Model,
  target: Target,
  name: string,
  h: HtmlBuilder<Message>,
  extra: Html,
): Html => {
  const status = targetStatus(model, target)
  const isOpen = isExpanded(model, target)
  return h.article(
    [h.Class(`${CARD} flex flex-col gap-3`), h.AriaLabel(name)],
    [
      h.div(
        [h.Class('flex items-center gap-3')],
        [
          h.span([
            h.Class('h-5 w-5 shrink-0 rounded-full ring-1 ring-stone-700'),
            h.Style({ backgroundColor: swatchColor(status) }),
          ]),
          h.span([h.Class('min-w-0 flex-1 truncate font-medium')], [name]),
          h.button(
            [
              h.Type('button'),
              h.AriaPressed(String(status.isOn)),
              h.AriaLabel(`${name} power`),
              h.OnClick(Message.ClickedPower({ target })),
              h.Class(
                status.isOn
                  ? 'w-16 rounded-lg bg-amber-300 py-2 text-sm font-semibold text-stone-950'
                  : 'w-16 rounded-lg bg-stone-800 py-2 text-sm font-semibold text-stone-300',
              ),
            ],
            [status.isOn ? 'On' : 'Off'],
          ),
        ],
      ),
      rangeView(
        `${name} brightness`,
        MIN_BRIGHTNESS,
        MAX_BRIGHTNESS,
        Option.match(draftSetting(model, target, 'Brightness'), {
          onNone: () => status.brightness,
          onSome: setting =>
            Setting.match(setting, {
              Brightness: ({ value }) => value,
              ColorTemp: () => status.brightness,
              Color: () => status.brightness,
            }),
        }),
        value =>
          Message.UpdatedSetting({
            target,
            setting: Setting.Brightness({ value }),
          }),
        h,
      ),
      extra,
      h.button(
        [
          h.Type('button'),
          h.AriaExpanded(isOpen),
          h.AriaLabel(`${name} color`),
          h.OnClick(Message.ClickedExpand({ target })),
          h.Class('self-start text-sm text-stone-400 hover:text-stone-200'),
        ],
        [isOpen ? 'Hide color' : 'Color'],
      ),
      isOpen ? colorControlsView(model, target, name, status, h) : h.empty,
    ],
  )
}

const rangeView = (
  label: string,
  min: number,
  max: number,
  value: number,
  toMessage: (value: number) => Message,
  h: HtmlBuilder<Message>,
): Html =>
  h.input([
    h.Type('range'),
    h.AriaLabel(label),
    h.Min(String(min)),
    h.Max(String(max)),
    h.Step('1'),
    h.Value(String(value)),
    h.OnInput(raw => toMessage(Number(raw))),
    h.Class(SLIDER),
  ])

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
          h.div(
            [],
            [
              h.div(
                [h.Class(`flex justify-between ${CAPTION}`)],
                [h.span([], ['Cool']), h.span([], ['Warm'])],
              ),
              rangeView(
                `${name} temperature`,
                range.min,
                range.max,
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
                value =>
                  Message.UpdatedSetting({
                    target,
                    setting: Setting.ColorTemp({ value }),
                  }),
                h,
              ),
            ],
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
            h.Class('h-11 w-full rounded-lg bg-transparent'),
          ])
        : h.empty,
    ],
  )

const presetSwatch = (preset: Preset): string =>
  PresetLook.match(preset.look, {
    Color: ({ hex }) => hex,
    White: () => '#ffdfae',
    Rainbow: () =>
      'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)',
  })

const presetChipsView = (
  model: Model,
  group: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-wrap gap-2')],
    Array.map(model.presets, preset =>
      h.keyed('button')(
        preset.name,
        [
          h.Type('button'),
          h.AriaLabel(`${preset.name} on ${group}`),
          h.OnClick(Message.ClickedPreset({ group, preset: preset.name })),
          h.Class(`${QUIET_BUTTON} flex items-center gap-2`),
        ],
        [
          h.span([
            h.Class('h-3 w-3 rounded-full'),
            h.Style({ background: presetSwatch(preset) }),
          ]),
          preset.name,
        ],
      ),
    ),
  )

const presetsView = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class('flex flex-col gap-3'), h.AriaLabel('Presets')],
    [
      h.div(
        [h.Class('flex items-center justify-between')],
        [
          h.h2([h.Class('text-sm font-medium text-stone-400')], ['Presets']),
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedNewPreset()),
              h.Class(QUIET_BUTTON),
            ],
            ['New preset'],
          ),
        ],
      ),
      PresetEditor.match(model.presetEditor, {
        Closed: () => h.empty,
        Open: ({ editing }) => presetEditorView(model, editing, h),
      }),
      h.ul(
        [h.Class(`${CARD} flex flex-col gap-2`)],
        Array.map(model.presets, preset =>
          h.keyed('li')(
            preset.name,
            [h.Class('flex items-center gap-3')],
            [
              h.span([
                h.Class('h-4 w-4 rounded-full'),
                h.Style({ background: presetSwatch(preset) }),
              ]),
              h.span([h.Class('flex-1 truncate')], [preset.name]),
              PresetLook.match(preset.look, {
                Rainbow: () => h.span([h.Class(CAPTION)], ['Built in']),
                Color: () => editPresetButtonView(preset, h),
                White: () => editPresetButtonView(preset, h),
              }),
            ],
          ),
        ),
      ),
    ],
  )

const editPresetButtonView = (preset: Preset, h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type('button'),
      h.AriaLabel(`Edit ${preset.name}`),
      h.OnClick(Message.ClickedEditPreset({ preset: preset.name })),
      h.Class('text-sm text-stone-400 hover:text-stone-200'),
    ],
    ['Edit'],
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
      h.Class(`${CARD} flex flex-col gap-3`),
      h.AriaLabel(isNew ? 'New preset' : 'Edit preset'),
      h.OnSubmit(Message.SubmittedEditor()),
    ],
    [
      h.input([
        h.Type('text'),
        h.AriaLabel('Preset name'),
        h.Placeholder('Preset name'),
        h.Value(editing.name),
        h.OnInput(value => Message.UpdatedEditorName({ value })),
        h.Class('rounded-lg bg-stone-800 px-3 py-2 text-stone-100'),
      ]),
      rangeView(
        'Preset brightness',
        MIN_BRIGHTNESS,
        MAX_BRIGHTNESS,
        editing.brightness,
        value => Message.UpdatedEditorBrightness({ value }),
        h,
      ),
      lookEditorView(editing, h),
      Option.match(maybeProblem, {
        onNone: () => h.empty,
        onSome: problem => h.p([h.Class(CAPTION)], [problem]),
      }),
      h.div(
        [h.Class('flex gap-2')],
        [
          h.button(
            [
              h.Type('submit'),
              h.Disabled(Option.isSome(maybeProblem)),
              h.Class(
                'rounded-lg bg-amber-300 px-4 py-2 text-sm font-semibold text-stone-950 disabled:opacity-40',
              ),
            ],
            ['Save'],
          ),
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedCancelEditor()),
              h.Class(QUIET_BUTTON),
            ],
            ['Cancel'],
          ),
          isNew
            ? h.empty
            : h.button(
                [
                  h.Type('button'),
                  h.OnClick(Message.ClickedDeletePreset()),
                  h.Class(
                    'ml-auto rounded-lg px-3 py-2 text-sm text-red-300 hover:bg-red-950',
                  ),
                ],
                ['Delete'],
              ),
        ],
      ),
    ],
  )
}

const lookEditorView = (
  editing: EditingPreset,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-2')],
    [
      h.div(
        [h.Class('flex gap-2')],
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
          rangeView(
            'Preset temperature',
            153,
            555,
            colorTemp,
            value =>
              Message.UpdatedEditorLook({
                look: SavablePresetLook.White({ colorTemp: value }),
              }),
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
            h.Class('h-11 w-full rounded-lg bg-transparent'),
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
  h.button(
    [
      h.Type('button'),
      h.AriaPressed(String(isSelected)),
      h.OnClick(Message.UpdatedEditorLook({ look })),
      h.Class(
        isSelected
          ? 'rounded-lg bg-stone-200 px-3 py-2 text-sm text-stone-950'
          : QUIET_BUTTON,
      ),
    ],
    [label],
  )
