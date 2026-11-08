import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  BridgeRequest,
  type Group,
  type Light,
  askStateFrame,
  bridgeRequestFrame,
} from './domain'
import {
  type Context,
  Message,
  type Model,
  OutMessage,
  Screen,
  WaitForResponse,
  init,
  lostConnection,
  receivedResponse,
  update,
} from './manage'

const light = (name: string, address: string): Light => ({
  name,
  address,
  maybeColorTempRange: Option.none(),
  supportsColor: true,
})

const groups: ReadonlyArray<Group> = [
  { name: 'All Lights', memberAddresses: ['a', 'b'] },
  { name: 'Bedroom', memberAddresses: ['b'] },
]

const context: Context = {
  lights: [light('Orb', 'a'), light('UFO', 'b'), light('0x9', '0x9')],
  groups,
  newDevices: [
    { address: '0x9', setup: 'ReadyLight', maybeDescription: Option.none() },
  ],
}

const base: Model = { ...init, clientTag: 'x' }

const updateIn = (current: Model, sent: Message) =>
  update(current, sent, context)

const transaction = (requestId: number) => `lights-x-${requestId}`

const expectFrames = (
  result: ReturnType<typeof update>,
  frames: ReadonlyArray<string>,
) => {
  expect(result.outMessage).toEqual(OutMessage.ProducedFrames({ frames }))
}

const onNewLight: Model = {
  ...base,
  screen: Screen.NewLight({ address: '0x9' }),
  nameDraft: ' Porch ',
}

describe('adding a new light', () => {
  test('names the bulb, places it, then asks for its state', () => {
    const start = update(onNewLight, Message.SubmittedNewLight(), context)
    expectFrames(start, [
      bridgeRequestFrame(
        BridgeRequest.RenameLight({ address: '0x9', to: 'Porch' }),
        transaction(0),
      ),
    ])
    const second = receivedResponse(start.model, {
      transaction: transaction(0),
      maybeError: Option.none(),
    })
    expectFrames(second, [
      bridgeRequestFrame(
        BridgeRequest.AddToGroup({ address: '0x9', group: 'All Lights' }),
        transaction(1),
      ),
    ])
    const finish = receivedResponse(second.model, {
      transaction: transaction(1),
      maybeError: Option.none(),
    })
    expectFrames(finish, [askStateFrame('Porch')])
    expect(finish.model.screen).toEqual(Screen.List())
    expect(finish.model.maybeOperation).toEqual(Option.none())
    expect(finish.model.maybeNotice).toEqual(Option.some('Porch is ready.'))
  })

  test('a chosen room is used instead of only the whole-house group', () => {
    const chosen = update(
      onNewLight,
      Message.SelectedPlace({ group: 'Bedroom' }),
      context,
    ).model
    const start = update(chosen, Message.SubmittedNewLight(), context)
    const second = receivedResponse(start.model, {
      transaction: transaction(0),
      maybeError: Option.none(),
    })
    expectFrames(second, [
      bridgeRequestFrame(
        BridgeRequest.AddToGroup({ address: '0x9', group: 'Bedroom' }),
        transaction(1),
      ),
    ])
  })

  test('refuses a taken name and sends nothing', () => {
    const result = update(
      { ...onNewLight, nameDraft: 'Orb' },
      Message.SubmittedNewLight(),
      context,
    )
    expect(result.outMessage).toBeUndefined()
    expect(result.model.maybeOperation).toEqual(Option.none())
  })
})

