import { Array, Match, Option, pipe } from 'effect'
import { Submodel } from 'foldkit'
import { type Html, type HtmlBuilder } from 'foldkit/html'

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
} from './automation'
import {
  Action,
  Message,
  type Model,
  Remote,
  SaveState,
  draftProblem,
  updated,
} from './automations'

const CARD =
  'flex flex-col gap-4 rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10'
const CAPTION = 'text-xs text-muted-foreground'
const FIELD_LABEL = 'text-sm text-muted-foreground'
const INPUT =
  'w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm text-foreground'
const QUIET_BUTTON =
  'rounded-lg bg-secondary px-3 py-2 text-sm text-secondary-foreground hover:bg-secondary/80 disabled:opacity-40'
const PRIMARY_BUTTON =
  'rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-40'
const SECTION_TITLE = 'text-base font-semibold'

const PAUSE_CHOICES: ReadonlyArray<
  Readonly<{ label: string; minutes: number }>
> = [
  { label: '30 min', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '4 hours', minutes: 240 },
  { label: '1 day', minutes: 1440 },
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
    [h.Class(CARD), h.AriaLabel('PR merge lights')],
    [
      h.h2([h.Class(SECTION_TITLE)], ['PR merge lights']),
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
  return h.div(
    [h.Class('flex flex-col gap-4')],
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
      statusCardView(model, snapshot, h),
      healthCardView(model, snapshot, h),
      settingsView(model, snapshot, draft, groupNames, h),
      activityView(snapshot, h),
    ],
  )
}

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

const isRunning = (model: Model, tag: Action['_tag']): boolean =>
  Option.exists(model.maybeRunningAction, action => action._tag === tag)

const actionButton = (
  model: Model,
  label: string,
  runningLabel: string,
  action: Action,
  h: HtmlBuilder<Message>,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.Disabled(Option.isSome(model.maybeRunningAction)),
      h.OnClick(Message.ClickedAction({ action })),
      h.Class(QUIET_BUTTON),
    ],
    [isRunning(model, action._tag) ? runningLabel : label],
  )

const statusCardView = (
  model: Model,
  snapshot: Snapshot,
  h: HtmlBuilder<Message>,
): Html => {
  const isEnabled = snapshot.mode._tag !== 'Off'
  const isResponding = Option.isNone(model.maybeUnreachableReason)
  return h.section(
    [h.Class(CARD), h.AriaLabel('PR merge lights')],
    [
      h.div(
        [h.Class('flex items-start justify-between gap-3')],
        [
          h.div(
            [h.Class('flex min-w-0 flex-col gap-1')],
            [
              h.h2([h.Class(SECTION_TITLE)], ['PR merge lights']),
              h.p(
                [h.Class('text-sm text-muted-foreground')],
                [modeLabel(snapshot)],
              ),
            ],
          ),
          h.button(
            [
              h.Type('button'),
              h.Role('switch'),
              h.AriaChecked(isEnabled),
              h.AriaLabel('PR merge lights automation'),
              h.Disabled(Option.isSome(model.maybeRunningAction)),
              h.OnClick(
                Message.ClickedAction({
                  action: Action.SetEnabled({ isEnabled: !isEnabled }),
                }),
              ),
              h.Class(
                isEnabled
                  ? 'w-16 shrink-0 rounded-lg bg-primary py-2 text-sm font-semibold text-primary-foreground'
                  : 'w-16 shrink-0 rounded-lg bg-muted py-2 text-sm font-semibold text-muted-foreground',
              ),
            ],
            [isEnabled ? 'On' : 'Off'],
          ),
        ],
      ),
      h.div(
        [h.Class('flex flex-wrap items-center gap-2')],
        [
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
          snapshot.heldMerges > 0
            ? h.span(
                [h.Class(CAPTION)],
                [`${snapshot.heldMerges} merges waiting for the schedule`],
              )
            : h.empty,
        ],
      ),
      h.div(
        [h.Class('flex flex-wrap gap-2')],
        [
          actionButton(model, 'Test flash', 'Flashing…', Action.TestFlash(), h),
          actionButton(model, 'Check now', 'Checking…', Action.CheckNow(), h),
          actionButton(
            model,
            'Restart service',
            'Restarting…',
            Action.Restart(),
            h,
          ),
        ],
      ),
      pauseControlsView(model, snapshot, h),
    ],
  )
}

