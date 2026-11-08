import { Array, Match, Option, pipe } from 'effect'
import { Submodel } from 'foldkit'
import { type Html, type HtmlBuilder } from 'foldkit/html'
import { ChevronDown, ChevronLeft, ChevronRight, X } from 'lucide'

import { switch_ } from '@/components/ui/switch'
import { icon } from '@/lib/icons'
import { cn } from '@/lib/utils'

import {
  type ActivityEntry,
  type ActivityKind,
  type CheckLevel,
  type DayWindow,
  type HealthCheck,
  MIN_FLASH_STEP_MS,
  type OutsideWindow,
  type OverallHealth,
  type PrMergeConfig,
  type RateWindow,
  type Snapshot,
  WatcherMode,
  hasSameHours,
  sharedHours,
  withSameHours,
} from './automation'
import {
  Action,
  type ConnectionSection,
  type EntryList,
  Message,
  type Model,
  type PrMergedSection,
  Remote,
  type Reveal,
  SaveState,
  Screen,
  draftProblem,
  updated,
} from './automations'

const CARD =
  'flex flex-col gap-4 rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10'
const LIST =
  'flex flex-col divide-y divide-border overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10'
const CAPTION = 'text-xs text-muted-foreground'
const FIELD_LABEL = 'text-sm text-muted-foreground'
const GROUP_LABEL = 'text-xs font-semibold text-muted-foreground'
const INPUT =
  'w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm text-foreground'
const QUIET_BUTTON =
  'rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground hover:bg-secondary/80 disabled:opacity-40'
const PRIMARY_BUTTON =
  'rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-40'
const TEXT_BUTTON =
  'self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground'
const SECTION_TITLE = 'text-base font-semibold'
const SCREEN_TITLE = 'text-xl font-semibold'
const SCREEN = 'flex flex-col gap-3'
const CHIP =
  'rounded-full px-3 py-1.5 text-xs bg-muted text-muted-foreground hover:text-foreground'
const CHIP_SELECTED =
  'rounded-full px-3 py-1.5 text-xs font-semibold bg-primary text-primary-foreground'

const PR_MERGED_NAME = 'PR merged'
const ACTIVITY_PREVIEW = 3
const ACTIVITY_SHOWN = 40
const LIGHT_CHECK_IDS: ReadonlyArray<string> = ['broker', 'bridge', 'group']

const PAUSE_CHOICES: ReadonlyArray<
  Readonly<{ label: string; minutes: number }>
> = [
  { label: '30 min', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '4 hours', minutes: 240 },
  { label: '1 day', minutes: 1440 },
]

const FLASH_SPEEDS: ReadonlyArray<
  Readonly<{ label: string; onMs: number; offMs: number }>
> = [
  { label: 'Slow', onMs: 1200, offMs: 800 },
  { label: 'Normal', onMs: 700, offMs: 450 },
  { label: 'Fast', onMs: MIN_FLASH_STEP_MS, offMs: MIN_FLASH_STEP_MS },
]

const POLL_CHOICES: ReadonlyArray<
  Readonly<{ label: string; seconds: number }>
> = [
  { label: '5s', seconds: 5 },
  { label: '15s', seconds: 15 },
  { label: '1m', seconds: 60 },
]

export type ViewInputs = Readonly<{
  groupNames: ReadonlyArray<string>
}>

export const view = Submodel.defineView<Model, Message, ViewInputs>(
  (model, { groupNames }, h): Html =>
    Remote.match(model.remote, {
      Loading: () =>
        h.p(
          [h.Class('py-16 text-center text-muted-foreground')],
          ['Loading automations…'],
        ),
      Unreachable: ({ reason }) => unreachableView(reason, h),
      Loaded: ({ snapshot }) => loadedView(model, snapshot, groupNames, h),
    }),
)

const unreachableView = (reason: string, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class(CARD), h.AriaLabel('Automations')],
    [
      h.h2([h.Class(SECTION_TITLE)], ['Automations']),
      h.p(
        [h.Class('text-sm text-destructive'), h.Role('alert')],
        [`Service unreachable: ${reason}.`],
      ),
      h.p(
        [h.Class(CAPTION)],
        [
          'The automations service runs on the same machine as the app. It restarts itself after a crash.',
        ],
      ),
    ],
  )

const loadedView = (
  model: Model,
  snapshot: Snapshot,
  groupNames: ReadonlyArray<string>,
  h: HtmlBuilder<Message>,
): Html => {
  const draft = Option.getOrElse(model.maybeDraft, () => snapshot.config)
  return h.form(
    [
      h.Class('flex flex-col gap-4'),
      h.AriaLabel('Automations'),
      h.OnSubmit(Message.SubmittedDraft()),
    ],
    [
      Option.match(
        Option.orElse(
          Option.map(
            model.maybeUnreachableReason,
            reason =>
              `Service not responding: ${reason}. Showing the last status it reported.`,
          ),
          () => model.maybeProblem,
        ),
        {
          onNone: () => h.empty,
          onSome: problem =>
            h.p(
              [
                h.Class(
                  'rounded-lg border border-destructive/40 bg-card p-3 text-sm text-destructive',
                ),
                h.Role('alert'),
              ],
              [problem],
            ),
        },
      ),
      Screen.match(model.screen, {
        List: () => listScreen(model, snapshot, h),
        PrMerged: ({ maybeOpenSection }) =>
          prMergedScreen(
            model,
            snapshot,
            draft,
            maybeOpenSection,
            groupNames,
            h,
          ),
        Connections: ({ maybeOpenSection }) =>
          connectionsScreen(model, snapshot, draft, maybeOpenSection, h),
      }),
      saveBarView(model, draft, h),
    ],
  )
}

// SHARED

const isRevealed = (model: Model, reveal: Reveal): boolean =>
  Array.contains(model.revealed, reveal)

const backButtonView = (h: HtmlBuilder<Message>): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(Message.SelectedScreen({ screen: Screen.List() })),
      h.Class(
        '-ml-1 flex items-center gap-1 self-start py-1 text-sm text-muted-foreground hover:text-foreground',
      ),
    ],
    [icon(h, ChevronLeft), 'Automations'],
  )

const revealLinkView = (
  label: string,
  reveal: Reveal,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.OnClick(Message.ClickedReveal({ reveal })),
      h.Class(TEXT_BUTTON),
    ],
    [label],
  )

type AccordionRow = Readonly<{
  panelId: string
  eyebrow: string
  summary: string
  maybeLeading: Option.Option<Html>
  isOpen: boolean
  onToggle: Message
  body: ReadonlyArray<Html>
}>

