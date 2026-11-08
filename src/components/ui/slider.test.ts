import { Effect, Fiber, Stream } from 'effect'
import { describe, expect, test } from 'vitest'

import * as Slider from './slider'
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

const SLIDER_ID = 'test-slider'
const TOUCH = 7
const ORIGIN = 100

const idle = (): Slider.Model => Slider.init({ id: SLIDER_ID, min: 0, max: 200, step: 1 })

const press = (model: Slider.Model, along = 150, across = 400) =>
  Slider.update(
    model,
    Slider.Message.PressedTouch({ pointerId: TOUCH, along, across, originValue: ORIGIN }),
  )

const move = (model: Slider.Model, along: number, across = 400, pointerId = TOUCH) =>
  Slider.update(
    model,
    Slider.Message.MovedTouch({ pointerId, along, across, valuePerPixel: 1 }),
  )

const pressed = (): Slider.Model => press(idle()).model

const sliding = (): Slider.Model => move(pressed(), 170).model

describe('touch gesture', () => {
  test('a press changes nothing until the finger moves', () => {
    const result = press(idle())
    expect(result.outMessage).toBeUndefined()
    expect(result.model.touchGesture._tag).toBe('Deciding')
    expect(Slider.isInteracting(result.model)).toBe(true)
  })

  test('a small wiggle stays undecided and changes nothing', () => {
    const result = move(pressed(), 160, 405)
    expect(result.outMessage).toBeUndefined()
    expect(result.model.touchGesture._tag).toBe('Deciding')
  })

  test('a vertical swipe abandons the gesture and changes nothing', () => {
    const result = move(pressed(), 152, 440)
    expect(result.outMessage).toBeUndefined()
    expect(result.model.touchGesture._tag).toBe('Idle')
  })

  test('a diagonal swipe is not clearly sideways', () => {
    const result = move(pressed(), 164, 408)
    expect(result.outMessage).toBeUndefined()
    expect(result.model.touchGesture._tag).toBe('Idle')
  })

  test('a mostly sideways swipe that also drifts is not a drag', () => {
    const result = move(pressed(), 168, 410)
    expect(result.outMessage).toBeUndefined()
    expect(result.model.touchGesture._tag).toBe('Idle')
  })

  test('a sideways drag starts without moving the value', () => {
    const result = move(pressed(), 170, 402)
    expect(result.outMessage).toBeUndefined()
    expect(result.model.touchGesture._tag).toBe('Sliding')
  })

  test('sliding moves the value by the distance dragged', () => {
    expect(move(sliding(), 185).outMessage).toEqual(
      Slider.OutMessage.ChangedValue({ value: ORIGIN + 15 }),
    )
    expect(move(sliding(), 160).outMessage).toEqual(
      Slider.OutMessage.ChangedValue({ value: ORIGIN - 10 }),
    )
  })

  test('sliding clamps at both ends', () => {
    expect(move(sliding(), 5000).outMessage).toEqual(
      Slider.OutMessage.ChangedValue({ value: 200 }),
    )
    expect(move(sliding(), -5000).outMessage).toEqual(
      Slider.OutMessage.ChangedValue({ value: 0 }),
    )
  })

  test('a release ends the gesture without changing the value', () => {
    const result = Slider.update(sliding(), Slider.Message.ReleasedTouch({ pointerId: TOUCH }))
    expect(result.outMessage).toBeUndefined()
    expect(Slider.isInteracting(result.model)).toBe(false)
  })

  test('a second finger cannot move or release the gesture', () => {
    expect(move(sliding(), 190, 400, TOUCH + 1).outMessage).toBeUndefined()
    const released = Slider.update(
      sliding(),
      Slider.Message.ReleasedTouch({ pointerId: TOUCH + 1 }),
    )
    expect(released.model.touchGesture._tag).toBe('Sliding')
  })

  test('a mouse press still sets the value and starts a drag', () => {
    const result = Slider.update(
      idle(),
      Slider.Message.PressedPointer({ value: 40, originValue: ORIGIN }),
    )
    expect(result.outMessage).toEqual(Slider.OutMessage.ChangedValue({ value: 40 }))
    expect(result.model.dragState._tag).toBe('Dragging')
    expect(result.model.touchGesture._tag).toBe('Idle')
  })
})

describe('touch subscription', () => {
  const nextTick = () =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })

  const firstMessageAfter = async (dispatch: () => void): Promise<Slider.Message | undefined> => {
    const fiber = Effect.runFork(
      Slider.subscriptions.touchPointer
        .dependenciesToStream({ touchActivity: 'Active', id: SLIDER_ID, min: 0, max: 200 })
        .pipe(Stream.take(1), Stream.runHead),
    )
    await nextTick()
    dispatch()
    const maybeMessage = await Effect.runPromise(Fiber.join(fiber))
    return maybeMessage._tag === 'Some' ? maybeMessage.value : undefined
  }

  test.each(['pointerup', 'pointercancel'])('%s ends the touch', async (type) => {
    const message = await firstMessageAfter(() => {
      document.dispatchEvent(new PointerEvent(type, { pointerId: TOUCH, bubbles: true }))
    })
    expect(message).toEqual(Slider.Message.ReleasedTouch({ pointerId: TOUCH }))
  })

  test('reports movement along the track with its scale', async () => {
    const track = document.createElement('div')
    track.setAttribute('data-slider-track-id', SLIDER_ID)
    track.getBoundingClientRect = () =>
      DOMRect.fromRect({ x: 0, y: 0, width: 224, height: 8 })
    document.body.append(track)
    const message = await firstMessageAfter(() => {
      document.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: TOUCH, clientX: 30, clientY: 80 }),
      )
    })
    track.remove()
    expect(message).toEqual(
      Slider.Message.MovedTouch({ pointerId: TOUCH, along: 30, across: 80, valuePerPixel: 1 }),
    )
  })
})
