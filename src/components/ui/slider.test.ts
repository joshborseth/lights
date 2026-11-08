import { describe, expect, test } from 'vitest'

import { valueFromPointer } from './slider'

const TRACK_LEFT = 100
const TRACK_WIDTH = 324
const THUMB_RADIUS = 12

const horizontalTrack = (): Element => {
  const track = document.createElement('div')
  track.getBoundingClientRect = () =>
    DOMRect.fromRect({ x: TRACK_LEFT, y: 0, width: TRACK_WIDTH, height: 8 })
  return track
}

const valueAt = (clientX: number): number =>
  valueFromPointer(clientX, 0, horizontalTrack(), 0, 100)

describe('valueFromPointer', () => {
  test('reads the minimum with the knob centered at its leftmost position', () => {
    expect(valueAt(TRACK_LEFT + THUMB_RADIUS)).toBe(0)
  })

  test('reads the maximum with the knob centered at its rightmost position', () => {
    expect(valueAt(TRACK_LEFT + TRACK_WIDTH - THUMB_RADIUS)).toBe(100)
  })

  test('reads the middle at the center of the track', () => {
    expect(valueAt(TRACK_LEFT + TRACK_WIDTH / 2)).toBe(50)
  })

  test('clamps a pointer past either end of the track', () => {
    expect(valueAt(0)).toBe(0)
    expect(valueAt(TRACK_LEFT + TRACK_WIDTH + 50)).toBe(100)
  })
})