const accordionRowView = (row: AccordionRow, h: HtmlBuilder<Message>): Html =>
  h.div(
    [],
    [
      h.button(
        [
          h.Type('button'),
          h.AriaLabel(`${row.eyebrow}: ${row.summary}`),
          h.AriaExpanded(row.isOpen),
          h.OnClick(row.onToggle),
          ...(row.isOpen ? [h.AriaControls(row.panelId)] : []),
          h.Class(
            'flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40',
          ),
        ],
        [
          Option.getOrElse(row.maybeLeading, () => h.empty),
          h.span(
            [h.Class('flex min-w-0 flex-1 flex-col gap-0.5')],
            [
              h.span(
                [h.Class('text-xs font-semibold text-muted-foreground')],
                [row.eyebrow],
              ),
              h.span([h.Class('break-words text-sm')], [row.summary]),
            ],
          ),
          icon(
            h,
            ChevronRight,
            cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              row.isOpen && 'rotate-90',
            ),
          ),
        ],
      ),
      row.isOpen
        ? h.div(
            [h.Id(row.panelId), h.Class('flex flex-col gap-4 px-4 pb-4 pt-1')],
            row.body,
          )
        : h.empty,
    ],
  )

const toggledSection = <A>(
  maybeOpen: Option.Option<A>,
  section: A,
): Option.Option<A> =>
  Option.exists(maybeOpen, open => open === section)
    ? Option.none()
    : Option.some(section)

const colorDotView = (
  hex: string,
  sizeClass: string,
  isDimmed: boolean,
  h: HtmlBuilder<Message>,
): Html =>
  h.span([
    h.Class(
      cn(
        'shrink-0 rounded-full ring-1 ring-foreground/15',
        sizeClass,
        isDimmed && 'opacity-40',
      ),
    ),
    h.Style({ background: hex }),
  ])

type Choice<A> = Readonly<{ label: string; value: A }>

const choiceChipsView = <A>(
  label: string,
  choices: ReadonlyArray<Choice<A>>,
  isSelected: (value: A) => boolean,
  toMessage: (value: A) => Message,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-1.5')],
    [
      h.span([h.Class(FIELD_LABEL)], [label]),
      h.div(
        [
          h.Class('flex flex-wrap gap-1.5'),
          h.Role('radiogroup'),
          h.AriaLabel(label),
        ],
        Array.map(choices, choice =>
          h.keyed('button')(
            choice.label,
            [
              h.Type('button'),
              h.Role('radio'),
              h.AriaChecked(isSelected(choice.value)),
              h.OnClick(toMessage(choice.value)),
              h.Class(isSelected(choice.value) ? CHIP_SELECTED : CHIP),
            ],
            [choice.label],
          ),
        ),
      ),
    ],
  )

// STATUS

const overallLabel = (overall: OverallHealth): string =>
  Match.value(overall).pipe(
    Match.when('Healthy', () => 'Healthy'),
    Match.when('Warning', () => 'Needs attention'),
    Match.when('Unhealthy', () => 'Unhealthy'),
    Match.when('Off', () => 'Off'),
    Match.exhaustive,
  )

const overallClass = (overall: OverallHealth): string =>
  Match.value(overall).pipe(
    Match.when('Healthy', () => 'bg-emerald-500/15 text-emerald-300'),
    Match.when('Warning', () => 'bg-amber-500/15 text-amber-300'),
    Match.when('Unhealthy', () => 'bg-destructive/15 text-destructive'),
    Match.when('Off', () => 'bg-muted text-muted-foreground'),
    Match.exhaustive,
  )

