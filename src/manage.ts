import {
  Array,
  Clock,
  Duration,
  Effect,
  Option,
  Random,
  Schema,
  Stream,
  String,
  pipe,
} from 'effect'
import { Command, type Update } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import {
  BridgeRequest,
  type Group,
  type Light,
  type MembershipChange,
  type NewDevice,
  addToGroupChange,
  askStateFrame,
  bridgeRequestFrame,
  entityNameProblem,
  isUnnamed,
  membershipRequests,
  moveLightChange,
  removeFromGroupChange,
  wholeHouseGroupNames,
} from './domain'

const PAIRING_SECONDS = 254
const RESPONSE_TIMEOUT_MS = 30_000
const MAX_CLIENT_TAG = 2_147_483_647

// NOTE: Other things look these groups up by name: the preset extension falls
// back to All Lights, and its scene recall only knows these two.
export const GROUPS_USED_BY_NAME: ReadonlyArray<string> = [
  'All Lights',
  'Rest of the House',
]

// MODEL

export const Screen = defineTaggedUnion({
  List: {},
  NewLight: { address: Schema.String },
  Light: { address: Schema.String },
  Group: { name: Schema.String },
  NewGroup: {},
})
export type Screen = typeof Screen.Type

const Finish = Schema.Struct({
  screen: Screen,
  maybeNotice: Schema.Option(Schema.String),
  maybeAskStateOf: Schema.Option(Schema.String),
})
type Finish = typeof Finish.Type

export const Operation = Schema.Struct({
  requestId: Schema.Number,
  current: BridgeRequest,
  remaining: Schema.Array(BridgeRequest),
  finish: Finish,
})
export type Operation = typeof Operation.Type

export const Failure = Schema.Struct({
  reason: Schema.String,
  maybeForceRemoval: Schema.Option(BridgeRequest),
})
export type Failure = typeof Failure.Type

export const Removal = Schema.Literals(['Idle', 'Confirming'])
export type Removal = typeof Removal.Type

export const Model = Schema.Struct({
  screen: Screen,
  clientTag: Schema.String,
  nextRequestId: Schema.Number,
  maybeOperation: Schema.Option(Operation),
  maybeFailure: Schema.Option(Failure),
  maybeNotice: Schema.Option(Schema.String),
  nameDraft: Schema.String,
  maybeChosenPlace: Schema.Option(Schema.String),
  memberDraft: Schema.Array(Schema.String),
  removal: Removal,
  maybeNowMs: Schema.Option(Schema.Number),
})
export type Model = typeof Model.Type

export const init: Model = {
  screen: Screen.List(),
  clientTag: '',
  nextRequestId: 0,
  maybeOperation: Option.none(),
  maybeFailure: Option.none(),
  maybeNotice: Option.none(),
  nameDraft: '',
  maybeChosenPlace: Option.none(),
  memberDraft: [],
  removal: 'Idle',
  maybeNowMs: Option.none(),
}

// MESSAGE

export const Message = defineMessageUnion({
  SelectedScreen: { screen: Screen },
  ClickedStartPairing: {},
  ClickedStopPairing: {},
  UpdatedName: { value: Schema.String },
  SubmittedName: {},
  SelectedPlace: { group: Schema.String },
  SubmittedNewLight: {},
  ClickedAlsoIn: { group: Schema.String },
  ClickedMember: { address: Schema.String },
  ClickedDraftMember: { address: Schema.String },
  ClickedRemove: {},
  ClickedCancelRemove: {},
  ClickedConfirmRemove: {},
  ClickedForceRemove: {},
  ClickedDismissFailure: {},
  TickedPairingClock: { nowMs: Schema.Number },
  CompletedPickClientTag: { clientTag: Schema.String },
  CompletedWaitForResponse: { requestId: Schema.Number },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  ProducedFrames: { frames: Schema.Array(Schema.String) },
  RenamedGroup: { from: Schema.String, to: Schema.String },
})
export type OutMessage = typeof OutMessage.Type

// DERIVED

export type Context = Readonly<{
  lights: ReadonlyArray<Light>
  groups: ReadonlyArray<Group>
  newDevices: ReadonlyArray<NewDevice>
}>

export const isBusy = (model: Model): boolean =>
  Option.isSome(model.maybeOperation)

