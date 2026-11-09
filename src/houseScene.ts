import { Array, Match, Option, pipe } from 'effect'
import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  FrontSide,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Raycaster,
  RingGeometry,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

import {
  HouseBulb,
  HouseSelection,
  nearestBulbName,
  roomAreas,
  roomAt,
  sharesLight,
  wallSpans,
} from './house'
import {
  type Furniture,
  HOUSE_DEPTH,
  HOUSE_WIDTH,
  type HouseRoom,
  ROOMS,
  type RoomArea,
  type RoomId,
  WALL_HEIGHT,
  type WallSide,
} from './housePlan'

const MAX_BULBS_PER_ROOM = 10
const MAX_DEVICE_PIXEL_RATIO = 2
const FIELD_OF_VIEW = 32
const CAMERA_NEAR = 1
const CAMERA_FAR = 200
const INITIAL_POLAR_ANGLE = 0.62
const INITIAL_AZIMUTH = -Math.PI / 2 + 0.22
const FRAMING_MARGIN = 1.04
const MIN_ZOOM = 0.42
const MAX_ZOOM = 1.3
const MIN_POLAR_ANGLE = 0.12
const MAX_POLAR_ANGLE = 1.2
const ROTATE_DAMPING = 0.09

const WALL_HEX = '#a09c97'
const WALL_CAP_HEX = '#55555f'
const WALL_CAP_THICKNESS = 0.14
const WALL_SHELL_HEX = '#a7adc2'
const WALL_SHELL_OPACITY = 0.1
const SLAB_HEX = '#1b1b22'
const SLAB_MARGIN = 0.3
const SLAB_THICKNESS = 0.2
const POLE_HEX = '#4c4c56'
const POLE_RADIUS = 0.012
const OFF_BULB_HEX = '#55555f'
const SELECTION_HEX = '#ffffff'
const LABEL_HEX = '#f4f2ee'

const ORB_RADIUS = 0.1
const ROUND_SEGMENTS = 28
const BALL_HEIGHT_SEGMENTS = 18
const HALO_MIN_SCALE = 1.3
const HALO_LEVEL_SCALE = 2.3
const HALO_BASE_OPACITY = 0.35
const HALO_LEVEL_OPACITY = 0.6
const LIGHT_STRENGTH = 4.6
const FADE_RATE = 0.2
const FADE_EPSILON = 0.004
const FULL_ORB_LEVEL = 0.3
const RING_INNER = 0.3
const RING_OUTER = 0.36
const RING_ELEVATION = 0.03

const LABEL_FONT_PX = 64
const LABEL_PADDING_PX = 16
const LABEL_WORLD_HEIGHT = 0.5
const LABEL_ELEVATION = 0.1
const LABEL_OPACITY = 0.62

const TAP_SLOP_PX = 10
const TAP_MAX_MS = 450
const BULB_TAP_RADIUS_PX = 30
const BULB_RENDER_ORDER = 1
const HALO_TEXTURE_PX = 128

const ROOM_VERTEX_SHADER = `
  attribute vec3 color;
  varying vec3 vAlbedo;
  varying vec3 vNormal;
  varying vec3 vWorldPosition;

  void main() {
    vAlbedo = color;
    vNormal = normal;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const ROOM_FRAGMENT_SHADER = `
  uniform vec3 bulbPositions[${MAX_BULBS_PER_ROOM}];
  uniform vec3 bulbColors[${MAX_BULBS_PER_ROOM}];
  uniform int bulbCount;
  uniform float highlight;
  varying vec3 vAlbedo;
  varying vec3 vNormal;
  varying vec3 vWorldPosition;

  void main() {
    vec3 normal = normalize(vNormal);
    float skyFacing = 0.55 + 0.45 * normal.y;
    vec3 received = vec3(0.06, 0.07, 0.1) * skyFacing;
    received += vec3(0.16, 0.16, 0.18) * highlight;

    for (int index = 0; index < bulbCount; index++) {
      vec3 toBulb = bulbPositions[index] - vWorldPosition;
      float squaredDistance = dot(toBulb, toBulb);
      float facing = max(dot(normal, normalize(toBulb)), 0.0);
      float falloff = 1.0 / (1.0 + 0.55 * squaredDistance);
      received += bulbColors[index] * (0.2 + 0.8 * facing) * falloff;
    }

    float isFloor = step(0.9, normal.y) * step(vWorldPosition.y, 0.01);
    float plankSeam = smoothstep(0.0, 0.03, fract(vWorldPosition.z * 2.2));
    vec3 surface = vAlbedo * mix(1.0, 0.82 + 0.18 * plankSeam, isFloor);

    gl_FragColor = vec4(1.0 - exp(-surface * received * 1.6), 1.0);
    #include <colorspace_fragment>
  }