const elapsed = (generatedAt: number, at: number): string => {
  const seconds = Math.max(0, Math.round((generatedAt - at) / 1000))
  if (seconds < 60) {
    return `${seconds}s ago`
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m ago`
  }
  if (seconds < 86_400) {
    return `${Math.round(seconds / 3600)}h ago`
  }
  return `${Math.round(seconds / 86_400)}d ago`
}

const remaining = (generatedAt: number, until: number): string => {
  const minutes = Math.max(1, Math.round((until - generatedAt) / 60_000))
  return minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`
}

const modeLabel = (snapshot: Snapshot): string =>
  WatcherMode.match(snapshot.mode, {
    Off: () => 'Turned off. Not watching GitHub.',
    Paused: ({ until }) =>
      `Paused for ${remaining(snapshot.generatedAt, until)}. Merges are recorded but won't flash.`,
    Watching: ({ isScheduleOpen }) =>
      isScheduleOpen
        ? 'Watching. The next merge will flash the lights.'
        : snapshot.config.schedule.whenOutside === 'WaitForWindow'
          ? 'Watching. Outside the schedule, so merges wait for it to open.'
          : "Watching. Outside the schedule, so merges won't flash.",
  })

const maybeAttention = (
  checks: ReadonlyArray<HealthCheck>,
): Option.Option<HealthCheck> =>
  Option.orElse(
    Array.findFirst(checks, check => check.level === 'Failing'),
    () => Array.findFirst(checks, check => check.level === 'Warning'),
  )

const attentionClass = (level: CheckLevel): string =>
  level === 'Failing' ? 'text-destructive' : 'text-amber-300'

const isRunning = (model: Model, tag: Action['_tag']): boolean =>
  Option.exists(model.maybeRunningAction, action => action._tag === tag)

const actionButton = (
  model: Model,
  label: string,
  runningLabel: string,
  action: Action,
  h: HtmlBuilder<Message>,
  extraClass = '',
): Html =>
  h.button(
    [
      h.Type('button'),
      h.Disabled(Option.isSome(model.maybeRunningAction)),
      h.OnClick(Message.ClickedAction({ action })),
      h.Class(cn(QUIET_BUTTON, extraClass)),
    ],
    [isRunning(model, action._tag) ? runningLabel : label],
  )

const enabledSwitchView = (
  model: Model,
  snapshot: Snapshot,
  id: string,
  h: HtmlBuilder<Message>,
): Html => {
  const isEnabled = snapshot.mode._tag !== 'Off'
  return switch_<Message>(
    {
      id,
      label: PR_MERGED_NAME,
      isChecked: isEnabled,
      isDisabled: Option.isSome(model.maybeRunningAction),
      onToggle: () =>
        Message.ClickedAction({
          action: Action.SetEnabled({ isEnabled: !isEnabled }),
        }),
      className: 'data-[size=default]:h-7 data-[size=default]:w-12',
      thumbClass:
        'bg-white shadow-sm dark:data-checked:bg-white dark:data-unchecked:bg-foreground group-data-[size=default]/switch:size-6 group-data-[size=default]/switch:data-checked:translate-x-[calc(100%-3px)] group-data-[size=default]/switch:data-unchecked:translate-x-px',
      labelClass: 'sr-only',
      wrapperClass: 'gap-0',
    },
    h,
  )
}

// SUMMARIES

const clockLabel = (clock: string): string => {
  if (clock.length < 5) {
    return 'not set'
  }
  const hour = Number(clock.slice(0, 2))
  const minutes = clock.slice(3, 5)
  const period = hour < 12 ? 'AM' : 'PM'
  const displayHour = hour % 12 === 0 ? 12 : hour % 12
  return minutes === '00'
    ? `${displayHour} ${period}`
    : `${displayHour}:${minutes} ${period}`
}

const daysLabel = (days: ReadonlyArray<DayWindow>): string => {
  const names = pipe(
    days,
    Array.filter(window => window.isEnabled),
    Array.map(window => window.day.slice(0, 3)),
  )
  const joined = names.join(',')
  return names.length === 7
    ? 'Every day'
    : joined === 'Mon,Tue,Wed,Thu,Fri'
      ? 'Weekdays'
      : joined === 'Sat,Sun'
        ? 'Weekends'
        : names.join(', ')
}

const scheduleSummary = (schedule: PrMergeConfig['schedule']): string => {
  if (!Array.some(schedule.days, window => window.isEnabled)) {
    return 'No days selected'
  }
  const { start, end } = sharedHours(schedule)
  return hasSameHours(schedule)
    ? `${daysLabel(schedule.days)}, ${clockLabel(start)} to ${clockLabel(end)}`
    : `${daysLabel(schedule.days)}, hours vary`
}

const whenSummary = (draft: PrMergeConfig): string => {
  const source = Array.match(draft.accounts, {
    onEmpty: () => 'A PR merges, but no account is set',
    onNonEmpty: accounts =>
      accounts.length === 1
        ? `A PR merges on ${accounts[0]}`
        : `A PR merges on ${accounts.length} accounts`,
  })
  const ignored = draft.ignoredRepos.length
  return ignored === 0
    ? source
    : `${source}, ${ignored} ${ignored === 1 ? 'repo' : 'repos'} ignored`
}

const flashSummary = (flash: PrMergeConfig['flash']): string =>
  `Flash ${flash.group} ${flash.count === 1 ? 'once' : `${flash.count} times`}`

// LIST

type RowStatus = Readonly<{ text: string; toneClass: string }>

const rowStatus = (model: Model, snapshot: Snapshot): RowStatus => {
  if (Option.isSome(model.maybeUnreachableReason)) {
    return { text: 'Not responding', toneClass: 'text-destructive' }
  }
  const muted = 'text-muted-foreground'
  const lastFlash = Option.match(snapshot.maybeLastFlashAt, {
    onNone: () => '',
    onSome: at => ` · Flashed ${elapsed(snapshot.generatedAt, at)}`,
  })
  return WatcherMode.match(snapshot.mode, {
    Off: () => ({ text: 'Off', toneClass: muted }),
    Paused: ({ until }) => ({
      text: `Paused for ${remaining(snapshot.generatedAt, until)}`,
      toneClass: muted,
    }),
    Watching: () =>
      Option.match(maybeAttention(snapshot.checks), {
        onSome: check => ({
          text: check.detail,
          toneClass: attentionClass(check.level),
        }),
        onNone: () => ({
          text: `${scheduleSummary(snapshot.config.schedule)}${lastFlash}`,
          toneClass: muted,
        }),
      }),
  })
}

const listScreen = (
  model: Model,
  snapshot: Snapshot,
  h: HtmlBuilder<Message>,
): Html => {
  const status = rowStatus(model, snapshot)
  return h.div(
    [h.Class(SCREEN)],
    [
      h.h2([h.Class(GROUP_LABEL)], ['Dev alerts']),
      h.div(
        [h.Class(LIST)],
        [
          h.div(
            [h.Class('flex items-center gap-3 pr-4')],
            [
              h.button(
                [
                  h.Type('button'),
                  h.AriaLabel(`Open ${PR_MERGED_NAME}`),
                  h.OnClick(
                    Message.SelectedScreen({
                      screen: Screen.PrMerged({
                        maybeOpenSection: Option.none(),
                      }),
                    }),
                  ),
                  h.Class(
                    'flex min-h-16 min-w-0 flex-1 items-center gap-3 py-3 pl-4 text-left',
                  ),
                ],
                [
                  colorDotView(
                    snapshot.config.flash.hex,
                    'size-7',
                    snapshot.mode._tag === 'Off',
                    h,
                  ),
                  h.span(
                    [h.Class('flex min-w-0 flex-col gap-0.5')],
                    [
                      h.span(
                        [h.Class('text-sm font-medium')],
                        [PR_MERGED_NAME],
                      ),
                      h.span(
                        [h.Class(cn('break-words text-xs', status.toneClass))],
                        [status.text],
                      ),
                    ],
                  ),
                ],
              ),
              enabledSwitchView(model, snapshot, 'pr-merged-list-enabled', h),
            ],
          ),
        ],
      ),
      h.div(
        [h.Class(cn(LIST, 'mt-2'))],
        [
          h.button(
            [
              h.Type('button'),
              h.AriaLabel('Open Connections'),
              h.OnClick(
                Message.SelectedScreen({
                  screen: Screen.Connections({
                    maybeOpenSection: Option.none(),
                  }),
                }),
              ),
              h.Class(
                'flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40',
              ),
            ],
            [
              h.span(
                [h.Class('flex min-w-0 flex-1 flex-col gap-0.5')],
                [
                  h.span([h.Class('text-sm font-medium')], ['Connections']),
                  h.span([h.Class(CAPTION)], ['GitHub, lights, service']),
                ],
              ),
              icon(h, ChevronRight, 'size-4 shrink-0 text-muted-foreground'),
            ],
          ),
        ],
      ),
    ],
  )
}

// PR MERGED

const prMergedScreen = (
  model: Model,
  snapshot: Snapshot,
  draft: PrMergeConfig,
  maybeOpenSection: Option.Option<PrMergedSection>,
  groupNames: ReadonlyArray<string>,
  h: HtmlBuilder<Message>,
): Html => {
  const row = (
    section: PrMergedSection,
    eyebrow: string,
    summary: string,
    maybeLeading: Option.Option<Html>,
    body: () => ReadonlyArray<Html>,
  ): Html => {
    const isOpen = Option.exists(maybeOpenSection, open => open === section)
    return accordionRowView(
      {
        panelId: `pr-merged-${section}`,
        eyebrow,
        summary,
        maybeLeading,
        isOpen,
        onToggle: Message.SelectedScreen({
          screen: Screen.PrMerged({
            maybeOpenSection: toggledSection(maybeOpenSection, section),
          }),
        }),
        body: isOpen ? body() : [],
      },
      h,
    )
  }
  return h.div(
    [h.Class(SCREEN)],
    [
      backButtonView(h),
      h.div(
        [h.Class('flex items-center justify-between gap-3')],
        [
          h.h2([h.Class(SCREEN_TITLE)], [PR_MERGED_NAME]),
          enabledSwitchView(model, snapshot, 'pr-merged-detail-enabled', h),
        ],
      ),
      statusLinesView(model, snapshot, h),
      actionsView(model, snapshot, maybeOpenSection, h),
      h.div(
        [h.Class(cn(LIST, 'mt-1'))],
        [
          row('When', 'When', whenSummary(draft), Option.none(), () =>
            whenBody(model, draft, h),
          ),
          row(
            'OnlyDuring',
            'Only during',
            scheduleSummary(draft.schedule),
            Option.none(),
            () => onlyDuringBody(model, draft, h),
          ),
          row(
            'Do',
            'Do',
            flashSummary(draft.flash),
            Option.some(colorDotView(draft.flash.hex, 'size-5', false, h)),
            () => doBody(model, draft, groupNames, h),
          ),
        ],
      ),
      activityView(model, snapshot, h),
    ],
  )
}

const statusLinesView = (
  model: Model,
  snapshot: Snapshot,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-1')],
    [
      h.p([h.Class('text-sm text-muted-foreground')], [modeLabel(snapshot)]),
      snapshot.heldMerges > 0
        ? h.p(
            [h.Class(CAPTION)],
            [`${snapshot.heldMerges} merges waiting for the schedule`],
          )
        : h.empty,
      Option.isSome(model.maybeUnreachableReason)
        ? h.empty
        : Option.match(maybeAttention(snapshot.checks), {
            onNone: () => h.empty,
            onSome: check =>
              h.div(
                [h.Class('flex flex-wrap items-baseline gap-x-2')],
                [
                  h.p(
                    [
                      h.Class(
                        cn('break-words text-sm', attentionClass(check.level)),
                      ),
                    ],
                    [check.detail],
                  ),
                  h.button(
                    [
                      h.Type('button'),
                      h.OnClick(
                        Message.SelectedScreen({
                          screen: Screen.Connections({
                            maybeOpenSection: Option.none(),
                          }),
                        }),
                      ),
                      h.Class(TEXT_BUTTON),
                    ],
                    ['See connections'],
                  ),
                ],
              ),
          }),
    ],
  )

const actionsView = (
  model: Model,
  snapshot: Snapshot,
  maybeOpenSection: Option.Option<PrMergedSection>,
  h: HtmlBuilder<Message>,
): Html => {
  const tryIt = actionButton(
    model,
    'Try it',
    'Flashing…',
    Action.TestFlash(),
    h,
    'flex-1',
  )
  return WatcherMode.match(snapshot.mode, {
    Off: () => h.div([h.Class('flex gap-2')], [tryIt]),
    Paused: () =>
      h.div(
        [h.Class('flex gap-2')],
        [
          tryIt,
          actionButton(
            model,
            'Resume now',
            'Resuming…',
            Action.Resume(),
            h,
            'flex-1',
          ),
        ],
      ),
    Watching: () => {
      const isPauseOpen = Option.exists(
        maybeOpenSection,
        open => open === 'Pause',
      )
      return h.div(
        [h.Class('flex flex-col gap-2')],
        [
          h.div(
            [h.Class('flex gap-2')],
            [
              tryIt,
              h.button(
                [
                  h.Type('button'),
                  h.AriaExpanded(isPauseOpen),
                  h.OnClick(
                    Message.SelectedScreen({
                      screen: Screen.PrMerged({
                        maybeOpenSection: toggledSection(
                          maybeOpenSection,
                          'Pause',
                        ),
                      }),
                    }),
                  ),
                  h.Class(
                    cn(
                      QUIET_BUTTON,
                      'flex flex-1 items-center justify-center gap-1',
                    ),
                  ),
                ],
                [
                  'Pause',
                  icon(
                    h,
                    ChevronDown,
                    cn(
                      'size-3.5 shrink-0 transition-transform',
                      isPauseOpen && 'rotate-180',
                    ),
                  ),
                ],
              ),
            ],
          ),
          isPauseOpen
            ? h.div(
                [h.Class('grid grid-cols-4 gap-2')],
                Array.map(PAUSE_CHOICES, ({ label, minutes }) =>
                  h.keyed('button')(
                    label,
                    [
                      h.Type('button'),
                      h.AriaLabel(`Pause for ${label}`),
                      h.Disabled(Option.isSome(model.maybeRunningAction)),
                      h.OnClick(
                        Message.ClickedAction({
                          action: Action.Pause({ minutes }),
                        }),
                      ),
                      h.Class(QUIET_BUTTON),
                    ],
                    [label],
                  ),
                ),
              )
            : h.empty,
        ],
      )
    },
  })
}

// FIELDS

const fieldShell = (
  label: string,
  maybeHint: Option.Option<string>,
  control: Html,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-1')],
    [
      h.label(
        [h.Class('flex flex-col gap-1')],
        [h.span([h.Class(FIELD_LABEL)], [label]), control],
      ),
      Option.match(maybeHint, {
        onNone: () => h.empty,
        onSome: hint => h.p([h.Class(CAPTION)], [hint]),
      }),
    ],
  )

const numberField = (
  label: string,
  hint: string,
  value: number,
  toDraft: (value: number) => PrMergeConfig,
  h: HtmlBuilder<Message>,
): Html =>
  fieldShell(
    label,
    Option.some(hint),
    h.input([
      h.Type('number'),
      h.Value(String(value)),
      h.OnInput(raw => updated(toDraft(Number(raw)))),
      h.Class(INPUT),
    ]),
    h,
  )

const entryListField = (
  label: string,
  hint: string,
  list: EntryList,
  placeholder: string,
  values: ReadonlyArray<string>,
  entry: string,
  toDraft: (values: ReadonlyArray<string>) => PrMergeConfig,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-1.5')],
    [
      h.span([h.Class(FIELD_LABEL)], [label]),
      Array.isReadonlyArrayEmpty(values)
        ? h.empty
        : h.ul(
            [h.Class('flex flex-wrap gap-1.5')],
            Array.map(values, value =>
              h.keyed('li')(
                value,
                [
                  h.Class(
                    'flex items-center gap-1 rounded-full bg-muted py-1 pl-3 pr-1 text-xs',
                  ),
                ],
                [
                  h.span([h.Class('min-w-0 break-all')], [value]),
                  h.button(
                    [
                      h.Type('button'),
                      h.AriaLabel(`Remove ${value}`),
                      h.OnClick(
                        updated(
                          toDraft(
                            Array.filter(
                              values,
                              candidate => candidate !== value,
                            ),
                          ),
                        ),
                      ),
                      h.Class(
                        'rounded-full p-1 text-muted-foreground hover:text-foreground',
                      ),
                    ],
                    [icon(h, X, 'size-3 shrink-0')],
                  ),
                ],
              ),
            ),
          ),
      h.div(
        [h.Class('flex gap-2')],
        [
          h.input([
            h.Type('text'),
            h.AriaLabel(`Add to ${label}`),
            h.Placeholder(placeholder),
            h.Value(entry),
            h.OnInput(value => Message.UpdatedEntry({ list, value })),
            h.OnKeyDownPreventDefault(key =>
              key === 'Enter'
                ? Option.some(Message.ClickedAddEntry({ list }))
                : Option.none(),
            ),
            h.Class(INPUT),
          ]),
          h.button(
            [
              h.Type('button'),
              h.AriaLabel(`Add ${label}`),
              h.OnClick(Message.ClickedAddEntry({ list })),
              h.Class(QUIET_BUTTON),
            ],
            ['Add'],
          ),
        ],
      ),
      h.p([h.Class(CAPTION)], [hint]),
    ],
  )

const switchField = (
  label: string,
  hint: string,
  isOn: boolean,
  toDraft: (isOn: boolean) => PrMergeConfig,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [h.Class('flex items-center justify-between gap-3')],
    [
      h.div(
        [h.Class('min-w-0')],
        [h.p([h.Class(FIELD_LABEL)], [label]), h.p([h.Class(CAPTION)], [hint])],
      ),
      h.button(
        [
          h.Type('button'),
          h.Role('switch'),
          h.AriaChecked(isOn),
          h.AriaLabel(label),
          h.OnClick(updated(toDraft(!isOn))),
          h.Class(
            isOn
              ? 'w-14 shrink-0 rounded-lg bg-primary py-1.5 text-sm text-primary-foreground'
              : 'w-14 shrink-0 rounded-lg bg-muted py-1.5 text-sm text-muted-foreground',
          ),
        ],
        [isOn ? 'On' : 'Off'],
      ),
    ],
  )

// WHEN

const whenBody = (
  model: Model,
  draft: PrMergeConfig,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  entryListField(
    'GitHub accounts',
    'Each one needs a gh login on this machine.',
    'Accounts',
    'github-login',
    draft.accounts,
    model.accountEntry,
    accounts => ({ ...draft, accounts }),
    h,
  ),
  entryListField(
    'Ignored repositories',
    'Merges in these repositories never flash.',
    'IgnoredRepos',
    'owner/name',
    draft.ignoredRepos,
    model.ignoredRepoEntry,
    ignoredRepos => ({ ...draft, ignoredRepos }),
    h,
  ),
]

// ONLY DURING

const withWindow = (
  draft: PrMergeConfig,
  window: DayWindow,
  next: DayWindow,
): PrMergeConfig => ({
  ...draft,
  schedule: {
    ...draft.schedule,
    days: Array.map(draft.schedule.days, candidate =>
      candidate.day === window.day ? next : candidate,
    ),
  },
})

const dayChipView = (
  draft: PrMergeConfig,
  window: DayWindow,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('button')(
    window.day,
    [
      h.Type('button'),
      h.Role('switch'),
      h.AriaChecked(window.isEnabled),
      h.AriaLabel(`Flash on ${window.day}`),
      h.OnClick(
        updated(
          withWindow(draft, window, {
            ...window,
            isEnabled: !window.isEnabled,
          }),
        ),
      ),
      h.Class(
        cn(
          'size-9 shrink-0 rounded-full text-xs',
          window.isEnabled
            ? 'bg-primary font-semibold text-primary-foreground'
            : 'bg-muted text-muted-foreground',
        ),
      ),
    ],
    [window.day.slice(0, 1)],
  )

const sharedHoursView = (
  draft: PrMergeConfig,
  h: HtmlBuilder<Message>,
): Html => {
  const { start, end } = sharedHours(draft.schedule)
  const withHours = (nextStart: string, nextEnd: string): Message =>
    updated({
      ...draft,
      schedule: withSameHours(draft.schedule, nextStart, nextEnd),
    })
  return h.div(
    [h.Class('flex items-center gap-2')],
    [
      h.input([
        h.Type('time'),
        h.AriaLabel('Start time'),
        h.Value(start),
        h.OnInput(next => withHours(next, end)),
        h.Class(INPUT),
      ]),
      h.span([h.Class(CAPTION)], ['to']),
      h.input([
        h.Type('time'),
        h.AriaLabel('End time'),
        h.Value(end),
        h.OnInput(next => withHours(start, next)),
        h.Class(INPUT),
      ]),
    ],
  )
}

const dayRowView = (
  draft: PrMergeConfig,
  window: DayWindow,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('div')(
    window.day,
    [h.Class('flex items-center gap-2')],
    [
      h.button(
        [
          h.Type('button'),
          h.Role('switch'),
          h.AriaChecked(window.isEnabled),
          h.AriaLabel(`Flash on ${window.day}`),
          h.OnClick(
            updated(
              withWindow(draft, window, {
                ...window,
                isEnabled: !window.isEnabled,
              }),
            ),
          ),
          h.Class(
            window.isEnabled
              ? 'w-14 shrink-0 rounded-lg bg-primary py-1.5 text-xs text-primary-foreground'
              : 'w-14 shrink-0 rounded-lg bg-muted py-1.5 text-xs text-muted-foreground',
          ),
        ],
        [window.day.slice(0, 3)],
      ),
      h.input([
        h.Type('time'),
        h.AriaLabel(`${window.day} start`),
        h.Value(window.start),
        h.OnInput(start =>
          updated(withWindow(draft, window, { ...window, start })),
        ),
        h.Disabled(!window.isEnabled),
        h.Class(`${INPUT} disabled:opacity-40`),
      ]),
      h.span([h.Class(CAPTION)], ['to']),
      h.input([
        h.Type('time'),
        h.AriaLabel(`${window.day} end`),
        h.Value(window.end),
        h.OnInput(end =>
          updated(withWindow(draft, window, { ...window, end })),
        ),
        h.Disabled(!window.isEnabled),
        h.Class(`${INPUT} disabled:opacity-40`),
      ]),
    ],
  )

const OUTSIDE_LABELS: ReadonlyArray<
  Readonly<{ value: OutsideWindow; label: string }>
> = [
  { value: 'Skip', label: "Don't flash" },
  { value: 'WaitForWindow', label: 'Flash once when it opens' },
]

const onlyDuringBody = (
  model: Model,
  draft: PrMergeConfig,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const isPerDay =
    isRevealed(model, 'PerDayHours') || !hasSameHours(draft.schedule)
  return [
    ...(isPerDay
      ? [
          h.div(
            [h.Class('flex flex-col gap-2')],
            Array.map(draft.schedule.days, window =>
              dayRowView(draft, window, h),
            ),
          ),
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedUseSameHours()),
              h.Class(TEXT_BUTTON),
            ],
            ['Use the same hours every day'],
          ),
        ]
      : [
          h.div(
            [h.Class('flex flex-wrap justify-between gap-1')],
            Array.map(draft.schedule.days, window =>
              dayChipView(draft, window, h),
            ),
          ),
          sharedHoursView(draft, h),
          revealLinkView('Set different hours per day', 'PerDayHours', h),
        ]),
    fieldShell(
      'Merges outside these hours',
      Option.none(),
      h.select(
        [
          h.Value(draft.schedule.whenOutside),
          h.OnChange(raw =>
            updated({
              ...draft,
              schedule: {
                ...draft.schedule,
                whenOutside: raw === 'WaitForWindow' ? 'WaitForWindow' : 'Skip',
              },
            }),
          ),
          h.Class(INPUT),
        ],
        Array.map(OUTSIDE_LABELS, ({ value, label }) =>
          h.option(
            [h.Value(value), h.Selected(value === draft.schedule.whenOutside)],
            [label],
          ),
        ),
      ),
      h,
    ),
    isRevealed(model, 'TimeZone')
      ? fieldShell(
          'Time zone',
          Option.some('An IANA name, like America/Vancouver.'),
          h.input([
            h.Type('text'),
            h.Value(draft.schedule.timeZone),
            h.OnInput(timeZone =>
              updated({ ...draft, schedule: { ...draft.schedule, timeZone } }),
            ),
            h.Class(INPUT),
          ]),
          h,
        )
      : revealLinkView(
          `Times use ${draft.schedule.timeZone}. Change`,
          'TimeZone',
          h,
        ),
  ]
}