export const findLight = (
  lights: ReadonlyArray<Light>,
  address: string,
): Option.Option<Light> =>
  Array.findFirst(lights, light => light.address === address)

export const findGroup = (
  groups: ReadonlyArray<Group>,
  name: string,
): Option.Option<Group> => Array.findFirst(groups, group => group.name === name)

const takenNames = (
  context: Context,
  maybeOwnName: Option.Option<string>,
): ReadonlyArray<string> =>
  Array.filter(
    [
      ...Array.map(context.lights, light => light.name),
      ...Array.map(context.groups, group => group.name),
    ],
    name => !Option.contains(maybeOwnName, name),
  )

const ownNameOf = (screen: Screen, context: Context): Option.Option<string> =>
  Screen.match(screen, {
    List: () => Option.none(),
    NewLight: () => Option.none(),
    Light: ({ address }) =>
      Option.map(findLight(context.lights, address), light => light.name),
    Group: ({ name }) => Option.some(name),
    NewGroup: () => Option.none(),
  })

export const nameProblem = (
  model: Model,
  context: Context,
): Option.Option<string> =>
  entityNameProblem(
    model.nameDraft,
    takenNames(context, ownNameOf(model.screen, context)),
  )

export const nameIsChanged = (model: Model, context: Context): boolean =>
  !Option.contains(
    ownNameOf(model.screen, context),
    String.trim(model.nameDraft),
  )

export const shortLabelOf = (light: Light): string =>
  isUnnamed(light) ? 'New light' : light.name

// COMMAND

export const PickClientTag = Command.define('PickClientTag', {
  messages: [Message.CompletedPickClientTag],
  execute: Random.nextIntBetween(1, MAX_CLIENT_TAG).pipe(
    Effect.map(value =>
      Message.CompletedPickClientTag({ clientTag: value.toString(36) }),
    ),
  ),
})

export const WaitForResponse = Command.define('WaitForResponse', {
  args: { requestId: Schema.Number },
  messages: [Message.CompletedWaitForResponse],
  execute: ({ requestId }) =>
    Effect.sleep(Duration.millis(RESPONSE_TIMEOUT_MS)).pipe(
      Effect.as(Message.CompletedWaitForResponse({ requestId })),
    ),
})

// UPDATE

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage>

const transactionOf = (model: Model, requestId: number): string =>
  `lights-${model.clientTag}-${requestId}`

const stayOn = (screen: Screen): Finish => ({
  screen,
  maybeNotice: Option.none(),
  maybeAskStateOf: Option.none(),
})

const sendStep = (
  model: Model,
  current: BridgeRequest,
  remaining: ReadonlyArray<BridgeRequest>,
  finish: Finish,
): UpdateReturn => {
  const requestId = model.nextRequestId
  return {
    model: modifyFields(model, {
      nextRequestId: id => id + 1,
      maybeOperation: () =>
        Option.some({ requestId, current, remaining, finish }),
    }),
    commands: [WaitForResponse({ requestId })],
    outMessage: OutMessage.ProducedFrames({
      frames: [bridgeRequestFrame(current, transactionOf(model, requestId))],
    }),
  }
}

const startOperation = (
  model: Model,
  requests: ReadonlyArray<BridgeRequest>,
  finish: Finish,
): UpdateReturn => {
  if (isBusy(model)) {
    return { model }
  }
  const cleared = modifyFields(model, {
    maybeFailure: () => Option.none(),
    maybeNotice: () => Option.none(),
    removal: () => 'Idle',
  })
  return Array.match(requests, {
    onEmpty: () => ({ model: cleared }),
    onNonEmpty: ([current, ...remaining]) =>
      sendStep(cleared, current, remaining, finish),
  })
}

const forceRemovalOf = (request: BridgeRequest): Option.Option<BridgeRequest> =>
  BridgeRequest.match(request, {
    OpenPairing: () => Option.none(),
    ClosePairing: () => Option.none(),
    RenameLight: () => Option.none(),
    RemoveLight: ({ address, isForced }) =>
      isForced
        ? Option.none()
        : Option.some(BridgeRequest.RemoveLight({ address, isForced: true })),
    CreateGroup: () => Option.none(),
    RenameGroup: () => Option.none(),
    RemoveGroup: ({ name, isForced }) =>
      isForced
        ? Option.none()
        : Option.some(BridgeRequest.RemoveGroup({ name, isForced: true })),
    AddToGroup: () => Option.none(),
    RemoveFromGroup: () => Option.none(),
  })

