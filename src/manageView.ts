import { Array, Option, Order, pipe } from 'effect'
import { Submodel } from 'foldkit'
import { type Html, type HtmlBuilder } from 'foldkit/html'
import { Check, ChevronLeft, ChevronRight, Plus } from 'lucide'

import { Alert } from '@/components/ui/alert'
import { button } from '@/components/ui/button'
import { input } from '@/components/ui/input'
import { spinner } from '@/components/ui/spinner'
import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'

import {
  type Group,
  type GroupPlace,
  type Light,
  type NewDevice,
  Pairing,
  buildLightTree,
  currentPlace,
  groupPlaces,
  isUnnamed,
  wholeHouseGroupNames,
} from './domain'
import {
  type Context,
  type Failure,
  GROUPS_USED_BY_NAME,
  Message,
  type Model,
  Screen,
  findGroup,
  findLight,
  isBusy,
  nameIsChanged,
  nameProblem,
} from './manage'
import { isOutsideWholeHouse } from './wholeHouse'

const CARD =
  'flex flex-col gap-3 rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10'
const LIST =
  'flex flex-col divide-y divide-border overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10'
const CAPTION = 'text-xs text-muted-foreground'
const GROUP_LABEL = 'text-xs font-semibold text-muted-foreground'
const SCREEN = 'flex flex-col gap-4'
const SCREEN_TITLE = 'break-words text-xl font-semibold'
const SECTION = 'flex flex-col gap-2'
const ROW_BUTTON =
  'flex min-h-14 w-full items-center gap-3 px-4 py-2 text-left hover:bg-muted/50'
const PLACE_INDENT_REM = 1.25
const SECONDS_PER_MINUTE = 60

export type ViewInputs = Readonly<{
  context: Context
  pairing: Pairing
  isLive: boolean
}>

type Inputs = ViewInputs

export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, inputs, h): Html =>
    h.div(
      [h.Class(SCREEN)],
      [
        operationStatusView(model, h),
        failureView(model, h),
        noticeView(model, h),
        h.div(
          [
            h.Inert(!inputs.isLive),
            h.Class(cn(!inputs.isLive && 'opacity-50')),
          ],
          [
            Screen.match(model.screen, {
              List: () => listView(model, inputs, h),
              NewLight: ({ address }) =>
                newLightView(model, inputs, address, h),
              Light: ({ address }) => lightView(model, inputs, address, h),
              Group: ({ name }) => groupView(model, inputs, name, h),
              NewGroup: () => newGroupView(model, inputs, h),
            }),
          ],
        ),
      ],
    ),
)

// STATUS

const operationStatusView = (model: Model, h: HtmlBuilder<Message>): Html =>
  isBusy(model)
    ? h.div(
        [
          h.Role('status'),
          h.Class('flex items-center gap-2 text-sm text-muted-foreground'),
        ],
        [spinner<Message>({ className: 'size-3.5' }, h), 'Working on it…'],
      )
    : h.empty

const failureActionsView = (failure: Failure, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('mt-2 flex flex-wrap gap-2')],
    [
      Option.isSome(failure.maybeForceRemoval)
        ? button<Message>(
            {
              variant: 'destructive',
              size: 'sm',
              onClick: Message.ClickedForceRemove(),
            },
            'Remove anyway',
            h,
          )
        : h.empty,
      button<Message>(
        {
          variant: 'ghost',
          size: 'sm',
          onClick: Message.ClickedDismissFailure(),
        },
        'Dismiss',
        h,
      ),
    ],
  )

const failureView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.maybeFailure, {
    onNone: () => h.empty,
    onSome: failure =>
      Alert<Message>(
        { variant: 'destructive' },
        [
          Alert.description<Message>(
            {},
            [failure.reason, failureActionsView(failure, h)],
            h,
          ),
        ],
        h,
      ),
  })

const noticeView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.maybeNotice, {
    onNone: () => h.empty,
    onSome: notice =>
      h.p([h.Role('status'), h.Class('text-sm text-emerald-400')], [notice]),
  })

