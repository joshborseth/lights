import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  BridgeRequest,
  type Group,
  IncomingFrame,
  type Light,
  Pairing,
  addToGroupChange,
  bridgeRequestFrame,
  currentPlace,
  decodeFrame,
  entityNameProblem,
  groupPlaces,
  membershipRequests,
  moveLightChange,
  removeFromGroupChange,
  wholeHouseGroupNames,
} from './domain'

const light = (name: string, address: string): Light => ({
  name,
  address,
  maybeColorTempRange: Option.none(),
  supportsColor: true,
})

const lights: ReadonlyArray<Light> = [
  light('Living Orb', 'a'),
  light('Living Shroom', 'b'),
  light('Bedroom UFO', 'c'),
  light('Bedroom Sphere', 'd'),
  light('Bathroom Orb', 'e'),
  light('Kitchen One', 'f'),
  light('Kitchen Two', 'g'),
]

// NOTE: The live group layout, with the empty Kitchen group it really has.
const groups: ReadonlyArray<Group> = [
  { name: 'All Lights', memberAddresses: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] },
  { name: 'Bedroom', memberAddresses: ['c', 'd'] },
  { name: 'Rest of the House', memberAddresses: ['a', 'b', 'e', 'f', 'g'] },
  { name: 'Living Room', memberAddresses: ['a', 'b'] },
  { name: 'Kitchen', memberAddresses: [] },
]

const newLight = light('0x99', '0x99')
const withNewLight = [...lights, newLight]

describe('group places', () => {
  test('lists the tree in depth order, then empty groups at the top level', () => {
    expect(groupPlaces(lights, groups)).toEqual([
      { name: 'All Lights', depth: 0 },
      { name: 'Rest of the House', depth: 1 },
      { name: 'Living Room', depth: 2 },
      { name: 'Bedroom', depth: 1 },
      { name: 'Kitchen', depth: 0 },
    ])
  })

  test('the current place is the smallest group holding the light', () => {
    expect(currentPlace(lights, groups, 'c')).toEqual(Option.some('Bedroom'))
    expect(currentPlace(lights, groups, 'e')).toEqual(
      Option.some('Rest of the House'),
    )
  })
})

describe('moving a light', () => {
  test('leaves the old branch and joins the new one', () => {
    expect(moveLightChange(lights, groups, 'a', 'Bedroom')).toEqual({
      add: ['Bedroom'],
      remove: ['Rest of the House', 'Living Room'],
    })
  })

  test('joins every group around the destination', () => {
    expect(moveLightChange(lights, groups, 'c', 'Living Room')).toEqual({
      add: ['Living Room', 'Rest of the House'],
      remove: ['Bedroom'],
    })
  })

  test('moving to a broader group only drops the room it was in', () => {
    expect(moveLightChange(lights, groups, 'a', 'Rest of the House')).toEqual({
      add: [],
      remove: ['Living Room'],
    })
  })

  test('moving into an empty group keeps the light in its broader groups', () => {
    expect(moveLightChange(lights, groups, 'f', 'Kitchen')).toEqual({
      add: ['Kitchen'],
      remove: [],
    })
  })

  test('moving into an empty group leaves the old leaf room', () => {
    expect(moveLightChange(lights, groups, 'a', 'Kitchen')).toEqual({
      add: ['Kitchen'],
      remove: ['Living Room'],
    })
  })

  test('a light already in place needs no changes', () => {
    expect(moveLightChange(lights, groups, 'c', 'Bedroom')).toEqual({
      add: [],
      remove: [],
    })
  })

  test('a brand-new light joins the room and the whole-house group', () => {
    expect(moveLightChange(withNewLight, groups, '0x99', 'Bedroom')).toEqual({
      add: ['Bedroom', 'All Lights'],
      remove: [],
    })
  })
})

