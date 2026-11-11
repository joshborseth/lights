import { PerspectiveCamera, Vector3 } from 'three'
import { afterEach, describe, expect, test } from 'vitest'

import {
  type Orbit,
  type OrbitGestures,
  type OrbitLimits,
  clampTarget,
  createOrbitGestures,
  releaseVelocity,
  stretchPastLimits,
  unstretch,
} from './houseControls'

const WIDTH = 400
const HEIGHT = 800
const HOME_DISTANCE = 20
const FRAME_MS = 16

const LIMITS: OrbitLimits = {
  minDistance: HOME_DISTANCE * 0.5,
  maxDistance: HOME_DISTANCE * 1.25,
  minPolar: 0.1,
  maxPolar: 1.25,
  home: new Vector3(5, 0.5, 5),
  homeDistance: HOME_DISTANCE,
  reachX: 5,
  reachZ: 5,
}

describe('stretchPastLimits', () => {
  test('leaves a distance inside the limits alone', () => {
    expect(stretchPastLimits(1, 0, 2)).toBe(1)
  })

  test('gives way past a limit, less and less', () => {
    const slightly = stretchPastLimits(2.1, 0, 2)
    const far = stretchPastLimits(10, 0, 2)
    expect(slightly).toBeGreaterThan(2)
    expect(slightly).toBeLessThan(2.1)
    expect(far).toBeLessThan(2.2)
    expect(stretchPastLimits(-10, 0, 2)).toBeGreaterThan(-0.2)
  })

  test('is undone by unstretch', () => {
    const raw = [-0.5, 0.3, 2.4]
    raw.forEach(value => {
      expect(unstretch(stretchPastLimits(value, 0, 2), 0, 2)).toBeCloseTo(value)
    })
  })
})

describe('clampTarget', () => {
  const away = new Vector3(20, 0.5, -20)

  test('holds the pivot at home at the home distance', () => {
    const clamped = clampTarget(away, HOME_DISTANCE, LIMITS)
    expect(clamped.x).toBeCloseTo(5)
    expect(clamped.z).toBeCloseTo(5)
  })

  test('lets the pivot reach the edge when fully zoomed in', () => {
    const clamped = clampTarget(away, LIMITS.minDistance, LIMITS)
    expect(clamped.x).toBeCloseTo(10)
    expect(clamped.z).toBeCloseTo(0)
    expect(clamped.y).toBe(0.5)
  })
})

describe('releaseVelocity', () => {
  const sample = (time: number, azimuth: number) => ({
    time,
    azimuth,
    polar: 0,
    logDistance: 0,
  })

  test('measures a drag that is still moving at release', () => {
    const samples = [0, 20, 40, 60, 80, 100].map(time =>
      sample(time, time * 0.001),
    )
    expect(releaseVelocity(samples, 105).azimuth).toBeCloseTo(0.001)
  })

  test('leaves nothing to glide after the finger pauses', () => {
    const samples = [sample(0, 0), sample(50, 0.05)]
    expect(releaseVelocity(samples, 200).azimuth).toBe(0)
  })
})

type Harness = Readonly<{
  element: HTMLElement
  anchor: HTMLElement
  orbit: Orbit
  gestures: OrbitGestures
  taps: Array<Readonly<{ x: number; y: number }>>
  starts: { count: number }
  flight: { isFlying: boolean }
  clicks: { count: number }
}>

const harnesses: Array<Harness> = []

const makeHarness = (): Harness => {
  const element = document.createElement('div')
  const anchor = document.createElement('button')
  anchor.dataset['anchor'] = 'kitchen'
  element.append(anchor)
  document.body.append(element)
  Object.defineProperty(element, 'clientHeight', { value: HEIGHT })
  element.getBoundingClientRect = () => new DOMRect(0, 0, WIDTH, HEIGHT)
  const camera = new PerspectiveCamera(30, WIDTH / HEIGHT, 0.5, 200)
  const orbit: Orbit = {
    target: LIMITS.home.clone(),
    distance: HOME_DISTANCE,
    polar: 0.66,
    azimuth: 0.34,
  }
  const taps: Array<Readonly<{ x: number; y: number }>> = []
  const starts = { count: 0 }
  const flight = { isFlying: false }
  const clicks = { count: 0 }
  anchor.addEventListener('click', () => {
    clicks.count += 1
  })
  const gestures = createOrbitGestures({
    element,
    camera,
    orbit,
    isFlying: () => flight.isFlying,
    syncCamera: () => {
      camera.position
        .setFromSphericalCoords(orbit.distance, orbit.polar, orbit.azimuth)
        .add(orbit.target)
      camera.lookAt(orbit.target)
      camera.updateMatrixWorld()
    },
    onGestureStart: () => {
      starts.count += 1
      flight.isFlying = false
    },
    onChange: () => undefined,
    onTap: (x, y) => {
      taps.push({ x, y })
    },
  })
  gestures.setLimits(LIMITS)
  const harness = {
    element,
    anchor,
    orbit,
    gestures,
    taps,
    starts,
    clicks,
    flight,
  }
  harnesses.push(harness)
  return harness
}