// SHARED

const backButtonView = (h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(Message.SelectedScreen({ screen: Screen.List() })),
      h.Class(
        '-ml-1 flex items-center gap-1 self-start py-1 text-sm text-muted-foreground hover:text-foreground',
      ),
    ],
    [icon(h, ChevronLeft), 'Manage'],
  )

const openRowView = (
  key: string,
  title: string,
  detail: string,
  screen: Screen,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('button')(
    key,
    [
      h.Type('button'),
      h.AriaLabel(`Open ${title}`),
      h.OnClick(Message.SelectedScreen({ screen })),
      h.Class(ROW_BUTTON),
    ],
    [
      h.span(
        [h.Class('flex min-w-0 flex-1 flex-col gap-0.5')],
        [
          h.span([h.Class('break-words text-sm font-medium')], [title]),
          h.span([h.Class(CAPTION)], [detail]),
        ],
      ),
      icon(h, ChevronRight, 'size-4 shrink-0 text-muted-foreground'),
    ],
  )

const checkView = (
  isChecked: boolean,
  role: 'radio' | 'checkbox',
  h: HtmlBuilder<Message>,
): Html =>
  h.span(
    [
      h.Class(
        cn(
          'flex size-5 shrink-0 items-center justify-center border',
          role === 'radio' ? 'rounded-full' : 'rounded',
          isChecked
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-input',
        ),
      ),
    ],
    [isChecked ? icon(h, Check, 'size-3.5') : h.empty],
  )

const checkRowView = (
  key: string,
  label: string,
  depth: number,
  isChecked: boolean,
  role: 'radio' | 'checkbox',
  message: Message,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('button')(
    key,
    [
      h.Type('button'),
      h.Role(role),
      h.AriaChecked(isChecked),
      h.OnClick(message),
      h.Class(ROW_BUTTON),
      h.Style({ paddingLeft: `${1 + depth * PLACE_INDENT_REM}rem` }),
    ],
    [
      checkView(isChecked, role, h),
      h.span([h.Class('min-w-0 break-words text-sm')], [label]),
    ],
  )

const nameFieldView = (
  model: Model,
  inputs: Inputs,
  id: string,
  label: string,
  placeholder: string,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeProblem = nameProblem(model, inputs.context)
  const isShowingProblem = Option.isSome(maybeProblem) && model.nameDraft !== ''
  return input<Message>(
    {
      id,
      label,
      placeholder,
      value: model.nameDraft,
      onInput: value => Message.UpdatedName({ value }),
      isInvalid: isShowingProblem,
      ...(isShowingProblem
        ? { description: Option.getOrElse(maybeProblem, () => '') }
        : {}),
    },
    h,
  )
}

const renameFormView = (
  model: Model,
  inputs: Inputs,
  id: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.form(
    [h.OnSubmit(Message.SubmittedName()), h.Class('flex flex-col gap-2')],
    [
      nameFieldView(model, inputs, id, 'Name', '', h),
      nameIsChanged(model, inputs.context)
        ? button<Message>(
            {
              type: 'submit',
              size: 'lg',
              isDisabled:
                isBusy(model) ||
                Option.isSome(nameProblem(model, inputs.context)),
              className: 'self-start px-4',
            },
            'Save name',
            h,
          )
        : h.empty,
    ],
  )

const removeSectionView = (
  model: Model,
  label: string,
  warning: string,
  h: HtmlBuilder<Message>,
): Html =>
  model.removal === 'Confirming'
    ? h.div(
        [h.Class(cn(CARD, 'ring-destructive/40'))],
        [
          h.p([h.Class('text-sm')], [warning]),
          h.div(
            [h.Class('flex gap-2')],
            [
              button<Message>(
                {
                  variant: 'destructive',
                  size: 'lg',
                  isDisabled: isBusy(model),
                  onClick: Message.ClickedConfirmRemove(),
                  className: 'px-4',
                },
                'Remove',
                h,
              ),
              button<Message>(
                {
                  variant: 'secondary',
                  size: 'lg',
                  onClick: Message.ClickedCancelRemove(),
                  className: 'px-4',
                },
                'Cancel',
                h,
              ),
            ],
          ),
        ],
      )
    : button<Message>(
        {
          variant: 'destructive',
          size: 'lg',
          isDisabled: isBusy(model),
          onClick: Message.ClickedRemove(),
          className: 'self-start px-4',
        },
        label,
        h,
      )

const missingView = (text: string, h: HtmlBuilder<Message>): Html =>
  h.div([h.Class(SCREEN)], [backButtonView(h), h.p([h.Class(CAPTION)], [text])])

const placesListView = (
  model: Model,
  places: ReadonlyArray<GroupPlace>,
  maybeSelected: Option.Option<string>,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class(cn(LIST, isBusy(model) && 'opacity-60')), h.Role('radiogroup')],
    Array.map(places, place =>
      checkRowView(
        place.name,
        place.name,
        place.depth,
        Option.contains(maybeSelected, place.name),
        'radio',
        Message.SelectedPlace({ group: place.name }),
        h,
      ),
    ),
  )

// LIST

const minutesAndSeconds = (totalSeconds: number): string =>
  `${Math.floor(totalSeconds / SECONDS_PER_MINUTE)}:${(
    totalSeconds % SECONDS_PER_MINUTE
  )
    .toString()
    .padStart(2, '0')}`

const pairingTimeLeft = (
  model: Model,
  maybeEndsAt: Option.Option<number>,
): string =>
  pipe(
    Option.all({ endsAt: maybeEndsAt, nowMs: model.maybeNowMs }),
    Option.match({
      onNone: () => '',
      onSome: ({ endsAt, nowMs }) =>
        ` · ${minutesAndSeconds(Math.max(0, Math.ceil((endsAt - nowMs) / 1000)))} left`,
    }),
  )

const pairingCardView = (
  model: Model,
  pairing: Pairing,
  h: HtmlBuilder<Message>,
): Html =>
  Pairing.match(pairing, {
    Closed: () =>
      h.div(
        [h.Class(CARD)],
        [
          h.h2([h.Class('text-base font-semibold')], ['Add a light']),
          h.p(
            [h.Class(CAPTION)],
            [
              'Screw in the new bulb and switch it on, then start pairing. It shows up here once it joins.',
            ],
          ),
          button<Message>(
            {
              size: 'lg',
              isDisabled: isBusy(model),
              onClick: Message.ClickedStartPairing(),
              className: 'self-start px-4',
            },
            'Start pairing',
            h,
          ),
        ],
      ),
    Open: ({ maybeEndsAt }) =>
      h.div(
        [h.Class(cn(CARD, 'ring-primary/50'))],
        [
          h.h2(
            [h.Class('flex items-center gap-2 text-base font-semibold')],
            [
              spinner<Message>({ className: 'size-4' }, h),
              `Looking for new lights${pairingTimeLeft(model, maybeEndsAt)}`,
            ],
          ),
          h.p(
            [h.Class(CAPTION)],
            [
              'Switch the bulb on now. If it has been paired before, flick it off and on 6 times to reset it.',
            ],
          ),
          button<Message>(
            {
              variant: 'secondary',
              size: 'lg',
              isDisabled: isBusy(model),
              onClick: Message.ClickedStopPairing(),
              className: 'self-start px-4',
            },
            'Stop pairing',
            h,
          ),
        ],
      ),
  })

const newDeviceDetail = (device: NewDevice): string => {
  if (device.setup === 'Joining') {
    return 'Setting it up…'
  }
  if (device.setup === 'Failed') {
    return "Couldn't finish setting it up"
  }
  if (device.setup === 'NotALight') {
    return 'Not a light'
  }
  return Option.getOrElse(device.maybeDescription, () => 'Ready to name')
}

const newDevicesView = (
  newDevices: ReadonlyArray<NewDevice>,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(newDevices, {
    onEmpty: () => h.empty,
    onNonEmpty: devices =>
      h.section(
        [h.Class(SECTION)],
        [
          h.h2([h.Class(GROUP_LABEL)], ['Waiting for a name']),
          h.div(
            [h.Class(LIST)],
            Array.map(devices, device =>
              openRowView(
                device.address,
                'New device',
                newDeviceDetail(device),
                Screen.NewLight({ address: device.address }),
                h,
              ),
            ),
          ),
        ],
      ),
  })

const placeDetail = (light: Light, context: Context): string =>
  isOutsideWholeHouse(light.name)
    ? 'Not part of the whole house'
    : Option.getOrElse(
        currentPlace(context.lights, context.groups, light.address),
        () => 'Not in a group',
      )

const outsideWholeHouseView = (h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class(SECTION)],
    [
      h.h2([h.Class(GROUP_LABEL)], ['Not part of the whole house']),
      h.p(
        [h.Class(CAPTION)],
        [
          'This light stays out of every group, so groups, scenes, and automations never change its color or brightness. It still turns on and off with the room around it and with the whole house, and its own controls change everything.',
        ],
      ),
    ],
  )

const nameOrder = Order.mapInput(
  Order.String,
  (entity: Readonly<{ name: string }>) => entity.name,
)

const lightsSectionView = (context: Context, h: HtmlBuilder<Message>): Html => {
  const namedLights = pipe(
    context.lights,
    Array.filter(light => !isUnnamed(light)),
    Array.sort(nameOrder),
  )
  return h.section(
    [h.Class(SECTION)],
    [
      h.h2([h.Class(GROUP_LABEL)], ['Lights']),
      Array.match(namedLights, {
        onEmpty: () =>
          h.p([h.Class(CAPTION)], ['No lights yet. Pair one above.']),
        onNonEmpty: lights =>
          h.div(
            [h.Class(LIST)],
            Array.map(lights, light =>
              openRowView(
                light.address,
                light.name,
                placeDetail(light, context),
                Screen.Light({ address: light.address }),
                h,
              ),
            ),
          ),
      }),
    ],
  )
}

const lightCount = (group: Group): string =>
  group.memberAddresses.length === 1
    ? '1 light'
    : `${group.memberAddresses.length} lights`

const groupsSectionView = (context: Context, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class(SECTION)],
    [
      h.div(
        [h.Class('flex items-center justify-between')],
        [
          h.h2([h.Class(GROUP_LABEL)], ['Groups']),
          button<Message>(
            {
              variant: 'ghost',
              size: 'sm',
              onClick: Message.SelectedScreen({ screen: Screen.NewGroup() }),
            },
            [icon(h, Plus), 'New group'],
            h,
          ),
        ],
      ),
      Array.match(context.groups, {
        onEmpty: () => h.p([h.Class(CAPTION)], ['No groups yet.']),
        onNonEmpty: groups =>
          h.div(
            [h.Class(LIST)],
            Array.map(Array.sort(groups, nameOrder), group =>
              openRowView(
                group.name,
                group.name,
                lightCount(group),
                Screen.Group({ name: group.name }),
                h,
              ),
            ),
          ),
      }),
    ],
  )

const listView = (
  model: Model,
  inputs: Inputs,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-6')],
    [
      pairingCardView(model, inputs.pairing, h),
      newDevicesView(inputs.context.newDevices, h),
      lightsSectionView(inputs.context, h),
      groupsSectionView(inputs.context, h),
    ],
  )

// NEW LIGHT

const newLightFormView = (
  model: Model,
  inputs: Inputs,
  device: NewDevice,
  h: HtmlBuilder<Message>,
): Html => {
  const { context } = inputs
  const places = groupPlaces(context.lights, context.groups)
  const maybeSelected = Option.orElse(model.maybeChosenPlace, () =>
    Array.head(
      wholeHouseGroupNames(context.lights, context.groups, device.address),
    ),
  )
  return h.form(
    [h.OnSubmit(Message.SubmittedNewLight()), h.Class(SCREEN)],
    [
      nameFieldView(model, inputs, 'new-light-name', 'Name', 'Porch Lamp', h),
      Array.isReadonlyArrayEmpty(places)
        ? h.empty
        : h.section(
            [h.Class(SECTION)],
            [
              h.h2([h.Class(GROUP_LABEL)], ['Where does it go?']),
              placesListView(model, places, maybeSelected, h),
            ],
          ),
      button<Message>(
        {
          type: 'submit',
          size: 'lg',
          isDisabled:
            isBusy(model) || Option.isSome(nameProblem(model, inputs.context)),
          className: 'self-start px-4',
        },
        'Add light',
        h,
      ),
    ],
  )
}

const newLightBodyView = (
  model: Model,
  inputs: Inputs,
  device: NewDevice,
  h: HtmlBuilder<Message>,
): Html => {
  if (device.setup === 'Joining') {
    return h.p(
      [h.Role('status'), h.Class('flex items-center gap-2 text-sm')],
      [
        spinner<Message>({ className: 'size-4' }, h),
        'Setting it up. This can take a minute, so leave it switched on.',
      ],
    )
  }
  if (device.setup === 'ReadyLight') {
    return newLightFormView(model, inputs, device, h)
  }
  return h.div(
    [h.Class(SCREEN)],
    [
      h.p(
        [h.Class('text-sm')],
        [
          device.setup === 'Failed'
            ? "It joined, but setup didn't finish. Remove it, reset the bulb, then pair it again."
            : 'This device joined the network, but it is not a light, so this app can’t control it.',
        ],
      ),
      removeSectionView(
        model,
        'Remove it',
        'This takes the device off the Zigbee network.',
        h,
      ),
    ],
  )
}

const newLightView = (
  model: Model,
  inputs: Inputs,
  address: string,
  h: HtmlBuilder<Message>,
): Html =>
  Option.match(
    Array.findFirst(
      inputs.context.newDevices,
      device => device.address === address,
    ),
    {
      onNone: () =>
        missingView('That device is already set up or has left.', h),
      onSome: device =>
        h.div(
          [h.Class(SCREEN)],
          [
            backButtonView(h),
            h.h2([h.Class(SCREEN_TITLE)], ['New light']),
            Option.match(device.maybeDescription, {
              onNone: () => h.empty,
              onSome: description => h.p([h.Class(CAPTION)], [description]),
            }),
            newLightBodyView(model, inputs, device, h),
          ],
        ),
    },
  )

// LIGHT

const alsoInView = (
  model: Model,
  light: Light,
  context: Context,
  h: HtmlBuilder<Message>,
): Html =>
  Array.match(buildLightTree(context.lights, context.groups).crossingGroups, {
    onEmpty: () => h.empty,
    onNonEmpty: crossingGroups =>
      h.section(
        [h.Class(SECTION)],
        [
          h.h2([h.Class(GROUP_LABEL)], ['Also in']),
          h.div(
            [h.Class(cn(LIST, isBusy(model) && 'opacity-60'))],
            Array.map(crossingGroups, node =>
              checkRowView(
                node.group.name,
                node.group.name,
                0,
                Array.contains(node.group.memberAddresses, light.address),
                'checkbox',
                Message.ClickedAlsoIn({ group: node.group.name }),
                h,
              ),
            ),
          ),
        ],
      ),
  })

const lightView = (
  model: Model,
  inputs: Inputs,
  address: string,
  h: HtmlBuilder<Message>,
): Html => {
  const { context } = inputs
  return Option.match(findLight(context.lights, address), {
    onNone: () => missingView('That light is no longer paired.', h),
    onSome: light => {
      const places = groupPlaces(context.lights, context.groups)
      return h.div(
        [h.Class(SCREEN)],
        [
          backButtonView(h),
          h.h2([h.Class(SCREEN_TITLE)], [light.name]),
          renameFormView(model, inputs, 'light-name', h),
          ...(isOutsideWholeHouse(light.name)
            ? [outsideWholeHouseView(h)]
            : [
                Array.isReadonlyArrayEmpty(places)
                  ? h.empty
                  : h.section(
                      [h.Class(SECTION)],
                      [
                        h.h2([h.Class(GROUP_LABEL)], ['Move to']),
                        placesListView(
                          model,
                          places,
                          currentPlace(context.lights, context.groups, address),
                          h,
                        ),
                      ],
                    ),
                alsoInView(model, light, context, h),
              ]),
          removeSectionView(
            model,
            'Remove light',
            'This takes the bulb off the Zigbee network. To use it again you will need to pair it again.',
            h,
          ),
        ],
      )
    },
  })
}

// GROUP

const groupNameWarning = (name: string, h: HtmlBuilder<Message>): Html =>
  Array.contains(GROUPS_USED_BY_NAME, name)
    ? h.p(
        [h.Class(CAPTION)],
        [
          'Presets and scene buttons look for this group by name, so renaming or removing it can stop them working.',
        ],
      )
    : h.empty

const memberRowsView = (
  lights: ReadonlyArray<Light>,
  isChecked: (address: string) => boolean,
  toMessage: (address: string) => Message,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  Array.map(Array.sort(lights, nameOrder), light =>
    checkRowView(
      light.address,
      light.name,
      0,
      isChecked(light.address),
      'checkbox',
      toMessage(light.address),
      h,
    ),
  )

const groupView = (
  model: Model,
  inputs: Inputs,
  name: string,
  h: HtmlBuilder<Message>,
): Html => {
  const { context } = inputs
  return Option.match(findGroup(context.groups, name), {
    onNone: () => missingView('That group no longer exists.', h),
    onSome: group =>
      h.div(
        [h.Class(SCREEN)],
        [
          backButtonView(h),
          h.h2([h.Class(SCREEN_TITLE)], [group.name]),
          renameFormView(model, inputs, 'group-name', h),
          groupNameWarning(group.name, h),
          h.section(
            [h.Class(SECTION)],
            [
              h.h2([h.Class(GROUP_LABEL)], ['Lights in this group']),
              h.p(
                [h.Class(CAPTION)],
                [
                  'Adding a light also adds it to any group this one sits inside. Taking one out also takes it out of the groups inside this one.',
                ],
              ),
              h.div(
                [h.Class(cn(LIST, isBusy(model) && 'opacity-60'))],
                memberRowsView(
                  Array.filter(
                    context.lights,
                    light =>
                      !isOutsideWholeHouse(light.name) ||
                      Array.contains(group.memberAddresses, light.address),
                  ),
                  address => Array.contains(group.memberAddresses, address),
                  address => Message.ClickedMember({ address }),
                  h,
                ),
              ),
            ],
          ),
          removeSectionView(
            model,
            'Remove group',
            'The lights stay paired. Only the group goes away.',
            h,
          ),
        ],
      ),
  })
}

const newGroupView = (
  model: Model,
  inputs: Inputs,
  h: HtmlBuilder<Message>,
): Html =>
  h.form(
    [h.OnSubmit(Message.SubmittedName()), h.Class(SCREEN)],
    [
      backButtonView(h),
      h.h2([h.Class(SCREEN_TITLE)], ['New group']),
      nameFieldView(model, inputs, 'new-group-name', 'Name', 'Office', h),
      h.section(
        [h.Class(SECTION)],
        [
          h.h2([h.Class(GROUP_LABEL)], ['Lights in this group']),
          h.div(
            [h.Class(LIST)],
            memberRowsView(
              inputs.context.lights,
              address => Array.contains(model.memberDraft, address),
              address => Message.ClickedDraftMember({ address }),
              h,
            ),
          ),
        ],
      ),
      button<Message>(
        {
          type: 'submit',
          size: 'lg',
          isDisabled:
            isBusy(model) || Option.isSome(nameProblem(model, inputs.context)),
          className: 'self-start px-4',
        },
        'Create group',
        h,
      ),
    ],
  )