const failOperation = (
  model: Model,
  operation: Operation,
  reason: string,
): UpdateReturn => ({
  model: modifyFields(model, {
    maybeOperation: () => Option.none(),
    maybeFailure: () =>
      Option.some({
        reason,
        maybeForceRemoval: forceRemovalOf(operation.current),
      }),
  }),
})

const finishOperation = (model: Model, operation: Operation): UpdateReturn => {
  const finished = modifyFields(model, {
    maybeOperation: () => Option.none(),
    maybeNotice: () => operation.finish.maybeNotice,
    screen: () => operation.finish.screen,
  })
  return BridgeRequest.match<UpdateReturn>(operation.current, {
    OpenPairing: () => ({ model: finished }),
    ClosePairing: () => ({ model: finished }),
    RenameLight: () => withAskState(finished, operation.finish),
    RemoveLight: () => ({ model: finished }),
    CreateGroup: () => ({ model: finished }),
    RenameGroup: ({ from, to }) => ({
      model: finished,
      outMessage: OutMessage.RenamedGroup({ from, to }),
    }),
    RemoveGroup: () => ({ model: finished }),
    AddToGroup: () => withAskState(finished, operation.finish),
    RemoveFromGroup: () => withAskState(finished, operation.finish),
  })
}

const withAskState = (model: Model, finish: Finish): UpdateReturn =>
  Option.match(finish.maybeAskStateOf, {
    onNone: () => ({ model }),
    onSome: name => ({
      model,
      outMessage: OutMessage.ProducedFrames({ frames: [askStateFrame(name)] }),
    }),
  })

const applyResponse = (
  model: Model,
  operation: Operation,
  maybeError: Option.Option<string>,
): UpdateReturn =>
  Option.match(maybeError, {
    onSome: error => failOperation(model, operation, error),
    onNone: () =>
      Array.match(operation.remaining, {
        onEmpty: () => finishOperation(model, operation),
        onNonEmpty: ([next, ...rest]) =>
          sendStep(model, next, rest, operation.finish),
      }),
  })

const prefilledName = (screen: Screen, context: Context): string =>
  Screen.match(screen, {
    List: () => '',
    NewLight: () => '',
    Light: ({ address }) =>
      Option.match(findLight(context.lights, address), {
        onNone: () => '',
        onSome: light => light.name,
      }),
    Group: ({ name }) => name,
    NewGroup: () => '',
  })

const openScreen = (model: Model, screen: Screen, context: Context): Model =>
  modifyFields(model, {
    screen: () => screen,
    nameDraft: () => prefilledName(screen, context),
    maybeChosenPlace: () => Option.none(),
    memberDraft: () => [],
    removal: () => 'Idle',
    maybeFailure: () => Option.none(),
    maybeNotice: () => Option.none(),
  })

const submitNameForLight = (
  model: Model,
  context: Context,
  address: string,
  name: string,
): UpdateReturn =>
  startOperation(model, [BridgeRequest.RenameLight({ address, to: name })], {
    screen: model.screen,
    maybeNotice: Option.some(`Renamed to ${name}.`),
    maybeAskStateOf: Option.none(),
  })

const submitNameForGroup = (
  model: Model,
  from: string,
  to: string,
): UpdateReturn =>
  startOperation(model, [BridgeRequest.RenameGroup({ from, to })], {
    screen: Screen.Group({ name: to }),
    maybeNotice: Option.some(`Renamed to ${to}.`),
    maybeAskStateOf: Option.none(),
  })

const submitNewGroup = (model: Model, name: string): UpdateReturn =>
  startOperation(
    model,
    [
      BridgeRequest.CreateGroup({ name }),
      ...Array.map(model.memberDraft, address =>
        BridgeRequest.AddToGroup({ address, group: name }),
      ),
    ],
    {
      screen: Screen.Group({ name }),
      maybeNotice: Option.some(`Created ${name}.`),
      maybeAskStateOf: Option.none(),
    },
  )