// DO

const doBody = (
  model: Model,
  draft: PrMergeConfig,
  groupNames: ReadonlyArray<string>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const withFlash = (flash: PrMergeConfig['flash']): PrMergeConfig => ({
    ...draft,
    flash,
  })
  const { flash } = draft
  const choices = Array.contains(groupNames, flash.group)
    ? groupNames
    : [flash.group, ...groupNames]
  const isSpeed = (speed: (typeof FLASH_SPEEDS)[number]): boolean =>
    speed.onMs === flash.onMs && speed.offMs === flash.offMs
  const isCustomSpeed = !Array.some(FLASH_SPEEDS, isSpeed)
  return [
    fieldShell(
      'Lights',
      Option.none(),
      h.select(
        [
          h.Value(flash.group),
          h.OnChange(group => updated(withFlash({ ...flash, group }))),
          h.Class(INPUT),
        ],
        Array.map(choices, name =>
          h.option([h.Value(name), h.Selected(name === flash.group)], [name]),
        ),
      ),
      h,
    ),
    fieldShell(
      'Color',
      Option.none(),
      h.input([
        h.Type('color'),
        h.Value(flash.hex.toLowerCase()),
        h.OnInput(hex => updated(withFlash({ ...flash, hex }))),
        h.Class(
          'h-11 w-full cursor-pointer rounded-lg border border-input bg-transparent p-1',
        ),
      ]),
      h,
    ),
    numberField(
      'Flashes',
      'How many on-off cycles to run.',
      flash.count,
      count => withFlash({ ...flash, count }),
      h,
    ),
    choiceChipsView(
      'Speed',
      Array.map(FLASH_SPEEDS, speed => ({ label: speed.label, value: speed })),
      isSpeed,
      speed =>
        updated(withFlash({ ...flash, onMs: speed.onMs, offMs: speed.offMs })),
      h,
    ),
    isCustomSpeed ? h.p([h.Class(CAPTION)], ['Using custom timing.']) : h.empty,
    ...(isRevealed(model, 'FlashDetails')
      ? [
          revealLinkView('Hide timing and restore options', 'FlashDetails', h),
          numberField(
            'Brightness',
            '1 to 254.',
            flash.brightness,
            brightness => withFlash({ ...flash, brightness }),
            h,
          ),
          numberField(
            'On time (ms)',
            `At least ${MIN_FLASH_STEP_MS}. Bulbs drop faster commands.`,
            flash.onMs,
            onMs => withFlash({ ...flash, onMs }),
            h,
          ),
          numberField(
            'Off time (ms)',
            `At least ${MIN_FLASH_STEP_MS}. Bulbs drop faster commands.`,
            flash.offMs,
            offMs => withFlash({ ...flash, offMs }),
            h,
          ),
          switchField(
            'Only lights already on',
            'Off means every light in the group flashes.',
            flash.onlyLightsAlreadyOn,
            onlyLightsAlreadyOn => withFlash({ ...flash, onlyLightsAlreadyOn }),
            h,
          ),
          switchField(
            'Restore lights afterward',
            'Put each light back the way it was.',
            flash.shouldRestore,
            shouldRestore => withFlash({ ...flash, shouldRestore }),
            h,
          ),
          switchField(
            'Resume Rainbow afterward',
            'If Rainbow was running, start it again after the flash.',
            flash.shouldResumeRainbow,
            shouldResumeRainbow => withFlash({ ...flash, shouldResumeRainbow }),
            h,
          ),
        ]
      : [
          revealLinkView(
            'Fine-tune brightness, timing, and restore options',
            'FlashDetails',
            h,
          ),
        ]),
  ]
}