const pauseControlsView = (
  model: Model,
  snapshot: Snapshot,
  h: HtmlBuilder<Message>,
): Html =>
  WatcherMode.match(snapshot.mode, {
    Off: () => h.empty,
    Paused: () =>
      h.div(
        [h.Class('flex')],
        [actionButton(model, 'Resume now', 'Resuming…', Action.Resume(), h)],
      ),
    Watching: () =>
      h.div(
        [h.Class('flex flex-wrap items-center gap-2')],
        [
          h.span([h.Class(CAPTION)], ['Pause']),
          ...Array.map(PAUSE_CHOICES, ({ label, minutes }) =>
            h.keyed('button')(
              label,
              [
                h.Type('button'),
                h.AriaLabel(`Pause for ${label}`),
                h.Disabled(Option.isSome(model.maybeRunningAction)),
                h.OnClick(
                  Message.ClickedAction({ action: Action.Pause({ minutes }) }),
                ),
                h.Class(QUIET_BUTTON),
              ],
              [label],
            ),
          ),
        ],
      ),
  })

// HEALTH

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

const healthCardView = (
  model: Model,
  snapshot: Snapshot,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.Class(CARD), h.AriaLabel('Health')],
    [
      h.h3([h.Class(SECTION_TITLE)], ['Health']),
      h.ul(
        [h.Class('flex flex-col gap-3')],
        Array.map(snapshot.checks, check => checkRowView(check, h)),
      ),
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
          factView(
            'Service started',
            elapsed(snapshot.generatedAt, snapshot.startedAt),
            h,
          ),
        ],
      ),
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
      Option.isSome(model.maybeRunningAction) && isRunning(model, 'CheckNow')
        ? h.p([h.Class(CAPTION)], ['Checking GitHub logins and polling now…'])
        : h.empty,
    ],
  )

// SETTINGS

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

