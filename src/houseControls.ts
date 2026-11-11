import { Array, Option } from 'effect'
import {
  type PerspectiveCamera,
  Plane,
  Raycaster,
  Vector2,
  Vector3,
} from 'three'

// NOTE: One drag across the full height of the view turns the house a full
// circle, the same rate OrbitControls used.
const ROTATE_PER_HEIGHT = Math.PI * 2
const TAP_SLOP_PX = 10
const TAP_MAX_MS = 450
const VELOCITY_WINDOW_MS = 80
const RELEASE_PAUSE_MS = 50
const SAMPLE_KEEP_MS = 200
const ROTATE_GLIDE_MS = 260
const ZOOM_GLIDE_MS = 180
const ZOOM_BOUNCE_MS = 45
const SPRING_MS = 90
const MAX_ROTATE_SPEED = 0.01
const MAX_ZOOM_SPEED = 0.004
const REST_ROTATE_SPEED = 0.00002
const REST_ZOOM_SPEED = 0.00002
const REST_STRETCH = 0.0005
const SETTLED_STRETCH = 1e-9
const CATCH_ROTATE_SPEED = 0.0003
const CATCH_ZOOM_SPEED = 0.0002
const STRETCH_LOG = 0.2
const STRETCH_CAP = 0.999
const WHEEL_ZOOM_PER_PX = 0.0006
const PINCH_WHEEL_ZOOM_PER_PX = 0.01
const WHEEL_LINE_PX = 16
const WHEEL_PAGE_PX = 400
const WHEEL_SETTLE_MS = 140
const CLICK_SWALLOW_MS = 600
const MAX_ZOOM_POINT_REACH = 4
const ANCHOR_SELECTOR = '[data-anchor]'
const UP = new Vector3(0, 1, 0)

export type Orbit = {
  readonly target: Vector3
  distance: number
  polar: number
  azimuth: number
}

// NOTE: The home view frames the focused area. Zooming in lets the camera's
// pivot drift toward the fingers, up to the area's edge when fully zoomed in,
// and pulls it back to the middle as the view zooms out to home.
export type OrbitLimits = Readonly<{
  minDistance: number
  maxDistance: number
  minPolar: number
  maxPolar: number
  home: Vector3
  homeDistance: number
  reachX: number
  reachZ: number
}>

export type OrbitSample = Readonly<{
  time: number
  azimuth: number
  polar: number
  logDistance: number
}>

export type OrbitVelocity = {
  azimuth: number
  polar: number
  logDistance: number
}

export type OrbitGestures = Readonly<{
  setLimits: (limits: OrbitLimits) => void
  step: (dt: number) => boolean
  stop: () => void
  dispose: () => void
}>

export type OrbitGestureOptions = Readonly<{
  element: HTMLElement
  camera: PerspectiveCamera
  orbit: Orbit
  syncCamera: () => void
  isFlying: () => boolean
  onGestureStart: () => void
  onChange: () => void
  onTap: (x: number, y: number) => void
}>

type TrackedPointer = {
  x: number
  y: number
  readonly startX: number
  readonly startY: number
  readonly maybeAnchor: Option.Option<Element>
  isActive: boolean
}

type Gesture = {
  readonly startedAt: number
  readonly isCaught: boolean
  maybeTapPointerId: Option.Option<number>
  hasMoved: boolean
  hasAnchorPointer: boolean
  isEngaged: boolean
}

type Centroid = Readonly<{ x: number; y: number; span: number }>

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const capSpeed = (speed: number, max: number): number => clamp(speed, -max, max)

const easeOver = (over: number): number =>
  (STRETCH_LOG * over) / (STRETCH_LOG + over)

const rawOver = (shown: number): number => {
  const capped = Math.min(shown, STRETCH_LOG * STRETCH_CAP)
  return (STRETCH_LOG * capped) / (STRETCH_LOG - capped)
}

// NOTE: Past a zoom limit the view still follows the fingers, but with more and
// more resistance, so the limit gives a little instead of stopping dead. Values
// are natural logs of the camera distance.
export const stretchPastLimits = (
  logDistance: number,
  min: number,
  max: number,
): number => {
  if (logDistance > max) {
    return max + easeOver(logDistance - max)
  }
  if (logDistance < min) {
    return min - easeOver(min - logDistance)
  }
  return logDistance
}

export const unstretch = (shown: number, min: number, max: number): number => {
  if (shown > max) {
    return max + rawOver(shown - max)
  }
  if (shown < min) {
    return min - rawOver(min - shown)
  }
  return shown
}