describe('whole-house groups', () => {
  test('ignores bulbs that are still unnamed', () => {
    const twoNew = [...withNewLight, light('0x98', '0x98')]
    expect(wholeHouseGroupNames(twoNew, groups, '0x99')).toEqual(['All Lights'])
  })

  test('is empty when no other named light exists', () => {
    expect(wholeHouseGroupNames([newLight], [], '0x99')).toEqual([])
  })

  test('ignores the closet, which stays out of every group', () => {
    const withCloset = [...withNewLight, light('Closet', 'h')]
    expect(wholeHouseGroupNames(withCloset, groups, '0x99')).toEqual([
      'All Lights',
    ])
  })
})

describe('editing a group', () => {
  test('adding a light also adds it to the groups around this one', () => {
    expect(addToGroupChange(lights, groups, 'c', 'Living Room')).toEqual({
      add: ['Living Room', 'Rest of the House'],
      remove: [],
    })
  })

  test('adding a light to an empty group touches only that group', () => {
    expect(addToGroupChange(lights, groups, 'c', 'Kitchen')).toEqual({
      add: ['Kitchen'],
      remove: [],
    })
  })

  test('removing a light also removes it from groups inside this one', () => {
    expect(
      removeFromGroupChange(lights, groups, 'a', 'Rest of the House'),
    ).toEqual({ add: [], remove: ['Rest of the House', 'Living Room'] })
  })

  test('adds run before removes', () => {
    expect(
      membershipRequests('a', { add: ['Bedroom'], remove: ['Living Room'] }),
    ).toEqual([
      BridgeRequest.AddToGroup({ address: 'a', group: 'Bedroom' }),
      BridgeRequest.RemoveFromGroup({ address: 'a', group: 'Living Room' }),
    ])
  })
})

describe('names', () => {
  test.each([
    ['', 'Give it a name.'],
    ['Up/Down', "Names can't contain /, # or +."],
    ['Hash#', "Names can't contain /, # or +."],
    ['bridge', 'That name is reserved. Pick another one.'],
    ['Preset', 'That name is reserved. Pick another one.'],
    ['Taken', 'Another light or group already has that name.'],
  ])('rejects %j', (name, problem) => {
    expect(entityNameProblem(name, ['Taken'])).toEqual(Option.some(problem))
  })

  test('accepts a free name and trims it', () => {
    expect(entityNameProblem('  Porch Lamp ', ['Taken'])).toEqual(Option.none())
  })
})