// ACTIVITY

const activityDotClass = (kind: ActivityKind): string =>
  Match.value(kind).pipe(
    Match.when('Info', () => 'bg-muted-foreground'),
    Match.when('Merge', () => 'bg-purple-400'),
    Match.when('Flash', () => 'bg-primary'),
    Match.when('Skip', () => 'bg-muted-foreground/60'),
    Match.when('Problem', () => 'bg-red-500'),
    Match.exhaustive,
  )

const activityRowView = (
  snapshot: Snapshot,
  entry: ActivityEntry,
  index: number,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('li')(
    `${entry.at}-${index}`,
    [h.Class('flex items-start gap-3 px-4 py-2.5')],
    [
      h.span([
        h.Class(
          `mt-1.5 h-2 w-2 shrink-0 rounded-full ${activityDotClass(entry.kind)}`,
        ),
      ]),
      h.p([h.Class('min-w-0 flex-1 break-words text-sm')], [entry.text]),
      h.span(
        [h.Class(`${CAPTION} shrink-0 pt-0.5`)],
        [elapsed(snapshot.generatedAt, entry.at)],
      ),
    ],
  )

const activityView = (
  model: Model,
  snapshot: Snapshot,
  h: HtmlBuilder<Message>,
): Html => {
  const isShowingAll = isRevealed(model, 'AllActivity')
  return h.section(
    [h.Class('flex flex-col gap-2'), h.AriaLabel('Recent activity')],
    [
      h.h3([h.Class(cn(GROUP_LABEL, 'mt-2'))], ['Recent']),
      Array.match(snapshot.activity, {
        onEmpty: () => h.p([h.Class(CAPTION)], ['Nothing has happened yet.']),
        onNonEmpty: entries =>
          h.ul(
            [h.Class(LIST)],
            pipe(
              entries,
              Array.take(isShowingAll ? ACTIVITY_SHOWN : ACTIVITY_PREVIEW),
              Array.map((entry, index) =>
                activityRowView(snapshot, entry, index, h),
              ),
            ),
          ),
      }),
      snapshot.activity.length > ACTIVITY_PREVIEW
        ? revealLinkView(
            isShowingAll ? 'Show less' : 'See all activity',
            'AllActivity',
            h,
          )
        : h.empty,
    ],
  )
}

// CONNECTIONS

const levelDotClass = (level: CheckLevel): string =>
  Match.value(level).pipe(
    Match.when('Ok', () => 'bg-emerald-400'),
    Match.when('Warning', () => 'bg-amber-400'),
    Match.when('Failing', () => 'bg-red-500'),
    Match.when('Inactive', () => 'bg-muted-foreground/40'),
    Match.exhaustive,
  )

const levelWord = (level: CheckLevel): string =>
  Match.value(level).pipe(
    Match.when('Ok', () => 'OK'),
    Match.when('Warning', () => 'Warning'),
    Match.when('Failing', () => 'Failing'),
    Match.when('Inactive', () => 'Not checked'),
    Match.exhaustive,
  )

const checkRowView = (check: HealthCheck, h: HtmlBuilder<Message>): Html =>
  h.keyed('li')(
    check.id,
    [h.Class('flex items-start gap-3')],
    [
      h.span([
        h.Class(
          `mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${levelDotClass(check.level)}`,
        ),
        h.AriaLabel(levelWord(check.level)),
        h.Role('img'),
      ]),
      h.div(
        [h.Class('min-w-0')],
        [
          h.p([h.Class('text-sm font-medium')], [check.label]),
          h.p([h.Class(`${CAPTION} break-words`)], [check.detail]),
        ],
      ),
    ],
  )

const checkListView = (
  checks: ReadonlyArray<HealthCheck>,
  h: HtmlBuilder<Message>,
): Html =>
  h.ul(
    [h.Class('flex flex-col gap-3')],
    Array.map(checks, check => checkRowView(check, h)),
  )

const worstLevel = (checks: ReadonlyArray<HealthCheck>): CheckLevel =>
  Option.match(maybeAttention(checks), {
    onSome: check => check.level,
    onNone: () =>
      Array.isReadonlyArrayNonEmpty(checks) &&
      Array.every(checks, check => check.level === 'Inactive')
        ? 'Inactive'
        : 'Ok',
  })

const levelDotView = (
  checks: ReadonlyArray<HealthCheck>,
  h: HtmlBuilder<Message>,
): Html =>
  h.span([
    h.Class(
      `h-2.5 w-2.5 shrink-0 rounded-full ${levelDotClass(worstLevel(checks))}`,
    ),
  ])

const connectionSummary = (
  checks: ReadonlyArray<HealthCheck>,
  healthySummary: string,
): string =>
  Option.match(maybeAttention(checks), {
    onSome: check => check.detail,
    onNone: () =>
      pipe(
        Array.findFirst(checks, check => check.level === 'Inactive'),
        Option.match({
          onSome: check => check.detail,
          onNone: () => healthySummary,
        }),
      ),
  })

const factView = (
  label: string,
  value: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [],
    [h.dt([h.Class(CAPTION)], [label]), h.dd([h.Class('text-sm')], [value])],
  )

const whenOrNever = (
  snapshot: Snapshot,
  maybeAt: Option.Option<number>,
): string =>
  Option.match(maybeAt, {
    onNone: () => 'Not yet',
    onSome: at => elapsed(snapshot.generatedAt, at),
  })

const rateLabel = (maybeWindow: Option.Option<RateWindow>): string =>
  Option.match(maybeWindow, {
    onNone: () => 'Unknown',
    onSome: window => `${window.remaining} / ${window.limit}`,
  })

const gitHubSummary = (snapshot: Snapshot): string =>
  Option.match(snapshot.poll.maybeLastSucceededAt, {
    onNone: () => 'Waiting for the first poll',
    onSome: at => `Connected, last check ${elapsed(snapshot.generatedAt, at)}`,
  })

const connectionsScreen = (
  model: Model,
  snapshot: Snapshot,
  draft: PrMergeConfig,
  maybeOpenSection: Option.Option<ConnectionSection>,
  h: HtmlBuilder<Message>,
): Html => {
  const isResponding = Option.isNone(model.maybeUnreachableReason)
  const lightChecks = Array.filter(snapshot.checks, check =>
    Array.contains(LIGHT_CHECK_IDS, check.id),
  )
  const serviceChecks = Array.filter(
    snapshot.checks,
    check => check.id === 'config',
  )
  const gitHubChecks = Array.difference(snapshot.checks, [
    ...lightChecks,
    ...serviceChecks,
  ])
  const row = (
    section: ConnectionSection,
    eyebrow: string,
    summary: string,
    checks: ReadonlyArray<HealthCheck>,
    body: () => ReadonlyArray<Html>,
  ): Html => {
    const isOpen = Option.exists(maybeOpenSection, open => open === section)
    return accordionRowView(
      {
        panelId: `connection-${section}`,
        eyebrow,
        summary,
        maybeLeading: Option.some(levelDotView(checks, h)),
        isOpen,
        onToggle: Message.SelectedScreen({
          screen: Screen.Connections({
            maybeOpenSection: toggledSection(maybeOpenSection, section),
          }),
        }),
        body: isOpen ? body() : [],
      },
      h,
    )
  }
  return h.div(
    [h.Class(SCREEN)],
    [
      backButtonView(h),
      h.div(
        [h.Class('flex items-center justify-between gap-3')],
        [
          h.h2([h.Class(SCREEN_TITLE)], ['Connections']),
          h.span(
            [
              h.Role('status'),
              h.AriaLabel('Automation health'),
              h.Class(
                `rounded-full px-3 py-1 text-xs font-semibold ${
                  isResponding
                    ? overallClass(snapshot.overall)
                    : overallClass('Unhealthy')
                }`,
              ),
            ],
            [isResponding ? overallLabel(snapshot.overall) : 'Not responding'],
          ),
        ],
      ),
      h.div(
        [h.Class(cn(LIST, 'mt-1'))],
        [
          row(
            'GitHub',
            'GitHub',
            connectionSummary(gitHubChecks, gitHubSummary(snapshot)),
            gitHubChecks,
            () => gitHubBody(model, snapshot, draft, gitHubChecks, h),
          ),
          row(
            'Lights',
            'Lights',
            connectionSummary(lightChecks, 'Broker and bridge online'),
            lightChecks,
            () => [checkListView(lightChecks, h)],
          ),
          row(
            'Service',
            'Service',
            connectionSummary(
              serviceChecks,
              `Started ${elapsed(snapshot.generatedAt, snapshot.startedAt)}`,
            ),
            serviceChecks,
            () => [
              Array.isReadonlyArrayEmpty(serviceChecks)
                ? h.empty
                : checkListView(serviceChecks, h),
              h.p(
                [h.Class(CAPTION)],
                [
                  `Started ${elapsed(snapshot.generatedAt, snapshot.startedAt)}. Restarting briefly stops every automation.`,
                ],
              ),
              h.div(
                [h.Class('flex')],
                [
                  actionButton(
                    model,
                    'Restart service',
                    'Restarting…',
                    Action.Restart(),
                    h,
                  ),
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  )
}

const gitHubBody = (
  model: Model,
  snapshot: Snapshot,
  draft: PrMergeConfig,
  checks: ReadonlyArray<HealthCheck>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => {
  const withPolling = (polling: PrMergeConfig['polling']): PrMergeConfig => ({
    ...draft,
    polling,
  })
  const { polling } = draft
  return [
    checkListView(checks, h),
    h.div(
      [h.Class('flex flex-col gap-1')],
      [
        h.p(
          [h.Class(CAPTION)],
          ['GitHub requests left this hour (REST, GraphQL)'],
        ),
        ...Array.map(snapshot.accounts, account =>
          h.keyed('p')(
            account.login,
            [h.Class('text-sm')],
            [
              `${account.login}: ${rateLabel(account.maybeCore)}, ${rateLabel(account.maybeGraphql)}`,
            ],
          ),
        ),
      ],
    ),
    choiceChipsView(
      'Check every',
      Array.map(POLL_CHOICES, ({ label, seconds }) => ({
        label,
        value: seconds,
      })),
      seconds => seconds === polling.intervalSeconds,
      seconds => updated(withPolling({ ...polling, intervalSeconds: seconds })),
      h,
    ),
    h.div(
      [h.Class('flex')],
      [actionButton(model, 'Check now', 'Checking…', Action.CheckNow(), h)],
    ),
    isRunning(model, 'CheckNow')
      ? h.p([h.Class(CAPTION)], ['Checking GitHub logins and polling now…'])
      : h.empty,
    ...(isRevealed(model, 'GitHubDetails')
      ? [
          revealLinkView(
            'Hide advanced polling and health limits',
            'GitHubDetails',
            h,
          ),
          gitHubDetailsView(snapshot, draft, h),
        ]
      : [
          revealLinkView(
            'Advanced polling and health limits',
            'GitHubDetails',
            h,
          ),
        ]),
  ]
}

const gitHubDetailsView = (
  snapshot: Snapshot,
  draft: PrMergeConfig,
  h: HtmlBuilder<Message>,
): Html => {
  const withPolling = (polling: PrMergeConfig['polling']): PrMergeConfig => ({
    ...draft,
    polling,
  })
  const withHealth = (health: PrMergeConfig['health']): PrMergeConfig => ({
    ...draft,
    health,
  })
  const { polling, health } = draft
  return h.div(
    [h.Class('flex flex-col gap-3')],
    [
      h.dl(
        [h.Class('grid grid-cols-2 gap-3')],
        [
          factView(
            'Last good poll',
            whenOrNever(snapshot, snapshot.poll.maybeLastSucceededAt),
            h,
          ),
          factView(
            'Poll took',
            Option.match(snapshot.poll.maybeLastDurationMs, {
              onNone: () => 'Unknown',
              onSome: ms => `${ms} ms`,
            }),
            h,
          ),
          factView(
            'Last merge',
            whenOrNever(snapshot, snapshot.maybeLastMergeAt),
            h,
          ),
          factView(
            'Last flash',
            whenOrNever(snapshot, snapshot.maybeLastFlashAt),
            h,
          ),
          factView(
            'Failed polls in a row',
            String(snapshot.poll.consecutiveFailures),
            h,
          ),
        ],
      ),
      h.p(
        [h.Class(`${CAPTION} break-words`)],
        [
          `Watching: ${
            Array.isReadonlyArrayEmpty(snapshot.poll.scopes)
              ? 'waiting for the first poll'
              : snapshot.poll.scopes.join(', ')
          }`,
        ],
      ),
      numberField(
        'Poll every (seconds)',
        'At least 5. Lower is faster but uses more GitHub requests.',
        polling.intervalSeconds,
        intervalSeconds => withPolling({ ...polling, intervalSeconds }),
        h,
      ),
      numberField(
        'Catch-up window (minutes)',
        'A merge older than this is recorded but never flashes.',
        polling.catchUpMinutes,
        catchUpMinutes => withPolling({ ...polling, catchUpMinutes }),
        h,
      ),
      numberField(
        'Search lookback (hours)',
        'How far back the GitHub search looks each poll.',
        polling.lookbackHours,
        lookbackHours => withPolling({ ...polling, lookbackHours }),
        h,
      ),
      numberField(
        'Organization refresh (minutes)',
        'How often to re-check which organizations each account belongs to.',
        polling.scopeRefreshMinutes,
        scopeRefreshMinutes => withPolling({ ...polling, scopeRefreshMinutes }),
        h,
      ),
      numberField(
        'Request timeout (seconds)',
        'Give up on a GitHub request after this long.',
        polling.requestTimeoutSeconds,
        requestTimeoutSeconds =>
          withPolling({ ...polling, requestTimeoutSeconds }),
        h,
      ),
      numberField(
        'Failed polls before unhealthy',
        'How many polls in a row can fail first.',
        health.failuresBeforeUnhealthy,
        failuresBeforeUnhealthy =>
          withHealth({ ...health, failuresBeforeUnhealthy }),
        h,
      ),
      numberField(
        'Unhealthy after no success (seconds)',
        'Flag it if this long passes without a good poll.',
        health.staleAfterSeconds,
        staleAfterSeconds => withHealth({ ...health, staleAfterSeconds }),
        h,
      ),
      numberField(
        'Low request warning',
        'Warn when an account has fewer GitHub requests left than this.',
        health.lowRateLimit,
        lowRateLimit => withHealth({ ...health, lowRateLimit }),
        h,
      ),
      numberField(
        'Check logins every (minutes)',
        'How often to confirm each GitHub login still works.',
        health.probeMinutes,
        probeMinutes => withHealth({ ...health, probeMinutes }),
        h,
      ),
    ],
  )
}

// SAVE BAR

const saveBarView = (
  model: Model,
  draft: PrMergeConfig,
  h: HtmlBuilder<Message>,
): Html => {
  if (Option.isNone(model.maybeDraft)) {
    return h.empty
  }
  const maybeProblem = draftProblem(draft)
  const isSaving = model.saveState._tag === 'Saving'
  return h.div(
    [
      h.Class(
        'sticky bottom-3 flex flex-col gap-2 rounded-xl bg-popover p-3 ring-1 ring-foreground/10',
      ),
    ],
    [
      Option.match(maybeProblem, {
        onNone: () => h.empty,
        onSome: problem =>
          h.p([h.Class('text-sm text-amber-300'), h.Role('alert')], [problem]),
      }),
      SaveState.match(model.saveState, {
        Idle: () => h.empty,
        Saving: () => h.empty,
        Failed: ({ reason }) =>
          h.p(
            [h.Class('text-sm text-destructive'), h.Role('alert')],
            [`Couldn't save: ${reason}.`],
          ),
      }),
      h.div(
        [h.Class('flex gap-2')],
        [
          h.button(
            [
              h.Type('submit'),
              h.Disabled(Option.isSome(maybeProblem) || isSaving),
              h.Class(PRIMARY_BUTTON),
            ],
            [isSaving ? 'Saving…' : 'Save settings'],
          ),
          h.button(
            [
              h.Type('button'),
              h.OnClick(Message.ClickedDiscardDraft()),
              h.Class(QUIET_BUTTON),
            ],
            ['Discard'],
          ),
        ],
      ),
    ],
  )
}