afterEach(() => {
  harnesses.splice(0).forEach(({ element, gestures }) => {
    gestures.dispose()
    element.remove()
  })
})

const send = (
  target: EventTarget,
  type: string,
  init: Readonly<{ id: number; x: number; y: number; time: number }>,
): void => {
  const event = new PointerEvent(type, {
    pointerId: init.id,
    clientX: init.x,
    clientY: init.y,
    isPrimary: init.id === 1,
    pointerType: 'touch',
    button: 0,
    bubbles: true,
    composed: true,
    cancelable: true,
  })
  Object.defineProperty(event, 'timeStamp', { value: init.time })
  target.dispatchEvent(event)
}

const settle = (gestures: OrbitGestures, frames: number): void => {
  Array.from({ length: frames }).forEach(() => {
    gestures.step(FRAME_MS)
  })
}

describe('createOrbitGestures', () => {
  test('a one-finger drag turns the house', () => {
    const { element, orbit, starts } = makeHarness()
    send(element, 'pointerdown', { id: 1, x: 200, y: 400, time: 0 })
    expect(starts.count).toBe(1)
    send(window, 'pointermove', { id: 1, x: 300, y: 400, time: 16 })
    expect(orbit.azimuth).toBeCloseTo(0.34 - (Math.PI * 2 * 100) / HEIGHT)
    send(window, 'pointerup', { id: 1, x: 300, y: 400, time: 300 })
  })

  test('spreading two fingers zooms in toward them', () => {
    const { element, orbit } = makeHarness()
    send(element, 'pointerdown', { id: 1, x: 260, y: 200, time: 0 })
    send(element, 'pointerdown', { id: 2, x: 300, y: 240, time: 5 })
    send(window, 'pointermove', { id: 2, x: 340, y: 280, time: 20 })
    send(window, 'pointermove', { id: 1, x: 220, y: 160, time: 25 })
    expect(orbit.distance).toBeLessThan(HOME_DISTANCE)
    expect(orbit.target.distanceTo(LIMITS.home)).toBeGreaterThan(0.01)
    expect(orbit.target.y).toBeCloseTo(LIMITS.home.y)
  })

  test('a two-finger drag turns the house too', () => {
    const { element, orbit } = makeHarness()
    send(element, 'pointerdown', { id: 1, x: 150, y: 400, time: 0 })
    send(element, 'pointerdown', { id: 2, x: 250, y: 400, time: 5 })
    send(window, 'pointermove', { id: 1, x: 190, y: 400, time: 20 })
    send(window, 'pointermove', { id: 2, x: 290, y: 400, time: 21 })
    expect(orbit.azimuth).toBeCloseTo(0.34 - (Math.PI * 2 * 40) / HEIGHT)
    expect(orbit.distance).toBeCloseTo(HOME_DISTANCE)
  })

  test('pinching past the limit gives a little, then springs back', () => {
    const { element, orbit, gestures } = makeHarness()
    send(element, 'pointerdown', { id: 1, x: 190, y: 400, time: 0 })
    send(element, 'pointerdown', { id: 2, x: 210, y: 400, time: 5 })
    send(window, 'pointermove', { id: 1, x: 0, y: 400, time: 20 })
    send(window, 'pointermove', { id: 2, x: 400, y: 400, time: 21 })
    expect(orbit.distance).toBeLessThan(LIMITS.minDistance)
    expect(orbit.distance).toBeGreaterThan(LIMITS.minDistance * Math.exp(-0.2))
    send(window, 'pointerup', { id: 1, x: 0, y: 400, time: 400 })
    send(window, 'pointerup', { id: 2, x: 400, y: 400, time: 401 })
    settle(gestures, 60)
    expect(orbit.distance).toBeCloseTo(LIMITS.minDistance)
    expect(gestures.step(FRAME_MS)).toBe(false)
  })

  test('a tap picks, but a tap that stops a spin does not', () => {
    const { element, orbit, gestures, taps } = makeHarness()
    send(element, 'pointerdown', { id: 1, x: 120, y: 340, time: 0 })
    send(element, 'pointerup', { id: 1, x: 121, y: 341, time: 80 })
    expect(taps).toEqual([{ x: 121, y: 341 }])

    send(element, 'pointerdown', { id: 1, x: 100, y: 400, time: 1000 })
    ;[1, 2, 3, 4, 5, 6].forEach(frame => {
      send(window, 'pointermove', {
        id: 1,
        x: 100 + frame * 30,
        y: 400,
        time: 1000 + frame * 16,
      })
    })
    send(window, 'pointerup', { id: 1, x: 280, y: 400, time: 1100 })
    gestures.step(FRAME_MS)
    const spinning = orbit.azimuth
    gestures.step(FRAME_MS)
    expect(orbit.azimuth).not.toBe(spinning)

    send(element, 'pointerdown', { id: 1, x: 200, y: 400, time: 1150 })
    send(element, 'pointerup', { id: 1, x: 200, y: 400, time: 1200 })
    const caught = orbit.azimuth
    expect(gestures.step(FRAME_MS)).toBe(false)
    expect(orbit.azimuth).toBe(caught)
    expect(taps).toHaveLength(1)
  })

  test('a tap on a floating control during a spin only stops the spin', () => {
    const { element, anchor, orbit, gestures, clicks } = makeHarness()
    send(element, 'pointerdown', { id: 1, x: 100, y: 400, time: 0 })
    ;[1, 2, 3, 4, 5, 6].forEach(frame => {
      send(window, 'pointermove', {
        id: 1,
        x: 100 + frame * 30,
        y: 400,
        time: frame * 16,
      })
    })
    send(window, 'pointerup', { id: 1, x: 280, y: 400, time: 100 })
    gestures.step(FRAME_MS)
    send(anchor, 'pointerdown', { id: 1, x: 100, y: 100, time: 150 })
    send(anchor, 'pointerup', { id: 1, x: 100, y: 100, time: 200 })
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    Object.defineProperty(click, 'timeStamp', { value: 201 })
    anchor.dispatchEvent(click)
    const caught = orbit.azimuth
    expect(gestures.step(FRAME_MS)).toBe(false)
    expect(orbit.azimuth).toBe(caught)
    expect(clicks.count).toBe(0)
  })

  test('a tap during a flight lands it without picking', () => {
    const { element, anchor, taps, starts, flight, clicks } = makeHarness()
    flight.isFlying = true
    send(element, 'pointerdown', { id: 1, x: 120, y: 340, time: 0 })
    send(element, 'pointerup', { id: 1, x: 120, y: 340, time: 60 })
    expect(starts.count).toBeGreaterThan(0)
    expect(flight.isFlying).toBe(false)
    expect(taps).toHaveLength(0)

    flight.isFlying = true
    send(anchor, 'pointerdown', { id: 1, x: 100, y: 100, time: 1000 })
    expect(flight.isFlying).toBe(false)
    send(anchor, 'pointerup', { id: 1, x: 100, y: 100, time: 1050 })
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    Object.defineProperty(click, 'timeStamp', { value: 1051 })
    anchor.dispatchEvent(click)
    expect(clicks.count).toBe(0)
  })

  test('a touch on a control that the view removes does not hold the camera', () => {
    const { element, anchor, orbit, gestures } = makeHarness()
    send(element, 'pointerdown', { id: 1, x: 190, y: 400, time: 0 })
    send(element, 'pointerdown', { id: 2, x: 210, y: 400, time: 5 })
    send(window, 'pointermove', { id: 1, x: 0, y: 400, time: 20 })
    send(window, 'pointermove', { id: 2, x: 400, y: 400, time: 21 })
    send(window, 'pointerup', { id: 1, x: 0, y: 400, time: 400 })
    send(window, 'pointerup', { id: 2, x: 400, y: 400, time: 401 })
    send(anchor, 'pointerdown', { id: 1, x: 100, y: 100, time: 500 })
    anchor.remove()
    settle(gestures, 60)
    expect(orbit.distance).toBeCloseTo(LIMITS.minDistance)
  })

  test('a tap on a floating control leaves the camera to the control', () => {
    const { anchor, orbit, starts, taps, clicks } = makeHarness()
    send(anchor, 'pointerdown', { id: 1, x: 100, y: 100, time: 0 })
    send(anchor, 'pointermove', { id: 1, x: 104, y: 102, time: 30 })
    send(anchor, 'pointerup', { id: 1, x: 104, y: 102, time: 60 })
    anchor.click()
    expect(orbit.azimuth).toBe(0.34)
    expect(starts.count).toBe(0)
    expect(taps).toHaveLength(0)
    expect(clicks.count).toBe(1)
  })

  test('a drag that starts on a floating control turns the house', () => {
    const { anchor, orbit, starts, clicks } = makeHarness()
    send(anchor, 'pointerdown', { id: 1, x: 100, y: 100, time: 0 })
    send(anchor, 'pointermove', { id: 1, x: 130, y: 100, time: 30 })
    expect(starts.count).toBe(1)
    send(anchor, 'pointermove', { id: 1, x: 180, y: 100, time: 46 })
    expect(orbit.azimuth).toBeCloseTo(0.34 - (Math.PI * 2 * 50) / HEIGHT)
    send(anchor, 'pointerup', { id: 1, x: 180, y: 100, time: 60 })
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    Object.defineProperty(click, 'timeStamp', { value: 61 })
    anchor.dispatchEvent(click)
    expect(clicks.count).toBe(0)
  })

  test('a pinch with one finger on a floating control zooms', () => {
    const { element, anchor, orbit } = makeHarness()
    send(anchor, 'pointerdown', { id: 1, x: 180, y: 400, time: 0 })
    send(element, 'pointerdown', { id: 2, x: 220, y: 400, time: 5 })
    send(window, 'pointermove', { id: 2, x: 260, y: 400, time: 20 })
    expect(orbit.distance).toBeLessThan(HOME_DISTANCE)
  })

  test('the wheel zooms', () => {
    const { element, orbit } = makeHarness()
    element.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: -100,
        clientX: 200,
        clientY: 400,
        cancelable: true,
      }),
    )
    expect(orbit.distance).toBeLessThan(HOME_DISTANCE)
  })
})