describe('bridge frames', () => {
  const frame = (topic: string, payload: unknown) =>
    JSON.stringify({ topic, payload })

  test.each([
    [
      BridgeRequest.OpenPairing({ seconds: 254 }),
      frame('bridge/request/permit_join', { time: 254, transaction: 't' }),
    ],
    [
      BridgeRequest.ClosePairing(),
      frame('bridge/request/permit_join', { time: 0, transaction: 't' }),
    ],
    [
      BridgeRequest.RenameLight({ address: '0x1', to: 'Lamp' }),
      frame('bridge/request/device/rename', {
        from: '0x1',
        to: 'Lamp',
        transaction: 't',
      }),
    ],
    [
      BridgeRequest.RemoveLight({ address: '0x1', isForced: true }),
      frame('bridge/request/device/remove', {
        id: '0x1',
        force: true,
        transaction: 't',
      }),
    ],
    [
      BridgeRequest.CreateGroup({ name: 'Office' }),
      frame('bridge/request/group/add', {
        friendly_name: 'Office',
        transaction: 't',
      }),
    ],
    [
      BridgeRequest.RenameGroup({ from: 'A', to: 'B' }),
      frame('bridge/request/group/rename', {
        from: 'A',
        to: 'B',
        transaction: 't',
      }),
    ],
    [
      BridgeRequest.RemoveGroup({ name: 'A', isForced: false }),
      frame('bridge/request/group/remove', {
        id: 'A',
        force: false,
        transaction: 't',
      }),
    ],
    [
      BridgeRequest.AddToGroup({ address: '0x1', group: 'A' }),
      frame('bridge/request/group/members/add', {
        group: 'A',
        device: '0x1',
        transaction: 't',
      }),
    ],
    [
      BridgeRequest.RemoveFromGroup({ address: '0x1', group: 'A' }),
      frame('bridge/request/group/members/remove', {
        group: 'A',
        device: '0x1',
        transaction: 't',
      }),
    ],
  ])('encodes %#', (request, expected) => {
    expect(bridgeRequestFrame(request, 't')).toEqual(expected)
  })

  const device = (fields: object) => ({
    friendly_name: '0xnew',
    ieee_address: '0xnew',
    type: 'Router',
    ...fields,
  })
  const lightDefinition = {
    description: 'TRADFRI bulb',
    exposes: [{ type: 'light', features: [{ name: 'color_xy' }] }],
  }

  const decodedNewDevices = (devices: ReadonlyArray<object>) =>
    Option.map(decodeFrame(frame('bridge/devices', devices)), decoded =>
      decoded._tag === 'ReportedLights' ? decoded.newDevices : [],
    )

  test('a device still being interviewed is joining', () => {
    expect(
      decodedNewDevices([device({ interview_state: 'IN_PROGRESS' })]),
    ).toEqual(
      Option.some([
        { address: '0xnew', setup: 'Joining', maybeDescription: Option.none() },
      ]),
    )
  })

  test('an interviewed bulb is ready to name', () => {
    expect(
      decodedNewDevices([
        device({ interview_state: 'SUCCESSFUL', definition: lightDefinition }),
      ]),
    ).toEqual(
      Option.some([
        {
          address: '0xnew',
          setup: 'ReadyLight',
          maybeDescription: Option.some('TRADFRI bulb'),
        },
      ]),
    )
  })

  test('a failed interview and a non-light are reported as such', () => {
    expect(
      decodedNewDevices([
        device({ interview_state: 'FAILED' }),
        device({
          ieee_address: '0xr',
          friendly_name: '0xr',
          interview_state: 'SUCCESSFUL',
          definition: { description: 'Remote', exposes: [{ type: 'enum' }] },
        }),
      ]),
    ).toEqual(
      Option.some([
        { address: '0xnew', setup: 'Failed', maybeDescription: Option.none() },
        {
          address: '0xr',
          setup: 'NotALight',
          maybeDescription: Option.some('Remote'),
        },
      ]),
    )
  })

  test('named devices and the coordinator are not new', () => {
    expect(
      decodedNewDevices([
        device({ friendly_name: 'Lamp', definition: lightDefinition }),
        device({ type: 'Coordinator' }),
      ]),
    ).toEqual(Option.some([]))
  })

  test('reads the pairing window from bridge info', () => {
    expect(
      decodeFrame(
        frame('bridge/info', { permit_join: true, permit_join_end: 5000 }),
      ),
    ).toEqual(
      Option.some(
        IncomingFrame.ReportedPairing({
          pairing: Pairing.Open({ maybeEndsAt: Option.some(5000) }),
        }),
      ),
    )
    expect(decodeFrame(frame('bridge/info', { permit_join: false }))).toEqual(
      Option.some(IncomingFrame.ReportedPairing({ pairing: Pairing.Closed() })),
    )
  })

  test('reads our bridge responses and ignores untagged ones', () => {
    expect(
      decodeFrame(
        frame('bridge/response/device/rename', {
          status: 'error',
          error: 'nope',
          transaction: 't',
        }),
      ),
    ).toEqual(
      Option.some(
        IncomingFrame.ReportedBridgeResponse({
          transaction: 't',
          maybeError: Option.some('nope'),
        }),
      ),
    )
    expect(
      decodeFrame(frame('bridge/response/x', { status: 'ok', data: {} })),
    ).toEqual(Option.none())
  })
})