`

export type HouseSceneCallbacks = Readonly<{
  onPickBulb: (name: string) => void
  onPickRoom: (roomId: RoomId) => void
  onClearPick: () => void
}>

export type HouseScene = Readonly<{
  setBulbs: (bulbs: ReadonlyArray<HouseBulb>) => void
  setSelection: (selection: HouseSelection) => void
  dispose: () => void
}>

type BulbVisual = {
  bulb: HouseBulb
  readonly root: Group
  readonly orb: MeshBasicMaterial
  readonly pole: Mesh
  readonly halo: Sprite
  readonly currentColor: Color
  readonly targetColor: Color
  currentLevel: number
}

type LightSlot = Readonly<{ position: Vector3; color: Vector3 }>

type RoomVisual = Readonly<{
  id: RoomId
  slots: ReadonlyArray<LightSlot>
  bulbCount: { value: number }
  highlight: { value: number }
}>

type TapStart = Readonly<{
  pointerId: number
  x: number
  y: number
  time: number
}>

const withColor = <Geometry extends BufferGeometry>(
  geometry: Geometry,
  hex: string,
): Geometry => {
  const color = new Color(hex)
  const vertexCount = geometry.getAttribute('position').count
  geometry.setAttribute(
    'color',
    new Float32BufferAttribute(
      Array.flatten(
        Array.makeBy(vertexCount, () => [color.r, color.g, color.b]),
      ),
      3,
    ),
  )
  return geometry
}

const floorGeometry = (area: RoomArea, hex: string): BufferGeometry =>
  withColor(
    new PlaneGeometry(area.width, area.depth)
      .rotateX(-Math.PI / 2)
      .translate(area.x + area.width / 2, 0, area.z + area.depth / 2),
    hex,
  )

const SIDES: ReadonlyArray<WallSide> = ['North', 'South', 'East', 'West']

const wallQuad = (
  room: RoomArea,
  side: WallSide,
  from: number,
  to: number,
): BufferGeometry => {
  const quad = new PlaneGeometry(to - from, WALL_HEIGHT)
  const middle = (from + to) / 2
  const height = WALL_HEIGHT / 2
  if (side === 'North') {
    return quad.translate(middle, height, room.z)
  }
  if (side === 'South') {
    return quad.rotateY(Math.PI).translate(middle, height, room.z + room.depth)
  }
  if (side === 'West') {
    return quad.rotateY(Math.PI / 2).translate(room.x, height, middle)
  }
  return quad
    .rotateY(-Math.PI / 2)
    .translate(room.x + room.width, height, middle)
}

const wallCap = (
  room: RoomArea,
  side: WallSide,
  from: number,
  to: number,
): BufferGeometry => {
  const length = to - from + WALL_CAP_THICKNESS
  const middle = (from + to) / 2
  const isAlongX = side === 'North' || side === 'South'
  const cap = new BoxGeometry(
    isAlongX ? length : WALL_CAP_THICKNESS,
    0.02,
    isAlongX ? WALL_CAP_THICKNESS : length,
  )
  if (side === 'North') {
    return cap.translate(middle, WALL_HEIGHT, room.z)
  }
  if (side === 'South') {
    return cap.translate(middle, WALL_HEIGHT, room.z + room.depth)
  }
  if (side === 'West') {
    return cap.translate(room.x, WALL_HEIGHT, middle)
  }
  return cap.translate(room.x + room.width, WALL_HEIGHT, middle)
}

const roomWalls = <Geometry>(
  room: RoomArea,
  build: (room: RoomArea, side: WallSide, from: number, to: number) => Geometry,
): ReadonlyArray<Geometry> =>
  Array.flatMap(SIDES, side =>
    Array.map(wallSpans(room, side), ({ from, to }) =>
      build(room, side, from, to),
    ),
  )

const furnitureShape = (piece: Furniture): BufferGeometry =>
  Match.value(piece.shape).pipe(
    Match.withReturnType<BufferGeometry>(),
    Match.when(
      'Round',
      () =>
        new CylinderGeometry(
          (piece.width / 2) * piece.taper,
          piece.width / 2,
          piece.height,
          ROUND_SEGMENTS,
        ),
    ),
    Match.when(
      'Ball',
      () =>
        new SphereGeometry(
          piece.width / 2,
          ROUND_SEGMENTS,
          BALL_HEIGHT_SEGMENTS,
        ),
    ),
    Match.when(
      'Box',
      () => new BoxGeometry(piece.width, piece.height, piece.depth),
    ),
    Match.exhaustive,
  )

const furnitureGeometry = (piece: Furniture): BufferGeometry =>
  withColor(
    furnitureShape(piece)
      .rotateY(piece.turn)
      .translate(
        piece.x + piece.width / 2,
        piece.elevation + piece.height / 2,
        piece.z + piece.depth / 2,
      ),
    piece.hex,
  )

const mergedOrThrow = (
  geometries: ReadonlyArray<BufferGeometry>,
): BufferGeometry => {
  const merged = mergeGeometries([...geometries])
  Array.forEach(geometries, geometry => {
    geometry.dispose()
  })
  return merged
}

const makeSlots = (): ReadonlyArray<LightSlot> =>
  Array.makeBy(MAX_BULBS_PER_ROOM, () => ({
    position: new Vector3(),
    color: new Vector3(),
  }))

const makeRoomVisual = (room: HouseRoom, scene: Scene): RoomVisual => {
  const slots = makeSlots()
  const bulbCount = { value: 0 }
  const highlight = { value: 0 }
  const material = new ShaderMaterial({
    side: FrontSide,
    vertexShader: ROOM_VERTEX_SHADER,
    fragmentShader: ROOM_FRAGMENT_SHADER,
    uniforms: {
      bulbPositions: { value: Array.map(slots, slot => slot.position) },
      bulbColors: { value: Array.map(slots, slot => slot.color) },
      bulbCount,
      highlight,
    },
  })
  const geometry = mergedOrThrow([
    ...Array.flatMap(roomAreas(room), area => [
      floorGeometry(area, room.floorHex),
      ...roomWalls(area, (wallArea, side, from, to) =>
        withColor(wallQuad(wallArea, side, from, to), WALL_HEX),
      ),
    ]),
    ...Array.map(room.furniture, furnitureGeometry),
  ])
  scene.add(new Mesh(geometry, material))
  return { id: room.id, slots, bulbCount, highlight }
}

const addHouseShell = (scene: Scene): void => {
  const areas = Array.flatMap(ROOMS, roomAreas)
  const caps = mergedOrThrow(
    Array.flatMap(areas, area => roomWalls(area, wallCap)),
  )
  scene.add(new Mesh(caps, new MeshBasicMaterial({ color: WALL_CAP_HEX })))

  const ghostWalls = mergedOrThrow(
    Array.flatMap(areas, area => roomWalls(area, wallQuad)),
  )
  scene.add(
    new Mesh(
      ghostWalls,
      new MeshBasicMaterial({
        color: WALL_SHELL_HEX,
        side: BackSide,
        transparent: true,
        opacity: WALL_SHELL_OPACITY,
        depthWrite: false,
      }),
    ),
  )

  const slab = mergedOrThrow(
    Array.map(areas, area =>
      new BoxGeometry(
        area.width + SLAB_MARGIN * 2,
        SLAB_THICKNESS,
        area.depth + SLAB_MARGIN * 2,
      ).translate(
        area.x + area.width / 2,
        -SLAB_THICKNESS / 2 - 0.01,
        area.z + area.depth / 2,
      ),
    ),
  )
  scene.add(new Mesh(slab, new MeshBasicMaterial({ color: SLAB_HEX })))
}

const drawCanvas = (
  width: number,
  height: number,
  draw: (context: CanvasRenderingContext2D) => void,
): Option.Option<CanvasTexture> => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return pipe(
    Option.fromNullishOr(canvas.getContext('2d')),
    Option.map(context => {
      draw(context)
      const texture = new CanvasTexture(canvas)
      texture.colorSpace = SRGBColorSpace
      return texture
    }),
  )
}

const makeHaloTexture = (): Option.Option<CanvasTexture> =>
  drawCanvas(HALO_TEXTURE_PX, HALO_TEXTURE_PX, context => {
    const middle = HALO_TEXTURE_PX / 2
    const gradient = context.createRadialGradient(
      middle,
      middle,
      0,
      middle,
      middle,
      middle,
    )
    gradient.addColorStop(0, 'rgba(255,255,255,0.95)')
    gradient.addColorStop(0.18, 'rgba(255,255,255,0.45)')
    gradient.addColorStop(0.5, 'rgba(255,255,255,0.09)')
    gradient.addColorStop(1, 'rgba(255,255,255,0)')
    context.fillStyle = gradient
    context.fillRect(0, 0, HALO_TEXTURE_PX, HALO_TEXTURE_PX)
  })

const LABEL_FONT = `600 ${LABEL_FONT_PX}px 'Geist Variable', system-ui, sans-serif`

const addRoomLabel = (room: HouseRoom, scene: Scene): void => {
  const measured = document.createElement('canvas').getContext('2d')
  if (measured === null) {
    return
  }
  measured.font = LABEL_FONT
  const textWidth = Math.ceil(measured.measureText(room.label).width)
  const width = textWidth + LABEL_PADDING_PX * 2
  const height = LABEL_FONT_PX + LABEL_PADDING_PX * 2
  const maybeTexture = drawCanvas(width, height, context => {
    context.font = LABEL_FONT
    context.fillStyle = LABEL_HEX
    context.textAlign = 'center'
    context.textBaseline = 'middle'
    context.fillText(room.label, width / 2, height / 2)
  })
  if (Option.isNone(maybeTexture)) {
    return
  }
  const label = new Sprite(
    new SpriteMaterial({
      map: maybeTexture.value,
      transparent: true,
      opacity: LABEL_OPACITY,
      depthTest: false,
      depthWrite: false,
    }),
  )
  label.scale.set((LABEL_WORLD_HEIGHT * width) / height, LABEL_WORLD_HEIGHT, 1)
  label.position.set(room.labelSpot.x, LABEL_ELEVATION, room.labelSpot.z)
  label.renderOrder = 2
  scene.add(label)
}

const disposeObject = (scene: Scene): void => {
  const disposeMaterial = (material: Material & { map?: unknown }): void => {
    if (material.map instanceof CanvasTexture) {
      material.map.dispose()
    }
    material.dispose()
  }
  scene.traverse(object => {
    if (object instanceof Mesh) {
      if (object.geometry instanceof BufferGeometry) {
        object.geometry.dispose()
      }
      if (object.material instanceof Material) {
        disposeMaterial(object.material)
      }
    }
    if (object instanceof Sprite) {
      disposeMaterial(object.material)
    }
  })
}

const stepToward = (current: number, target: number): number =>
  Math.abs(target - current) < FADE_EPSILON
    ? target
    : current + (target - current) * FADE_RATE

export const createHouseScene = (
  host: HTMLElement,
  callbacks: HouseSceneCallbacks,
): HouseScene => {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio, MAX_DEVICE_PIXEL_RATIO),
  )
  const canvas = renderer.domElement
  canvas.style.display = 'block'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  host.append(canvas)

  const scene = new Scene()
  const camera = new PerspectiveCamera(
    FIELD_OF_VIEW,
    1,
    CAMERA_NEAR,
    CAMERA_FAR,
  )
  const center = new Vector3(HOUSE_WIDTH / 2, 0.4, HOUSE_DEPTH / 2)
  const controls = new OrbitControls(camera, canvas)
  controls.target.copy(center)
  controls.enablePan = false
  controls.enableDamping = true
  controls.dampingFactor = ROTATE_DAMPING
  controls.minPolarAngle = MIN_POLAR_ANGLE
  controls.maxPolarAngle = MAX_POLAR_ANGLE

  const rooms = Array.map(ROOMS, room => makeRoomVisual(room, scene))
  addHouseShell(scene)
  Array.forEach(ROOMS, room => {
    addRoomLabel(room, scene)
  })

  const maybeHaloTexture = makeHaloTexture()
  const orbGeometry = new SphereGeometry(ORB_RADIUS, 20, 14)
  const poleGeometry = new CylinderGeometry(
    POLE_RADIUS,
    POLE_RADIUS,
    1,
    6,
  ).translate(0, -0.5, 0)
  const poleMaterial = new MeshBasicMaterial({ color: POLE_HEX })

  const selectionRing = new Mesh(
    new RingGeometry(RING_INNER, RING_OUTER, 48).rotateX(-Math.PI / 2),
    new MeshBasicMaterial({
      color: SELECTION_HEX,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    }),
  )
  selectionRing.visible = false
  selectionRing.renderOrder = 1
  scene.add(selectionRing)

  const visuals = new Map<string, BulbVisual>()
  const offColor = new Color(OFF_BULB_HEX)
  const frame = { isScheduled: false, id: 0 }
  const framing = { hasFramed: false }
  const pick = { maybeStart: Option.none<TapStart>() }
  const currentSelection: { value: HouseSelection } = {
    value: HouseSelection.Nothing(),
  }

  const makeVisual = (bulb: HouseBulb): BulbVisual => {
    const root = new Group()
    const orb = new MeshBasicMaterial({
      color: OFF_BULB_HEX,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    })
    const halo = new Sprite(
      new SpriteMaterial({
        ...Option.match(maybeHaloTexture, {
          onNone: () => ({}),
          onSome: map => ({ map }),
        }),
        blending: AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0,
      }),
    )
    const pole = new Mesh(poleGeometry, poleMaterial)
    const orbMesh = new Mesh(orbGeometry, orb)
    orbMesh.renderOrder = BULB_RENDER_ORDER
    halo.renderOrder = BULB_RENDER_ORDER
    root.add(orbMesh, pole, halo)
    scene.add(root)
    const visual: BulbVisual = {
      bulb,
      root,
      orb,
      pole,
      halo,
      currentColor: new Color(bulb.hex),
      targetColor: new Color(bulb.hex),
      currentLevel: 0,
    }
    visuals.set(bulb.name, visual)
    return visual
  }

  const removeVisual = (visual: BulbVisual): void => {
    scene.remove(visual.root)
    visual.orb.dispose()
    visual.halo.material.dispose()
    visuals.delete(visual.bulb.name)
  }

  const applyLook = (visual: BulbVisual): void => {
    const { orb, halo, currentColor, currentLevel } = visual
    orb.color
      .copy(offColor)
      .lerp(currentColor, Math.min(1, currentLevel / FULL_ORB_LEVEL))
    halo.material.color.copy(currentColor)
    halo.material.opacity =
      currentLevel === 0
        ? 0
        : Math.min(1, currentLevel / FULL_ORB_LEVEL) *
          (HALO_BASE_OPACITY + HALO_LEVEL_OPACITY * currentLevel)
    const scale = HALO_MIN_SCALE + HALO_LEVEL_SCALE * currentLevel
    halo.scale.set(scale, scale, 1)
  }

  const fadeVisual = (visual: BulbVisual): boolean => {
    const { currentColor, targetColor, bulb } = visual
    const nextRed = stepToward(currentColor.r, targetColor.r)
    const nextGreen = stepToward(currentColor.g, targetColor.g)
    const nextBlue = stepToward(currentColor.b, targetColor.b)
    const nextLevel = stepToward(visual.currentLevel, bulb.level)
    const isFading =
      nextRed !== targetColor.r ||
      nextGreen !== targetColor.g ||
      nextBlue !== targetColor.b ||
      nextLevel !== bulb.level
    currentColor.setRGB(nextRed, nextGreen, nextBlue)
    visual.currentLevel = nextLevel
    applyLook(visual)
    return isFading
  }

  const applyRoomLights = (): void => {
    Array.forEach(rooms, room => {
      const roomVisuals = Array.filter(
        globalThis.Array.from(visuals.values()),
        visual => sharesLight(visual.bulb.roomId, room.id),
      )
      const paired = Array.zip(room.slots, roomVisuals)
      Array.forEach(paired, ([slot, visual]) => {
        slot.position.copy(visual.root.position)
        const strength = visual.currentLevel * LIGHT_STRENGTH
        slot.color.set(
          visual.currentColor.r * strength,
          visual.currentColor.g * strength,
          visual.currentColor.b * strength,
        )
      })
      room.bulbCount.value = paired.length
    })
  }

  const applySelection = (): void => {
    const selected = currentSelection.value
    const maybeBulb = HouseSelection.match(selected, {
      Nothing: () => Option.none<BulbVisual>(),
      Room: () => Option.none<BulbVisual>(),
      Bulb: ({ name }) => Option.fromNullishOr(visuals.get(name)),
    })
    selectionRing.visible = Option.isSome(maybeBulb)
    if (Option.isSome(maybeBulb)) {
      const { x, z } = maybeBulb.value.bulb
      selectionRing.position.set(x, RING_ELEVATION, z)
    }
    Array.forEach(rooms, room => {
      room.highlight.value = HouseSelection.match(selected, {
        Nothing: () => 0,
        Bulb: () => 0,
        Room: ({ roomId }) => (roomId === room.id ? 1 : 0),
      })
    })
  }

  const renderFrame = (): void => {
    frame.isScheduled = false
    const isMoving = controls.update()
    const isFading = Array.reduce(
      globalThis.Array.from(visuals.values()),
      false,
      (anyFading, visual) => fadeVisual(visual) || anyFading,
    )
    applyRoomLights()
    renderer.render(scene, camera)
    if (isMoving || isFading) {
      requestFrame()
    }
  }

  const requestFrame = (): void => {
    if (!frame.isScheduled) {
      frame.isScheduled = true
      frame.id = requestAnimationFrame(renderFrame)
    }
  }

  const frameHouse = (width: number, height: number): void => {
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    const verticalHalf = (FIELD_OF_VIEW * Math.PI) / 360
    const horizontalHalf = Math.atan(Math.tan(verticalHalf) * camera.aspect)
    const reach = Math.hypot(HOUSE_WIDTH, HOUSE_DEPTH) / 2
    const distance =
      (reach * FRAMING_MARGIN) /
      Math.sin(Math.min(verticalHalf, horizontalHalf))
    controls.minDistance = distance * MIN_ZOOM
    controls.maxDistance = distance * MAX_ZOOM
    if (!framing.hasFramed) {
      framing.hasFramed = true
      camera.position
        .setFromSphericalCoords(distance, INITIAL_POLAR_ANGLE, INITIAL_AZIMUTH)
        .add(center)
    }
  }

  const resize = (): void => {
    const width = host.clientWidth
    const height = host.clientHeight
    if (width > 0 && height > 0) {
      renderer.setSize(width, height, false)
      frameHouse(width, height)
      requestFrame()
    }
  }

  const screenPoints = (width: number, height: number) =>
    Array.map(globalThis.Array.from(visuals.values()), visual => {
      const projected = visual.root.position.clone().project(camera)
      return {
        name: visual.bulb.name,
        x: ((projected.x + 1) / 2) * width,
        y: ((1 - projected.y) / 2) * height,
      }
    })

  const floorPlane = new Plane(new Vector3(0, 1, 0), 0)
  const raycaster = new Raycaster()

  const handleTap = (x: number, y: number): void => {
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    const maybeBulb = nearestBulbName(
      screenPoints(width, height),
      x,
      y,
      BULB_TAP_RADIUS_PX,
    )
    if (Option.isSome(maybeBulb)) {
      callbacks.onPickBulb(maybeBulb.value)
      return
    }
    raycaster.setFromCamera(
      new Vector2((x / width) * 2 - 1, 1 - (y / height) * 2),
      camera,
    )
    const hit = raycaster.ray.intersectPlane(floorPlane, new Vector3())
    const maybeRoom = pipe(
      Option.fromNullishOr(hit),
      Option.flatMap(point => roomAt(point.x, point.z)),
    )
    if (Option.isSome(maybeRoom)) {
      callbacks.onPickRoom(maybeRoom.value)
    } else {
      callbacks.onClearPick()
    }
  }

  const handlePointerDown = (event: PointerEvent): void => {
    pick.maybeStart =
      event.isPrimary && Option.isNone(pick.maybeStart)
        ? Option.some({
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            time: event.timeStamp,
          })
        : Option.none()
  }

  const handlePointerUp = (event: PointerEvent): void => {
    const maybeStart = pick.maybeStart
    pick.maybeStart = Option.none()
    if (Option.isNone(maybeStart)) {
      return
    }
    const start = maybeStart.value
    const isTap =
      start.pointerId === event.pointerId &&
      Math.hypot(event.clientX - start.x, event.clientY - start.y) <=
        TAP_SLOP_PX &&
      event.timeStamp - start.time <= TAP_MAX_MS
    if (isTap) {
      const bounds = canvas.getBoundingClientRect()
      handleTap(event.clientX - bounds.left, event.clientY - bounds.top)
    }
  }

  const handlePointerCancel = (): void => {
    pick.maybeStart = Option.none()
  }

  const handleContextLost = (event: Event): void => {
    event.preventDefault()
  }

  canvas.addEventListener('pointerdown', handlePointerDown)
  canvas.addEventListener('pointerup', handlePointerUp)
  canvas.addEventListener('pointercancel', handlePointerCancel)
  canvas.addEventListener('webglcontextlost', handleContextLost)
  canvas.addEventListener('webglcontextrestored', requestFrame)
  controls.addEventListener('change', requestFrame)

  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(host)
  resize()

  return {
    setBulbs: bulbs => {
      const names = new Set(Array.map(bulbs, bulb => bulb.name))
      Array.forEach(globalThis.Array.from(visuals.values()), visual => {
        if (!names.has(visual.bulb.name)) {
          removeVisual(visual)
        }
      })
      Array.forEach(bulbs, bulb => {
        const visual = visuals.get(bulb.name) ?? makeVisual(bulb)
        visual.bulb = bulb
        visual.targetColor.set(bulb.hex)
        visual.root.position.set(bulb.x, bulb.y, bulb.z)
        visual.pole.visible = !bulb.isMounted
        visual.pole.scale.y = bulb.y
      })
      applySelection()
      requestFrame()
    },

    setSelection: selection => {
      currentSelection.value = selection
      applySelection()
      requestFrame()
    },

    dispose: () => {
      cancelAnimationFrame(frame.id)
      resizeObserver.disconnect()
      canvas.removeEventListener('pointerdown', handlePointerDown)
      canvas.removeEventListener('pointerup', handlePointerUp)
      canvas.removeEventListener('pointercancel', handlePointerCancel)
      canvas.removeEventListener('webglcontextlost', handleContextLost)
      canvas.removeEventListener('webglcontextrestored', requestFrame)
      controls.removeEventListener('change', requestFrame)
      controls.dispose()
      disposeObject(scene)
      Option.map(maybeHaloTexture, texture => {
        texture.dispose()
      })
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
}