export const clampTarget = (
  target: Vector3,
  distance: number,
  limits: OrbitLimits,
): Vector3 => {
  const span = limits.homeDistance - limits.minDistance
  const reach =
    span > 0 ? clamp((limits.homeDistance - distance) / span, 0, 1) : 0
  return new Vector3(
    clamp(
      target.x,
      limits.home.x - limits.reachX * reach,
      limits.home.x + limits.reachX * reach,
    ),
    target.y,
    clamp(
      target.z,
      limits.home.z - limits.reachZ * reach,
      limits.home.z + limits.reachZ * reach,
    ),
  )
}

// NOTE: Measures the motion over the last moments of a drag. A finger that
// paused before lifting leaves nothing to glide.
export const releaseVelocity = (
  samples: ReadonlyArray<OrbitSample>,
  releasedAt: number,
): OrbitVelocity => {
  const still = { azimuth: 0, polar: 0, logDistance: 0 }
  return Option.match(Array.last(samples), {
    onNone: () => still,
    onSome: last => {
      if (releasedAt - last.time > RELEASE_PAUSE_MS) {
        return still
      }
      const first = Option.getOrElse(
        Array.findLast(
          samples,
          sample => sample.time <= last.time - VELOCITY_WINDOW_MS,
        ),
        () => samples[0] ?? last,
      )
      const elapsed = last.time - first.time
      if (elapsed <= 0) {
        return still
      }
      return {
        azimuth: capSpeed(
          (last.azimuth - first.azimuth) / elapsed,
          MAX_ROTATE_SPEED,
        ),
        polar: capSpeed((last.polar - first.polar) / elapsed, MAX_ROTATE_SPEED),
        logDistance: capSpeed(
          (last.logDistance - first.logDistance) / elapsed,
          MAX_ZOOM_SPEED,
        ),
      }
    },
  })
}

const centroidOf = (
  pointers: ReadonlyArray<Readonly<{ x: number; y: number }>>,
): Option.Option<Centroid> => {
  if (pointers.length === 0) {
    return Option.none()
  }
  const x = Array.reduce(pointers, 0, (sum, pointer) => sum + pointer.x)
  const y = Array.reduce(pointers, 0, (sum, pointer) => sum + pointer.y)
  const centerX = x / pointers.length
  const centerY = y / pointers.length
  const span =
    Array.reduce(
      pointers,
      0,
      (sum, pointer) =>
        sum + Math.hypot(pointer.x - centerX, pointer.y - centerY),
    ) / pointers.length
  return Option.some({ x: centerX, y: centerY, span })
}

const anchorOf = (target: EventTarget | null): Option.Option<Element> =>
  target instanceof Element
    ? Option.fromNullishOr(target.closest(ANCHOR_SELECTOR))
    : Option.none()

const OPEN_LIMITS: OrbitLimits = {
  minDistance: 0,
  maxDistance: Number.POSITIVE_INFINITY,
  minPolar: 0,
  maxPolar: Math.PI,
  home: new Vector3(),
  homeDistance: 1,
  reachX: 0,
  reachZ: 0,
}