const submittedName = (model: Model, context: Context): UpdateReturn => {
  const name = String.trim(model.nameDraft)
  if (Option.isSome(nameProblem(model, context))) {
    return { model }
  }
  return Screen.match<UpdateReturn>(model.screen, {
    List: () => ({ model }),
    NewLight: () => ({ model }),
    Light: ({ address }) =>
      nameIsChanged(model, context)
        ? submitNameForLight(model, context, address, name)
        : { model },
    Group: ({ name: from }) =>
      nameIsChanged(model, context)
        ? submitNameForGroup(model, from, name)
        : { model },
    NewGroup: () => submitNewGroup(model, name),
  })
}

const applyMembershipChange = (
  model: Model,
  address: string,
  change: MembershipChange,
): UpdateReturn =>
  startOperation(
    model,
    membershipRequests(address, change),
    stayOn(model.screen),
  )

const selectedPlace = (
  model: Model,
  context: Context,
  group: string,
): UpdateReturn =>
  Screen.match<UpdateReturn>(model.screen, {
    List: () => ({ model }),
    NewLight: () => ({
      model: modifyFields(model, {
        maybeChosenPlace: () => Option.some(group),
      }),
    }),
    Light: ({ address }) =>
      applyMembershipChange(
        model,
        address,
        moveLightChange(context.lights, context.groups, address, group),
      ),
    Group: () => ({ model }),
    NewGroup: () => ({ model }),
  })

const newLightRequests = (
  model: Model,
  context: Context,
  address: string,
  name: string,
): ReadonlyArray<BridgeRequest> => [
  BridgeRequest.RenameLight({ address, to: name }),
  ...membershipRequests(
    address,
    Option.match(model.maybeChosenPlace, {
      onNone: () => ({
        add: wholeHouseGroupNames(context.lights, context.groups, address),
        remove: [],
      }),
      onSome: group =>
        moveLightChange(context.lights, context.groups, address, group),
    }),
  ),
]

const submittedNewLight = (model: Model, context: Context): UpdateReturn => {
  const name = String.trim(model.nameDraft)
  if (Option.isSome(nameProblem(model, context))) {
    return { model }
  }
  return Screen.match<UpdateReturn>(model.screen, {
    List: () => ({ model }),
    NewLight: ({ address }) =>
      startOperation(model, newLightRequests(model, context, address, name), {
        screen: Screen.List(),
        maybeNotice: Option.some(`${name} is ready.`),
        maybeAskStateOf: Option.some(name),
      }),
    Light: () => ({ model }),
    Group: () => ({ model }),
    NewGroup: () => ({ model }),
  })
}

const toggledMember = (
  model: Model,
  context: Context,
  address: string,
  group: Group,
): UpdateReturn =>
  applyMembershipChange(
    model,
    address,
    Array.contains(group.memberAddresses, address)
      ? removeFromGroupChange(
          context.lights,
          context.groups,
          address,
          group.name,
        )
      : addToGroupChange(context.lights, context.groups, address, group.name),
  )

const removalRequest = (screen: Screen): Option.Option<BridgeRequest> =>
  Screen.match(screen, {
    List: () => Option.none(),
    NewLight: ({ address }) =>
      Option.some(BridgeRequest.RemoveLight({ address, isForced: false })),
    Light: ({ address }) =>
      Option.some(BridgeRequest.RemoveLight({ address, isForced: false })),
    Group: ({ name }) =>
      Option.some(BridgeRequest.RemoveGroup({ name, isForced: false })),
    NewGroup: () => Option.none(),
  })

const removed = (model: Model, request: BridgeRequest): UpdateReturn =>
  startOperation(model, [request], {
    screen: Screen.List(),
    maybeNotice: Option.some('Removed.'),
    maybeAskStateOf: Option.none(),
  })

const isDeadline = (model: Model, requestId: number): boolean =>
  Option.exists(
    model.maybeOperation,
    operation => operation.requestId === requestId,
  )

export type BridgeResponse = Readonly<{
  transaction: string
  maybeError: Option.Option<string>
}>

export const receivedResponse = (
  model: Model,
  { transaction, maybeError }: BridgeResponse,
): UpdateReturn =>
  pipe(
    model.maybeOperation,
    Option.filter(
      operation => transactionOf(model, operation.requestId) === transaction,
    ),
    Option.match({
      onNone: () => ({ model }),
      onSome: operation => applyResponse(model, operation, maybeError),
    }),
  )