const listField = (
  label: string,
  hint: string,
  values: ReadonlyArray<string>,
  toDraft: (values: ReadonlyArray<string>) => PrMergeConfig,
  h: HtmlBuilder<Message>,
): Html =>
  fieldShell(
    label,
    Option.some(hint),
    h.input([
      h.Type('text'),
      h.Value(values.join(',')),
      h.OnInput(raw => updated(toDraft(raw.split(',')))),
      h.Class(INPUT),
    ]),
    h,
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

const sectionView = (
  title: string,
  children: ReadonlyArray<Html>,
  h: HtmlBuilder<Message>,
): Html =>
  h.fieldset(
    [h.Class('flex flex-col gap-3 border-t border-border pt-4')],
    [h.legend([h.Class(`${SECTION_TITLE} pr-2`)], [title]), ...children],
  )

const settingsView = (
  model: Model,
  snapshot: Snapshot,
  draft: PrMergeConfig,
  groupNames: ReadonlyArray<string>,
  h: HtmlBuilder<Message>,
): Html => {
  const maybeProblem = draftProblem(draft)
  const isDirty = Option.isSome(model.maybeDraft)
  const isSaving = model.saveState._tag === 'Saving'
  return h.form(
    [
      h.Class(CARD),
      h.AriaLabel('Settings'),
      h.OnSubmit(Message.SubmittedDraft()),
    ],
    [
      h.h3([h.Class(SECTION_TITLE)], ['Settings']),
      watchingSection(draft, h),
      scheduleSection(draft, h),
      pollingSection(draft, h),
      flashSection(draft, groupNames, h),
      healthSection(draft, h),
      isDirty
        ? h.div(
            [
              h.Class(
                'sticky bottom-3 flex flex-col gap-2 rounded-xl bg-popover p-3 ring-1 ring-foreground/10',
              ),
            ],
            [
              Option.match(maybeProblem, {
                onNone: () => h.empty,
                onSome: problem =>
                  h.p(
                    [h.Class('text-sm text-amber-300'), h.Role('alert')],
                    [problem],
                  ),
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
        : h.p(
            [h.Class(CAPTION)],
            [
              `Times use ${snapshot.config.schedule.timeZone}. Changes apply as soon as you save.`,
            ],
          ),
    ],
  )
}

const watchingSection = (draft: PrMergeConfig, h: HtmlBuilder<Message>): Html =>
  sectionView(
    'What to watch',
    [
      listField(
        'GitHub accounts',
        'Comma-separated. Each one needs a gh login on this machine.',
        draft.accounts,
        accounts => ({ ...draft, accounts }),
        h,
      ),
      listField(
        'Ignored repositories',
        'Comma-separated owner/name. Merges there never flash.',
        draft.ignoredRepos,
        ignoredRepos => ({ ...draft, ignoredRepos }),
        h,
      ),
    ],
    h,
  )

const dayWindowView = (
  draft: PrMergeConfig,
  window: DayWindow,
  h: HtmlBuilder<Message>,
): Html => {
  const withWindow = (next: DayWindow): PrMergeConfig => ({
    ...draft,
    schedule: {
      ...draft.schedule,
      days: Array.map(draft.schedule.days, candidate =>
        candidate.day === window.day ? next : candidate,
      ),
    },
  })
  return h.keyed('div')(
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
            updated(withWindow({ ...window, isEnabled: !window.isEnabled })),
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
        h.OnInput(start => updated(withWindow({ ...window, start }))),
        h.Disabled(!window.isEnabled),
        h.Class(`${INPUT} disabled:opacity-40`),
      ]),
      h.span([h.Class(CAPTION)], ['to']),
      h.input([
        h.Type('time'),
        h.AriaLabel(`${window.day} end`),
        h.Value(window.end),
        h.OnInput(end => updated(withWindow({ ...window, end }))),
        h.Disabled(!window.isEnabled),
        h.Class(`${INPUT} disabled:opacity-40`),
      ]),
    ],
  )
}

const OUTSIDE_LABELS: ReadonlyArray<
  Readonly<{ value: OutsideWindow; label: string }>
> = [
  { value: 'Skip', label: "Don't flash" },
  { value: 'WaitForWindow', label: 'Flash once when it opens' },
]

const scheduleSection = (draft: PrMergeConfig, h: HtmlBuilder<Message>): Html =>
  sectionView(
    'Schedule',
    [
      fieldShell(
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
      ),
      h.div(
        [h.Class('flex flex-col gap-2')],
        Array.map(draft.schedule.days, window =>
          dayWindowView(draft, window, h),
        ),
      ),
      fieldShell(
        'Merges outside the schedule',
        Option.none(),
        h.select(
          [
            h.Value(draft.schedule.whenOutside),
            h.OnChange(raw =>
              updated({
                ...draft,
                schedule: {
                  ...draft.schedule,
                  whenOutside:
                    raw === 'WaitForWindow' ? 'WaitForWindow' : 'Skip',
                },
              }),
            ),
            h.Class(INPUT),
          ],
          Array.map(OUTSIDE_LABELS, ({ value, label }) =>
            h.option(
              [
                h.Value(value),
                h.Selected(value === draft.schedule.whenOutside),
              ],
              [label],
            ),
          ),
        ),
        h,
      ),
    ],
    h,
  )

const pollingSection = (
  draft: PrMergeConfig,
  h: HtmlBuilder<Message>,
): Html => {
  const withPolling = (polling: PrMergeConfig['polling']): PrMergeConfig => ({
    ...draft,
    polling,
  })
  const { polling } = draft
  return sectionView(
    'Polling',
    [
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
    ],
    h,
  )
}

const flashSection = (
  draft: PrMergeConfig,
  groupNames: ReadonlyArray<string>,
  h: HtmlBuilder<Message>,
): Html => {
  const withFlash = (flash: PrMergeConfig['flash']): PrMergeConfig => ({
    ...draft,
    flash,
  })
  const { flash } = draft
  const choices = Array.contains(groupNames, flash.group)
    ? groupNames
    : [flash.group, ...groupNames]
  return sectionView(
    'Flash',
    [
      fieldShell(
        'Group',
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
        'Brightness',
        '1 to 254.',
        flash.brightness,
        brightness => withFlash({ ...flash, brightness }),
        h,
      ),
      numberField(
        'Flashes',
        'How many on-off cycles to run.',
        flash.count,
        count => withFlash({ ...flash, count }),
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
    ],
    h,
  )
}

const healthSection = (draft: PrMergeConfig, h: HtmlBuilder<Message>): Html => {
  const withHealth = (health: PrMergeConfig['health']): PrMergeConfig => ({
    ...draft,
    health,
  })
  const { health } = draft
  return sectionView(
    'Health check',
    [
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
    h,
  )
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

const ACTIVITY_SHOWN = 40

const activityRowView = (
  snapshot: Snapshot,
  entry: ActivityEntry,
  index: number,
  h: HtmlBuilder<Message>,
): Html =>
  h.keyed('li')(
    `${entry.at}-${index}`,
    [h.Class('flex items-start gap-3')],
    [
      h.span([
        h.Class(
          `mt-1.5 h-2 w-2 shrink-0 rounded-full ${activityDotClass(entry.kind)}`,
        ),
      ]),
      h.div(
        [h.Class('min-w-0')],
        [
          h.p([h.Class('break-words text-sm')], [entry.text]),
          h.p([h.Class(CAPTION)], [elapsed(snapshot.generatedAt, entry.at)]),
        ],
      ),
    ],
  )

const activityView = (snapshot: Snapshot, h: HtmlBuilder<Message>): Html =>
  h.section(
    [h.Class(CARD), h.AriaLabel('Activity')],
    [
      h.h3([h.Class(SECTION_TITLE)], ['Activity']),
      Array.match(snapshot.activity, {
        onEmpty: () => h.p([h.Class(CAPTION)], ['Nothing has happened yet.']),
        onNonEmpty: entries =>
          h.ul(
            [h.Class('flex flex-col gap-3')],
            pipe(
              entries,
              Array.take(ACTIVITY_SHOWN),
              Array.map((entry, index) =>
                activityRowView(snapshot, entry, index, h),
              ),
            ),
          ),
      }),
    ],
  )