// NOTE: Turns pointers and the wheel into camera moves around the house. It
// listens on the whole scene element, so a drag or pinch that starts on a
// floating room or bulb control still moves the camera. A touch on a control
// stays a tap until it moves past the slop or a second finger joins.
export const createOrbitGestures = (
  options: OrbitGestureOptions,
): OrbitGestures => {
  const { element, camera, orbit } = options
  const pointers = new Map<number, TrackedPointer>()
  const raycaster = new Raycaster()
  const ground = new Plane()
  const screenPoint = new Vector2()
  const zoomPoint = new Vector3()
  const state: {
    limits: OrbitLimits
    velocity: OrbitVelocity
    samples: Array<OrbitSample>
    maybeGesture: Option.Option<Gesture>
    wheelHoldMs: number
    swallowClickUntil: number
  } = {
    limits: OPEN_LIMITS,
    velocity: { azimuth: 0, polar: 0, logDistance: 0 },
    samples: [],
    maybeGesture: Option.none(),
    wheelHoldMs: 0,
    swallowClickUntil: 0,
  }

  const logLimits = (): Readonly<{ min: number; max: number }> => ({
    min: Math.log(state.limits.minDistance),
    max: Math.log(state.limits.maxDistance),
  })

  const stretch = (): number => {
    const { min, max } = logLimits()
    const current = Math.log(orbit.distance)
    return current - clamp(current, min, max)
  }

  const isGliding = (): boolean =>
    Math.abs(state.velocity.azimuth) + Math.abs(state.velocity.polar) >
      CATCH_ROTATE_SPEED ||
    Math.abs(state.velocity.logDistance) > CATCH_ZOOM_SPEED ||
    Math.abs(stretch()) > REST_STRETCH

  const stop = (): void => {
    state.velocity = { azimuth: 0, polar: 0, logDistance: 0 }
  }

  const rotateBy = (azimuth: number, polar: number): void => {
    orbit.azimuth += azimuth
    orbit.polar = clamp(
      orbit.polar + polar,
      state.limits.minPolar,
      state.limits.maxPolar,
    )
  }

  const scaleAbout = (scale: number, point: Vector3): void => {
    const target = orbit.target.clone().sub(point).multiplyScalar(scale)
    orbit.distance *= scale
    orbit.target.copy(
      clampTarget(target.add(point), orbit.distance, state.limits),
    )
  }

  const zoomBy = (logDelta: number, point: Vector3): void => {
    const { min, max } = logLimits()
    const current = Math.log(orbit.distance)
    const shown = stretchPastLimits(
      unstretch(current, min, max) + logDelta,
      min,
      max,
    )
    scaleAbout(Math.exp(shown - current), point)
  }

  // NOTE: Zooming keeps the spot under the fingers in place. That spot is
  // where the pointer's ray meets the level of the camera's pivot, so the pivot
  // stays at the same height. A ray that misses, or meets it far off, zooms
  // around the pivot instead.
  const groundPointAt = (clientX: number, clientY: number): Vector3 => {
    const bounds = element.getBoundingClientRect()
    if (bounds.width === 0 || bounds.height === 0) {
      return orbit.target.clone()
    }
    options.syncCamera()
    screenPoint.set(
      ((clientX - bounds.left) / bounds.width) * 2 - 1,
      1 - ((clientY - bounds.top) / bounds.height) * 2,
    )
    raycaster.setFromCamera(screenPoint, camera)
    ground.set(UP, -orbit.target.y)
    const hit = raycaster.ray.intersectPlane(ground, new Vector3())
    return hit !== null &&
      hit.distanceTo(camera.position) <= orbit.distance * MAX_ZOOM_POINT_REACH
      ? hit
      : orbit.target.clone()
  }

  const record = (time: number): void => {
    state.samples = Array.append(
      Array.filter(
        state.samples,
        sample => sample.time >= time - SAMPLE_KEEP_MS,
      ),
      {
        time,
        azimuth: orbit.azimuth,
        polar: orbit.polar,
        logDistance: Math.log(orbit.distance),
      },
    )
  }

  const capture = (pointerId: number): void => {
    if (!element.hasPointerCapture(pointerId)) {
      element.setPointerCapture(pointerId)
    }
  }

  const activate = (pointerId: number, pointer: TrackedPointer): void => {
    if (!pointer.isActive) {
      pointer.isActive = true
      capture(pointerId)
    }
  }

  const engage = (gesture: Gesture, time: number): void => {
    if (!gesture.isEngaged) {
      gesture.isEngaged = true
      options.onGestureStart()
      state.samples = []
      record(time)
    }
  }

  const activeCentroid = (): Option.Option<Centroid> =>
    centroidOf(
      Array.filter(
        globalThis.Array.from(pointers.values()),
        pointer => pointer.isActive,
      ),
    )

  const reset = (): void => {
    pointers.clear()
    state.maybeGesture = Option.none()
    state.samples = []
  }

  // NOTE: A touch still waiting on a floating control is captured only by that
  // control. If the view removes the control mid-touch, the touch may never
  // report its end, so it is dropped rather than left holding the gesture.
  const pruneDetached = (): void => {
    pointers.forEach((pointer, pointerId) => {
      const isDetached =
        !pointer.isActive &&
        Option.exists(pointer.maybeAnchor, anchor => !anchor.isConnected)
      if (isDetached) {
        pointers.delete(pointerId)
      }
    })
    if (pointers.size === 0 && Option.isSome(state.maybeGesture)) {
      state.maybeGesture = Option.none()
      state.samples = []
    }
  }

  const handlePointerDown = (event: PointerEvent): void => {
    const isMouse = event.pointerType === 'mouse'
    if (isMouse && event.button !== 0) {
      return
    }
    if (event.isPrimary && pointers.size > 0) {
      reset()
    }
    pruneDetached()
    const maybeAnchor = anchorOf(event.target)
    const isOnAnchor = Option.isSome(maybeAnchor)
    const gesture = Option.getOrElse(state.maybeGesture, () => {
      // NOTE: A touch that lands while the camera is still moving only stops
      // it, like a touch on a scrolling list. It neither picks in the house
      // nor presses a floating control that was sliding under the finger.
      const isCaught = isGliding() || options.isFlying()
      stop()
      if (isCaught) {
        options.onGestureStart()
      }
      state.swallowClickUntil = 0
      const fresh: Gesture = {
        startedAt: event.timeStamp,
        isCaught,
        maybeTapPointerId: isOnAnchor
          ? Option.none()
          : Option.some(event.pointerId),
        hasMoved: false,
        hasAnchorPointer: false,
        isEngaged: false,
      }
      state.maybeGesture = Option.some(fresh)
      return fresh
    })
    gesture.hasAnchorPointer = gesture.hasAnchorPointer || isOnAnchor
    const pointer: TrackedPointer = {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      maybeAnchor,
      isActive: false,
    }
    pointers.set(event.pointerId, pointer)
    if (!isOnAnchor) {
      activate(event.pointerId, pointer)
      if (isMouse) {
        event.preventDefault()
      }
    }
    if (pointers.size > 1) {
      gesture.hasMoved = true
      gesture.maybeTapPointerId = Option.none()
      pointers.forEach((tracked, pointerId) => {
        activate(pointerId, tracked)
      })
    }
    if (pointer.isActive) {
      engage(gesture, event.timeStamp)
    }
  }

  const handlePointerMove = (event: PointerEvent): void => {
    const pointer = pointers.get(event.pointerId)
    if (pointer === undefined) {
      return
    }
    Option.map(state.maybeGesture, gesture => {
      const travel = Math.hypot(
        event.clientX - pointer.startX,
        event.clientY - pointer.startY,
      )
      if (travel > TAP_SLOP_PX) {
        gesture.hasMoved = true
        gesture.maybeTapPointerId = Option.none()
      }
      // NOTE: A drag from a floating control starts turning from where it left
      // the slop, so the house does not jump to catch up.
      if (!pointer.isActive && travel > TAP_SLOP_PX) {
        pointer.x = event.clientX
        pointer.y = event.clientY
        activate(event.pointerId, pointer)
        engage(gesture, event.timeStamp)
        return
      }
      const maybeBefore = activeCentroid()
      pointer.x = event.clientX
      pointer.y = event.clientY
      const maybeAfter = activeCentroid()
      const height = element.clientHeight
      if (
        !pointer.isActive ||
        height === 0 ||
        Option.isNone(maybeBefore) ||
        Option.isNone(maybeAfter)
      ) {
        return
      }
      const before = maybeBefore.value
      const after = maybeAfter.value
      rotateBy(
        (-ROTATE_PER_HEIGHT * (after.x - before.x)) / height,
        (-ROTATE_PER_HEIGHT * (after.y - before.y)) / height,
      )
      if (before.span > 0 && after.span > 0) {
        zoomPoint.copy(groundPointAt(after.x, after.y))
        zoomBy(Math.log(before.span / after.span), zoomPoint)
      }
      record(event.timeStamp)
      options.onChange()
    })
  }

  const finishPointer = (event: PointerEvent, isCancel: boolean): void => {
    if (!pointers.delete(event.pointerId) || pointers.size > 0) {
      return
    }
    const maybeGesture = state.maybeGesture
    state.maybeGesture = Option.none()
    Option.map(maybeGesture, gesture => {
      const isTap =
        !isCancel &&
        !gesture.hasMoved &&
        !gesture.isCaught &&
        event.timeStamp - gesture.startedAt <= TAP_MAX_MS &&
        Option.exists(
          gesture.maybeTapPointerId,
          pointerId => pointerId === event.pointerId,
        )
      if (isTap) {
        const bounds = element.getBoundingClientRect()
        options.onTap(event.clientX - bounds.left, event.clientY - bounds.top)
      }
      if (gesture.hasAnchorPointer && (gesture.hasMoved || gesture.isCaught)) {
        state.swallowClickUntil = event.timeStamp + CLICK_SWALLOW_MS
      }
      if (gesture.isEngaged && !isCancel) {
        const velocity = releaseVelocity(state.samples, event.timeStamp)
        state.velocity = {
          ...velocity,
          logDistance:
            Math.abs(stretch()) > REST_STRETCH ? 0 : velocity.logDistance,
        }
      }
    })
    state.samples = []
    options.onChange()
  }

  const handlePointerUp = (event: PointerEvent): void => {
    finishPointer(event, false)
  }

  const handlePointerCancel = (event: PointerEvent): void => {
    finishPointer(event, true)
  }

  // NOTE: A drag that began on a floating control must not also press it.
  const handleClick = (event: MouseEvent): void => {
    if (event.timeStamp <= state.swallowClickUntil) {
      state.swallowClickUntil = 0
      event.preventDefault()
      event.stopPropagation()
    }
  }

  const handleWheel = (event: WheelEvent): void => {
    event.preventDefault()
    options.onGestureStart()
    state.velocity.logDistance = 0
    state.wheelHoldMs = WHEEL_SETTLE_MS
    const unit =
      event.deltaMode === 1
        ? WHEEL_LINE_PX
        : event.deltaMode === 2
          ? WHEEL_PAGE_PX
          : 1
    const perPx = event.ctrlKey ? PINCH_WHEEL_ZOOM_PER_PX : WHEEL_ZOOM_PER_PX
    zoomPoint.copy(groundPointAt(event.clientX, event.clientY))
    zoomBy(event.deltaY * unit * perPx, zoomPoint)
    options.onChange()
  }

  const handleContextMenu = (event: MouseEvent): void => {
    if (Option.isNone(anchorOf(event.target))) {
      event.preventDefault()
    }
  }

  const step = (dt: number): boolean => {
    pruneDetached()
    if (pointers.size > 0) {
      return false
    }
    state.wheelHoldMs = Math.max(0, state.wheelHoldMs - dt)
    const { velocity } = state
    const isTurning =
      Math.abs(velocity.azimuth) > REST_ROTATE_SPEED ||
      Math.abs(velocity.polar) > REST_ROTATE_SPEED
    if (isTurning) {
      rotateBy(velocity.azimuth * dt, velocity.polar * dt)
      const decay = Math.exp(-dt / ROTATE_GLIDE_MS)
      const isAtPolarLimit =
        (velocity.polar < 0 && orbit.polar <= state.limits.minPolar) ||
        (velocity.polar > 0 && orbit.polar >= state.limits.maxPolar)
      velocity.azimuth *= decay
      velocity.polar = isAtPolarLimit ? 0 : velocity.polar * decay
    } else {
      velocity.azimuth = 0
      velocity.polar = 0
    }
    const isZooming = Math.abs(velocity.logDistance) > REST_ZOOM_SPEED
    if (isZooming) {
      zoomBy(velocity.logDistance * dt, zoomPoint)
      const glideMs =
        Math.abs(stretch()) > REST_STRETCH ? ZOOM_BOUNCE_MS : ZOOM_GLIDE_MS
      velocity.logDistance *= Math.exp(-dt / glideMs)
    } else {
      velocity.logDistance = 0
    }
    const excess = stretch()
    const isStretched = Math.abs(excess) > SETTLED_STRETCH
    const isSpringing = isStretched && !isZooming && state.wheelHoldMs === 0
    if (isSpringing) {
      const settle =
        Math.abs(excess) < REST_STRETCH ? 1 : 1 - Math.exp(-dt / SPRING_MS)
      scaleAbout(Math.exp(-excess * settle), zoomPoint)
    }
    return isTurning || isZooming || isStretched
  }

  element.addEventListener('pointerdown', handlePointerDown, { capture: true })
  element.addEventListener('click', handleClick, { capture: true })
  element.addEventListener('wheel', handleWheel, { passive: false })
  element.addEventListener('contextmenu', handleContextMenu)
  window.addEventListener('pointermove', handlePointerMove)
  window.addEventListener('pointerup', handlePointerUp)
  window.addEventListener('pointercancel', handlePointerCancel)
  window.addEventListener('blur', reset)

  return {
    setLimits: limits => {
      state.limits = limits
    },
    step,
    stop,
    dispose: () => {
      element.removeEventListener('pointerdown', handlePointerDown, {
        capture: true,
      })
      element.removeEventListener('click', handleClick, { capture: true })
      element.removeEventListener('wheel', handleWheel)
      element.removeEventListener('contextmenu', handleContextMenu)
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
      window.removeEventListener('blur', reset)
      reset()
    },
  }
}