export const lostConnection = (model: Model): UpdateReturn =>
  Option.match(model.maybeOperation, {
    onNone: () => ({ model }),
    onSome: operation =>
      failOperation(
        model,
        operation,
        'Lost the connection before that finished. Check the result, then try again.',
      ),
  })

export const pairingClockTicks = (periodMs: number): Stream.Stream<Message> =>
  Stream.tick(Duration.millis(periodMs)).pipe(
    Stream.mapEffect(() => Clock.currentTimeMillis),
    Stream.map(nowMs => Message.TickedPairingClock({ nowMs })),
  )

export const update = (
  model: Model,
  message: Message,
  context: Context,
): UpdateReturn =>
  Message.match<UpdateReturn>(message, {
    SelectedScreen: ({ screen }) => ({
      model: openScreen(model, screen, context),
    }),

    ClickedStartPairing: () =>
      startOperation(
        model,
        [BridgeRequest.OpenPairing({ seconds: PAIRING_SECONDS })],
        stayOn(model.screen),
      ),

    ClickedStopPairing: () =>
      startOperation(
        model,
        [BridgeRequest.ClosePairing()],
        stayOn(model.screen),
      ),

    UpdatedName: ({ value }) => ({
      model: modifyFields(model, { nameDraft: () => value }),
    }),

    SubmittedName: () => submittedName(model, context),

    SelectedPlace: ({ group }) => selectedPlace(model, context, group),

    SubmittedNewLight: () => submittedNewLight(model, context),

    ClickedAlsoIn: ({ group }) =>
      Screen.match<UpdateReturn>(model.screen, {
        List: () => ({ model }),
        NewLight: () => ({ model }),
        Light: ({ address }) =>
          Option.match(findGroup(context.groups, group), {
            onNone: () => ({ model }),
            onSome: found => toggledMember(model, context, address, found),
          }),
        Group: () => ({ model }),
        NewGroup: () => ({ model }),
      }),

    ClickedMember: ({ address }) =>
      Screen.match<UpdateReturn>(model.screen, {
        List: () => ({ model }),
        NewLight: () => ({ model }),
        Light: () => ({ model }),
        Group: ({ name }) =>
          Option.match(findGroup(context.groups, name), {
            onNone: () => ({ model }),
            onSome: found => toggledMember(model, context, address, found),
          }),
        NewGroup: () => ({ model }),
      }),

    ClickedDraftMember: ({ address }) => ({
      model: modifyFields(model, {
        memberDraft: members =>
          Array.contains(members, address)
            ? Array.filter(members, member => member !== address)
            : Array.append(members, address),
      }),
    }),

    ClickedRemove: () => ({
      model: modifyFields(model, {
        removal: () => 'Confirming',
        maybeFailure: () => Option.none(),
      }),
    }),

    ClickedCancelRemove: () => ({
      model: modifyFields(model, { removal: () => 'Idle' }),
    }),

    ClickedConfirmRemove: () =>
      Option.match(removalRequest(model.screen), {
        onNone: () => ({ model }),
        onSome: request => removed(model, request),
      }),

    ClickedForceRemove: () =>
      pipe(
        model.maybeFailure,
        Option.flatMap(failure => failure.maybeForceRemoval),
        Option.match({
          onNone: () => ({ model }),
          onSome: request => removed(model, request),
        }),
      ),

    ClickedDismissFailure: () => ({
      model: modifyFields(model, { maybeFailure: () => Option.none() }),
    }),

    TickedPairingClock: ({ nowMs }) => ({
      model: modifyFields(model, { maybeNowMs: () => Option.some(nowMs) }),
    }),

    CompletedPickClientTag: ({ clientTag }) => ({
      model: modifyFields(model, { clientTag: () => clientTag }),
    }),

    CompletedWaitForResponse: ({ requestId }) =>
      isDeadline(model, requestId)
        ? Option.match(model.maybeOperation, {
            onNone: () => ({ model }),
            onSome: operation =>
              failOperation(
                model,
                operation,
                "Didn't hear back from Zigbee2MQTT. Check the bulb has power, then try again.",
              ),
          })
        : { model },
  })