describe('operations', () => {
  const started = update(
    { ...base, screen: Screen.Light({ address: 'a' }) },
    Message.SelectedPlace({ group: 'Bedroom' }),
    context,
  )

  test('a move sends the first step and waits for an answer', () => {
    expectFrames(started, [
      bridgeRequestFrame(
        BridgeRequest.AddToGroup({ address: 'a', group: 'Bedroom' }),
        transaction(0),
      ),
    ])
  })

  test('a response from another client is ignored', () => {
    const result = receivedResponse(started.model, {
      transaction: 'lights-other-0',
      maybeError: Option.none(),
    })
    expect(result.model.maybeOperation).toEqual(started.model.maybeOperation)
  })

  test('an error stops the plan and reports the reason', () => {
    const result = receivedResponse(started.model, {
      transaction: transaction(0),
      maybeError: Option.some('Bulb is offline'),
    })
    expect(result.model.maybeOperation).toEqual(Option.none())
    expect(Option.map(result.model.maybeFailure, f => f.reason)).toEqual(
      Option.some('Bulb is offline'),
    )
  })

  test('losing the connection fails the running operation', () => {
    const result = lostConnection(started.model)
    expect(result.model.maybeOperation).toEqual(Option.none())
    expect(Option.isSome(result.model.maybeFailure)).toBe(true)
  })

  test('a second action is ignored while one is running', () => {
    const result = update(started.model, Message.ClickedStartPairing(), context)
    expect(result.outMessage).toBeUndefined()
  })

  test('a late deadline does not fail a newer step', () => {
    const next = receivedResponse(started.model, {
      transaction: transaction(0),
      maybeError: Option.none(),
    })
    const result = updateIn(
      next.model,
      Message.CompletedWaitForResponse({ requestId: 0 }),
    )
    expect(Option.isSome(result.model.maybeOperation)).toBe(
      Option.isSome(next.model.maybeOperation),
    )
  })

  test('the matching deadline fails the step', () => {
    const result = updateIn(
      started.model,
      Message.CompletedWaitForResponse({ requestId: 0 }),
    )
    expect(result.model.maybeOperation).toEqual(Option.none())
    expect(Option.isSome(result.model.maybeFailure)).toBe(true)
  })
})

describe('removing', () => {
  const confirming: Model = {
    ...base,
    screen: Screen.Light({ address: 'a' }),
    removal: 'Confirming',
  }

  test('a failed removal can be forced, and then returns to the list', () => {
    const start = update(confirming, Message.ClickedConfirmRemove(), context)
    const failed = receivedResponse(start.model, {
      transaction: transaction(0),
      maybeError: Option.some('no route'),
    })
    expect(
      Option.flatMap(failed.model.maybeFailure, f => f.maybeForceRemoval),
    ).toEqual(
      Option.some(BridgeRequest.RemoveLight({ address: 'a', isForced: true })),
    )
    const forced = update(failed.model, Message.ClickedForceRemove(), context)
    expectFrames(forced, [
      bridgeRequestFrame(
        BridgeRequest.RemoveLight({ address: 'a', isForced: true }),
        transaction(1),
      ),
    ])
    const done = receivedResponse(forced.model, {
      transaction: transaction(1),
      maybeError: Option.none(),
    })
    expect(done.model.screen).toEqual(Screen.List())
  })
})

describe('groups', () => {
  test('renaming tells the parent and follows the new name', () => {
    const start = update(
      {
        ...base,
        screen: Screen.Group({ name: 'Bedroom' }),
        nameDraft: 'Sleep',
      },
      Message.SubmittedName(),
      context,
    )
    const done = receivedResponse(start.model, {
      transaction: transaction(0),
      maybeError: Option.none(),
    })
    expect(done.model.screen).toEqual(Screen.Group({ name: 'Sleep' }))
    expect(done.outMessage).toEqual(
      OutMessage.RenamedGroup({ from: 'Bedroom', to: 'Sleep' }),
    )
  })

  test('creating a group adds the drafted members in order', () => {
    const start = update(
      {
        ...base,
        screen: Screen.NewGroup(),
        nameDraft: 'Office',
        memberDraft: ['a'],
      },
      Message.SubmittedName(),
      context,
    )
    const next = receivedResponse(start.model, {
      transaction: transaction(0),
      maybeError: Option.none(),
    })
    expectFrames(next, [
      bridgeRequestFrame(
        BridgeRequest.AddToGroup({ address: 'a', group: 'Office' }),
        transaction(1),
      ),
    ])
  })

  test('opening a group prefills its name', () => {
    const result = updateIn(
      base,
      Message.SelectedScreen({ screen: Screen.Group({ name: 'Bedroom' }) }),
    )
    expect(result.model.nameDraft).toBe('Bedroom')
  })

  test('toggling a member waits for the deadline command', () => {
    const start = update(
      { ...base, screen: Screen.Group({ name: 'Bedroom' }) },
      Message.ClickedMember({ address: 'a' }),
      context,
    )
    expect(start.commands?.map(command => command.name)).toEqual([
      WaitForResponse.name,
    ])
  })
})
