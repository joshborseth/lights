import { Array, Match, Option, Order, pipe } from 'effect'
import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  CubeCamera,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  FrontSide,
  Group,
  LinearFilter,
  Material,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  NoColorSpace,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  Raycaster,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
  Vector4,
  WebGLCubeRenderTarget,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

import {
  HouseBulb,
  HouseFocus,
  nearestBulbName,
  roomAreas,
  roomById,
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

const BULB_SLOTS = 10
const MAX_DEVICE_PIXEL_RATIO = 2
const FIELD_OF_VIEW = 30
const CAMERA_NEAR = 0.5
const CAMERA_FAR = 200

const OVERVIEW_POLAR = 0.66
const OVERVIEW_AZIMUTH = 0.34
const ROOM_POLAR = 0.86
const INTRO_POLAR = 0.3
const INTRO_AZIMUTH_OFFSET = 0.75
const INTRO_DISTANCE_FACTOR = 1.5
const INTRO_MS = 1700
const FLIGHT_MS = 950

const MIN_POLAR_ANGLE = 0.1
const MAX_POLAR_ANGLE = 1.25
const ROTATE_DAMPING = 0.09
const OVERVIEW_MIN_ZOOM = 0.45
const OVERVIEW_MAX_ZOOM = 1.25
const ROOM_MIN_ZOOM = 0.55
const ROOM_MAX_ZOOM = 1.5

const OVERVIEW_TOP_INSET_PX = 92
const OVERVIEW_BOTTOM_INSET_PX = 110
const ROOM_TOP_INSET_PX = 76
const VIEW_EDGE_MARGIN_PX = 10
const WIDE_LAYOUT_QUERY = '(min-width: 768px)'
const SIDE_PANEL_GAP_PX = 16
const ANCHOR_EDGE_MARGIN_PX = 8
const ANCHOR_GAP_PX = 6
const PANEL_SELECTOR = '[data-scene-panel]'

const HOUSE_CENTER_HEIGHT = 0.5
const ROOM_FRAME_HEIGHT = 1.5
const ROOM_FRAME_MARGIN = 0.15

const WALL_HEX = '#d2cdc5'
const WALL_CAP_HEX = '#b9b6b1'
const WALL_CAP_THICKNESS = 0.13
const WALL_CAP_BEVEL = 0.02
const CAP_UNLIT_SHADE = 0.34
const WALL_SHELL_HEX = '#94a3c8'
const WALL_SHELL_OPACITY = 0.06
const SLAB_HEX = '#141721'
const SLAB_MARGIN = 0.22
const SLAB_THICKNESS = 0.28
const POLE_HEX = '#4c4c56'
const POLE_RADIUS = 0.012
const OFF_BULB_HEX = '#3a3d48'

const ORB_RADIUS = 0.07
const ROUND_SEGMENTS = 28
const BALL_HEIGHT_SEGMENTS = 18
const HALO_MIN_SCALE = 0.7
const HALO_LEVEL_SCALE = 1.25
const HALO_BASE_OPACITY = 0.16
const HALO_LEVEL_OPACITY = 0.4
const LIGHT_STRENGTH = 2.9
const FADE_MS = 150
const FADE_EPSILON = 0.004
const FULL_ORB_LEVEL = 0.3
const LEVEL_BLOOM_POWER = 0.85

const TAP_SLOP_PX = 10
const TAP_MAX_MS = 450
const BULB_TAP_RADIUS_PX = 26
const BULB_RENDER_ORDER = 1
const HALO_TEXTURE_PX = 128
const GROUND_GLOW_SIZE = 26
const GROUND_GLOW_HEIGHT = -0.32
const GROUND_GLOW_STRENGTH = 0.2

const SHADOW_MAP_PX = 384
const SHADOW_NEAR = 0.5
const SHADOW_RANGE = 16
const SHADOW_TAPS_AT_REST = 8
const SHADOW_TAPS_IN_MOTION = 3

const CONTACT_TEXTURE_PX = 1024
const CONTACT_MARGIN = 1
const CONTACT_FLAT_HEIGHT = 0.05
const CONTACT_FLOOR_REACH = 0.3
const CONTACT_BLUR_PX = 22
const CONTACT_WALL_BLUR_PX = 30
const CONTACT_WALL_WIDTH_PX = 10
const CONTACT_SHADE = 'rgba(0,0,0,0.62)'
const CONTACT_WALL_SHADE = 'rgba(0,0,0,0.5)'
const OFFSCREEN_SHIFT_PX = 8192

const FOCUS_FADE_MS = 420
const MAX_FRAME_STEP_MS = 400
const CUT_INSET = 0.03
const CUT_SHELL_MARGIN = -0.1
const CUT_OPEN_DISTANCE = 14
const CUT_FACING_THRESHOLD = 0.45
const OUT_OF_FOCUS_HALO = 0.2

const SHADOW_VERTEX_SHADER = `
  varying vec3 vWorldPosition;

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const SHADOW_FRAGMENT_SHADER = `
  uniform vec3 lightPosition;
  varying vec3 vWorldPosition;

  void main() {
    float stored = clamp(length(vWorldPosition - lightPosition) / ${SHADOW_RANGE}.0, 0.0, 1.0);
    float scaled = stored * 255.0;
    gl_FragColor = vec4(floor(scaled) / 255.0, fract(scaled), 0.0, 1.0);
  }
`

const HOUSE_VERTEX_SHADER = `
  attribute vec3 color;
  attribute float roomIndex;
  attribute float lightSpace;
  varying vec3 vAlbedo;
  varying vec3 vNormal;
  varying vec3 vWorldPosition;
  varying float vRoomIndex;
  varying float vLightSpace;

  void main() {
    vAlbedo = color;
    vNormal = normal;
    vRoomIndex = roomIndex;
    vLightSpace = lightSpace;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorldPosition = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const bulbSlotLines = Array.join(
  Array.makeBy(
    BULB_SLOTS,
    index =>
      `if (bulbCount > ${index}) { received += shade(bulbPositions[${index}], bulbColors[${index}], bulbSpaces[${index}], shadowMaps[${index}], normal, rotation); }`,
  ),
  '\n',
)

// NOTE: Direct light is blocked by the baked shadow maps, so it stops at walls
// and spills through doorways by itself. The bounce term is what fills a real
// room with light, and only reaches surfaces in the bulb's own light space.
const HOUSE_FRAGMENT_SHADER = `
  uniform vec3 bulbPositions[${BULB_SLOTS}];
  uniform vec3 bulbColors[${BULB_SLOTS}];
  uniform float bulbSpaces[${BULB_SLOTS}];
  uniform samplerCube shadowMaps[${BULB_SLOTS}];
  uniform int bulbCount;
  uniform int shadowTaps;
  uniform float focusRoom;
  uniform float focusMix;
  uniform sampler2D contactShadows;
  uniform vec4 contactArea;
  uniform vec2 cutX;
  uniform vec2 cutZ;
  varying vec3 vAlbedo;
  varying vec3 vNormal;
  varying vec3 vWorldPosition;
  varying float vRoomIndex;
  varying float vLightSpace;

  float visibility(samplerCube map, vec3 fromBulb, float distanceToBulb, float bias, float rotation) {
    vec3 direction = fromBulb / distanceToBulb;
    vec3 axis = abs(direction.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 tangent = normalize(cross(direction, axis));
    vec3 bitangent = cross(direction, tangent);
    float blocked = 0.0;
    for (int tap = 0; tap < shadowTaps; tap++) {
      float angle = float(tap) * 2.39996 + rotation;
      float reach = sqrt((float(tap) + 0.5) / float(shadowTaps)) * 0.016;
      vec3 sampleDirection = direction + (tangent * cos(angle) + bitangent * sin(angle)) * reach;
      vec4 packedDepth = textureCube(map, sampleDirection);
      float stored = (packedDepth.r + packedDepth.g / 255.0) * ${SHADOW_RANGE}.0;
      blocked += step(stored + bias, distanceToBulb);
    }
    return 1.0 - blocked / float(shadowTaps);
  }

  vec3 shade(vec3 bulbPosition, vec3 bulbColor, float bulbSpace, samplerCube map, vec3 normal, float rotation) {
    if (dot(bulbColor, bulbColor) < 0.00001) {
      return vec3(0.0);
    }
    vec3 toBulb = bulbPosition - vWorldPosition;
    float squaredDistance = dot(toBulb, toBulb);
    float distanceToBulb = sqrt(squaredDistance);
    float facing = max(dot(normal, toBulb / distanceToBulb), 0.0);
    float falloff = 1.0 / (1.0 + 0.62 * squaredDistance);
    float bias = 0.04 + 0.1 * (1.0 - facing);
    float visible = facing > 0.0 ? visibility(map, -toBulb, distanceToBulb, bias, rotation) : 0.0;
    float isSameSpace = step(abs(bulbSpace - vLightSpace), 0.5);
    float fill = isSameSpace * 0.16 * (0.72 + 0.28 * normal.y) / (1.0 + 0.22 * squaredDistance);
    float glow = smoothstep(0.62, 0.1, distanceToBulb) * 1.8;
    return bulbColor * (facing * falloff * visible + fill + glow);
  }

  void main() {
    float isOtherRoom = 1.0 - step(abs(vRoomIndex - focusRoom), 0.5);
    if (isOtherRoom > 0.5 && (cutX.x * vWorldPosition.x > cutX.y || cutZ.x * vWorldPosition.z > cutZ.y)) {
      discard;
    }
    vec3 normal = normalize(vNormal);
    float rotation = 6.28318 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float skyFacing = 0.55 + 0.45 * normal.y;
    vec3 received = vec3(0.075, 0.1, 0.19) * skyFacing;

    ${bulbSlotLines}

    float isFloor = step(0.9, normal.y) * step(vWorldPosition.y, 0.01);
    float isWall = 1.0 - step(0.2, abs(normal.y));
    float plankRow = floor(vWorldPosition.z * 5.4);
    float plankTint = fract(sin(plankRow * 91.7) * 43758.5453);
    float plankOffset = plankTint * 3.0;
    float endJoint = smoothstep(0.0, 0.012, fract(vWorldPosition.x * 0.55 + plankOffset));
    float seam = smoothstep(0.0, 0.05, fract(vWorldPosition.z * 5.4));
    float planks = (0.86 + 0.14 * plankTint) * (0.8 + 0.2 * seam) * (0.86 + 0.14 * endJoint);
    vec2 contactPoint = (vWorldPosition.xz - contactArea.xy) / contactArea.zw;
    float contact = texture2D(contactShadows, contactPoint).r;
    float wallFoot = 0.68 + 0.32 * smoothstep(0.0, 0.42, vWorldPosition.y);
    vec3 surface = vAlbedo * mix(1.0, planks * contact, isFloor) * mix(1.0, wallFoot, isWall);

    vec3 lit = surface * received;
    float isOutOfFocus = focusMix * (1.0 - step(abs(vRoomIndex - focusRoom), 0.5));
    float luminance = dot(lit, vec3(0.2126, 0.7152, 0.0722));
    lit = mix(lit, vec3(luminance) * vec3(0.72, 0.8, 1.0) * 0.42, isOutOfFocus * 0.82);

    gl_FragColor = vec4(1.0 - exp(-lit * 1.6), 1.0);
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
  setFocus: (focus: HouseFocus) => void
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

type TapStart = Readonly<{
  pointerId: number
  x: number
  y: number
  time: number
}>

type Insets = Readonly<{ top: number; right: number; bottom: number }>

type CameraPose = Readonly<{
  target: Vector3
  distance: number
  polar: number
  azimuth: number
  offsetX: number
  offsetY: number
}>

type Flight = Readonly<{
  from: CameraPose
  to: CameraPose
  durationMs: number
}>

type Bounds = Readonly<{
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  height: number
}>

const easeInOutCubic = (progress: number): number =>
  progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2

const shortestAngle = (from: number, to: number): number => {
  const turn = Math.PI * 2
  return ((((to - from) % turn) + turn * 1.5) % turn) - Math.PI
}

const mix = (from: number, to: number, amount: number): number =>
  from + (to - from) * amount

const withConstantAttribute = <Geometry extends BufferGeometry>(
  geometry: Geometry,
  name: string,
  value: number,
): Geometry => {
  const vertexCount = geometry.getAttribute('position').count
  geometry.setAttribute(
    name,
    new Float32BufferAttribute(
      Array.makeBy(vertexCount, () => value),
      1,
    ),
  )
  return geometry
}

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
    WALL_CAP_BEVEL,
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

const LIGHT_SPACES = Array.dedupe(Array.map(ROOMS, room => room.lightSpace))

const lightSpaceOf = (room: HouseRoom): number =>
  Math.max(
    0,
    LIGHT_SPACES.findIndex(space => space === room.lightSpace),
  )

const roomIndexOf = (roomId: RoomId): number =>
  ROOMS.findIndex(room => room.id === roomId)

const roomGeometry = (room: HouseRoom, roomIndex: number): BufferGeometry =>
  withConstantAttribute(
    withConstantAttribute(
      mergedOrThrow([
        ...Array.flatMap(roomAreas(room), area => [
          floorGeometry(area, room.floorHex),
          ...roomWalls(area, (wallArea, side, from, to) =>
            withColor(wallQuad(wallArea, side, from, to), WALL_HEX),
          ),
        ]),
        ...Array.map(room.furniture, furnitureGeometry),
      ]),
      'roomIndex',
      roomIndex,
    ),
    'lightSpace',
    lightSpaceOf(room),
  )

const houseGeometry = (): BufferGeometry =>
  mergedOrThrow(Array.map(ROOMS, roomGeometry))

const addHouseShell = (
  scene: Scene,
  cutPlanes: ReadonlyArray<Plane>,
): MeshBasicMaterial => {
  const areas = Array.flatMap(ROOMS, roomAreas)
  const caps = mergedOrThrow(
    Array.flatMap(areas, area => roomWalls(area, wallCap)),
  )
  const capMaterial = new MeshBasicMaterial({
    color: WALL_CAP_HEX,
    clippingPlanes: [...cutPlanes],
  })
  scene.add(new Mesh(caps, capMaterial))

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
        clippingPlanes: [...cutPlanes],
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
  scene.add(
    new Mesh(
      slab,
      new MeshBasicMaterial({
        color: SLAB_HEX,
        clippingPlanes: [...cutPlanes],
      }),
    ),
  )
  return capMaterial
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
      return new CanvasTexture(canvas)
    }),
  )
}

const makeHaloTexture = (): Option.Option<CanvasTexture> =>
  Option.map(
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
    }),
    texture => {
      texture.colorSpace = SRGBColorSpace
      return texture
    },
  )

const makeGroundGlowTexture = (): Option.Option<CanvasTexture> =>
  Option.map(
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
      gradient.addColorStop(0, 'rgba(255,255,255,0.6)')
      gradient.addColorStop(0.45, 'rgba(255,255,255,0.32)')
      gradient.addColorStop(1, 'rgba(255,255,255,0)')
      context.fillStyle = gradient
      context.fillRect(0, 0, HALO_TEXTURE_PX, HALO_TEXTURE_PX)
    }),
    texture => {
      texture.colorSpace = SRGBColorSpace
      return texture
    },
  )

const CONTACT_WIDTH = HOUSE_WIDTH + CONTACT_MARGIN * 2
const CONTACT_DEPTH = HOUSE_DEPTH + CONTACT_MARGIN * 2

const contactPixelX = (x: number): number =>
  ((x + CONTACT_MARGIN) / CONTACT_WIDTH) * CONTACT_TEXTURE_PX

const contactPixelZ = (z: number): number =>
  ((z + CONTACT_MARGIN) / CONTACT_DEPTH) * CONTACT_TEXTURE_PX

const isGroundedFurniture = (piece: Furniture): boolean =>
  piece.elevation <= CONTACT_FLOOR_REACH && piece.height > CONTACT_FLAT_HEIGHT

const drawFurnitureContact = (
  context: CanvasRenderingContext2D,
  piece: Furniture,
): void => {
  context.fillRect(
    contactPixelX(piece.x) - OFFSCREEN_SHIFT_PX,
    contactPixelZ(piece.z),
    (piece.width / CONTACT_WIDTH) * CONTACT_TEXTURE_PX,
    (piece.depth / CONTACT_DEPTH) * CONTACT_TEXTURE_PX,
  )
}

const drawWallContact = (
  context: CanvasRenderingContext2D,
  room: RoomArea,
  side: WallSide,
  from: number,
  to: number,
): void => {
  const isAlongX = side === 'North' || side === 'South'
  const fixed = Match.value(side).pipe(
    Match.when('North', () => room.z),
    Match.when('South', () => room.z + room.depth),
    Match.when('West', () => room.x),
    Match.when('East', () => room.x + room.width),
    Match.exhaustive,
  )
  context.beginPath()
  context.moveTo(
    (isAlongX ? contactPixelX(from) : contactPixelX(fixed)) -
      OFFSCREEN_SHIFT_PX,
    isAlongX ? contactPixelZ(fixed) : contactPixelZ(from),
  )
  context.lineTo(
    (isAlongX ? contactPixelX(to) : contactPixelX(fixed)) - OFFSCREEN_SHIFT_PX,
    isAlongX ? contactPixelZ(fixed) : contactPixelZ(to),
  )
  context.stroke()
}

// NOTE: Safari has no canvas filter property, so the blur comes from a shadow
// cast by shapes drawn just off the canvas.
const makeContactShadows = (): Option.Option<CanvasTexture> =>
  Option.map(
    drawCanvas(CONTACT_TEXTURE_PX, CONTACT_TEXTURE_PX, context => {
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, CONTACT_TEXTURE_PX, CONTACT_TEXTURE_PX)
      context.shadowOffsetX = OFFSCREEN_SHIFT_PX
      context.shadowColor = CONTACT_SHADE
      context.shadowBlur = CONTACT_BLUR_PX
      context.fillStyle = '#000000'
      Array.forEach(ROOMS, room => {
        Array.forEach(
          Array.filter(room.furniture, isGroundedFurniture),
          piece => {
            drawFurnitureContact(context, piece)
          },
        )
      })
      context.shadowColor = CONTACT_WALL_SHADE
      context.shadowBlur = CONTACT_WALL_BLUR_PX
      context.strokeStyle = '#000000'
      context.lineWidth = CONTACT_WALL_WIDTH_PX
      Array.forEach(Array.flatMap(ROOMS, roomAreas), area => {
        roomWalls(area, (wallArea, side, from, to) => {
          drawWallContact(context, wallArea, side, from, to)
        })
      })
    }),
    texture => {
      texture.colorSpace = NoColorSpace
      texture.minFilter = LinearFilter
      texture.magFilter = LinearFilter
      texture.generateMipmaps = false
      texture.flipY = false
      return texture
    },
  )

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

const stepToward = (current: number, target: number, amount: number): number =>
  Math.abs(target - current) < FADE_EPSILON
    ? target
    : current + (target - current) * amount

const focusRoomId = (
  focus: HouseFocus,
  bulbs: ReadonlyArray<HouseBulb>,
): Option.Option<RoomId> =>
  HouseFocus.match(focus, {
    Overview: () => Option.none(),
    Scenes: () => Option.none(),
    Room: ({ roomId }) => Option.some(roomId),
    Bulb: ({ name }) =>
      Option.map(
        Array.findFirst(bulbs, bulb => bulb.name === name),
        bulb => bulb.roomId,
      ),
  })

const WHOLE_HOUSE: Bounds = {
  minX: 0,
  maxX: HOUSE_WIDTH,
  minZ: 0,
  maxZ: HOUSE_DEPTH,
  height: WALL_HEIGHT * 0.7,
}

const boundsOfRoom = (room: HouseRoom): Bounds => ({
  minX: room.x - ROOM_FRAME_MARGIN,
  maxX: room.x + room.width + ROOM_FRAME_MARGIN,
  minZ: room.z - ROOM_FRAME_MARGIN,
  maxZ: room.z + room.depth + ROOM_FRAME_MARGIN,
  height: ROOM_FRAME_HEIGHT,
})

const boundsCenter = (bounds: Bounds): Vector3 =>
  new Vector3(
    (bounds.minX + bounds.maxX) / 2,
    HOUSE_CENTER_HEIGHT,
    (bounds.minZ + bounds.maxZ) / 2,
  )

const boundsCorners = (bounds: Bounds): ReadonlyArray<Vector3> =>
  Array.flatMap([0, bounds.height], y =>
    Array.flatMap([bounds.minX, bounds.maxX], x =>
      Array.map([bounds.minZ, bounds.maxZ], z => new Vector3(x, y, z)),
    ),
  )

// NOTE: Solves for the closest camera distance that keeps every corner inside
// the part of the screen no panel or button covers.
const fittingDistance = (
  bounds: Bounds,
  target: Vector3,
  polar: number,
  azimuth: number,
  width: number,
  height: number,
  insets: Insets,
): number => {
  const toCamera = new Vector3().setFromSphericalCoords(1, polar, azimuth)
  const right = new Vector3()
    .crossVectors(toCamera.clone().negate(), new Vector3(0, 1, 0))
    .normalize()
  const up = new Vector3().crossVectors(right, toCamera.clone().negate())
  const halfTangent = Math.tan((FIELD_OF_VIEW * Math.PI) / 360)
  const safeWidth = Math.max(1, width - insets.right - VIEW_EDGE_MARGIN_PX * 2)
  const safeHeight = Math.max(1, height - insets.top - insets.bottom)
  const tangentX = halfTangent * (safeWidth / height)
  const tangentY = halfTangent * (safeHeight / height)
  return Array.reduce(boundsCorners(bounds), 1, (distance, corner) => {
    const relative = corner.clone().sub(target)
    const along = relative.dot(toCamera)
    return Math.max(
      distance,
      along + Math.abs(relative.dot(right)) / tangentX,
      along + Math.abs(relative.dot(up)) / tangentY,
    )
  })
}

type PlacedAnchor = Readonly<{
  element: HTMLElement
  x: number
  y: number
  halfWidth: number
  halfHeight: number
}>

type SpreadAnchor = PlacedAnchor & Readonly<{ push: number }>

const byAnchorX = Order.mapInput(
  Order.Number,
  (anchor: PlacedAnchor) => anchor.x,
)

// NOTE: Two fixtures can sit close enough that their labels collide at this
// zoom, so each pair shares the distance needed to clear each other.
const spreadApart = (
  anchors: ReadonlyArray<PlacedAnchor>,
): ReadonlyArray<SpreadAnchor> => {
  const sorted = Array.sort(anchors, byAnchorX)
  return Array.map(sorted, (anchor, index) => {
    const overlapWith = (other: PlacedAnchor): number => {
      const gap =
        Math.abs(anchor.x - other.x) -
        (anchor.halfWidth + other.halfWidth + ANCHOR_GAP_PX)
      const sharesRow =
        Math.abs(anchor.y - other.y) < anchor.halfHeight + other.halfHeight
      return sharesRow && gap < 0 ? -gap / 2 : 0
    }
    const push =
      Option.match(Array.get(sorted, index + 1), {
        onNone: () => 0,
        onSome: next => -overlapWith(next),
      }) +
      Option.match(Array.get(sorted, index - 1), {
        onNone: () => 0,
        onSome: previous => overlapWith(previous),
      })
    return { ...anchor, push }
  })
}

export const createHouseScene = (
  host: HTMLElement,
  anchorRoot: HTMLElement,
  callbacks: HouseSceneCallbacks,
): HouseScene => {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio, MAX_DEVICE_PIXEL_RATIO),
  )
  renderer.localClippingEnabled = true
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
  const controls = new OrbitControls(camera, canvas)
  controls.enablePan = false
  controls.enableDamping = true
  controls.dampingFactor = ROTATE_DAMPING
  controls.minPolarAngle = MIN_POLAR_ANGLE
  controls.maxPolarAngle = MAX_POLAR_ANGLE

  const geometry = houseGeometry()
  const bulbPositions = Array.makeBy(BULB_SLOTS, () => new Vector3())
  const bulbColors = Array.makeBy(BULB_SLOTS, () => new Vector3())
  const bulbSpaces = Array.makeBy(BULB_SLOTS, () => 0)
  const maybeContactShadows = makeContactShadows()

  const emptyShadowTarget = new WebGLCubeRenderTarget(1)
  const emptyShadowCamera = new CubeCamera(0.1, 1, emptyShadowTarget)
  const shadowTargets = Array.makeBy(BULB_SLOTS, () => {
    const target = new WebGLCubeRenderTarget(SHADOW_MAP_PX, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
      generateMipmaps: false,
    })
    return { target, camera: new CubeCamera(SHADOW_NEAR, SHADOW_RANGE, target) }
  })
  const shadowMaps: Array<WebGLCubeRenderTarget['texture']> = Array.makeBy(
    BULB_SLOTS,
    () => emptyShadowTarget.texture,
  )

  const uniforms = {
    bulbPositions: { value: bulbPositions },
    bulbColors: { value: bulbColors },
    bulbSpaces: { value: bulbSpaces },
    shadowMaps: { value: shadowMaps },
    bulbCount: { value: 0 },
    shadowTaps: { value: SHADOW_TAPS_AT_REST },
    focusRoom: { value: -1 },
    focusMix: { value: 0 },
    contactShadows: {
      value: Option.getOrNull(maybeContactShadows),
    },
    cutX: { value: new Vector2(0, 1) },
    cutZ: { value: new Vector2(0, 1) },
    contactArea: {
      value: new Vector4(
        -CONTACT_MARGIN,
        -CONTACT_MARGIN,
        CONTACT_WIDTH,
        CONTACT_DEPTH,
      ),
    },
  }
  const houseMaterial = new ShaderMaterial({
    side: FrontSide,
    vertexShader: HOUSE_VERTEX_SHADER,
    fragmentShader: HOUSE_FRAGMENT_SHADER,
    uniforms,
  })
  const houseMesh = new Mesh(geometry, houseMaterial)
  scene.add(houseMesh)
  const cutPlaneX = new Plane(new Vector3(-1, 0, 0), CUT_OPEN_DISTANCE)
  const cutPlaneZ = new Plane(new Vector3(0, 0, -1), CUT_OPEN_DISTANCE)
  const capMaterial = addHouseShell(scene, [cutPlaneX, cutPlaneZ])
  const capColor = new Color(WALL_CAP_HEX)

  const shadowUniforms = { lightPosition: { value: new Vector3() } }
  const shadowScene = new Scene()
  shadowScene.add(
    new Mesh(
      geometry,
      new ShaderMaterial({
        side: DoubleSide,
        vertexShader: SHADOW_VERTEX_SHADER,
        fragmentShader: SHADOW_FRAGMENT_SHADER,
        uniforms: shadowUniforms,
      }),
    ),
  )

  const maybeHaloTexture = makeHaloTexture()
  const maybeGroundGlowTexture = makeGroundGlowTexture()
  const groundGlowMaterial = new MeshBasicMaterial({
    ...Option.match(maybeGroundGlowTexture, {
      onNone: () => ({}),
      onSome: map => ({ map }),
    }),
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
    opacity: 1,
    color: 0x000000,
  })
  const groundGlow = new Mesh(
    new PlaneGeometry(GROUND_GLOW_SIZE, GROUND_GLOW_SIZE).rotateX(-Math.PI / 2),
    groundGlowMaterial,
  )
  groundGlow.position.set(HOUSE_WIDTH / 2, GROUND_GLOW_HEIGHT, HOUSE_DEPTH / 2)
  groundGlow.renderOrder = -1
  scene.add(groundGlow)
  const orbGeometry = new SphereGeometry(ORB_RADIUS, 20, 14)
  const poleGeometry = new CylinderGeometry(
    POLE_RADIUS,
    POLE_RADIUS,
    1,
    6,
  ).translate(0, -0.5, 0)
  const poleMaterial = new MeshBasicMaterial({ color: POLE_HEX })

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const wideLayout = window.matchMedia(WIDE_LAYOUT_QUERY)
  const visuals = new Map<string, BulbVisual>()
  const offColor = new Color(OFF_BULB_HEX)
  const projected = new Vector3()
  const state: {
    isFrameScheduled: boolean
    frameId: number
    isPanelMeasureScheduled: boolean
    panelMeasureId: number
    lastFrameAt: number
    bakedPositions: string
    sizedWidth: number
    sizedHeight: number
    hasFramed: boolean
    maybeFlight: Option.Option<Flight>
    flightStartedAt: number
    maybePick: Option.Option<TapStart>
    focus: HouseFocus
    focusRoomId: Option.Option<RoomId>
    cutBounds: Bounds
    bulbs: ReadonlyArray<HouseBulb>
    offsetX: number
    offsetY: number
  } = {
    isFrameScheduled: false,
    frameId: 0,
    isPanelMeasureScheduled: false,
    panelMeasureId: 0,
    lastFrameAt: 0,
    bakedPositions: '',
    sizedWidth: 0,
    sizedHeight: 0,
    hasFramed: false,
    maybeFlight: Option.none(),
    flightStartedAt: 0,
    maybePick: Option.none(),
    focus: HouseFocus.Overview(),
    focusRoomId: Option.none(),
    cutBounds: WHOLE_HOUSE,
    bulbs: [],
    offsetX: 0,
    offsetY: 0,
  }
  const allVisuals = (): ReadonlyArray<BulbVisual> =>
    globalThis.Array.from(visuals.values())

  const applyOffset = (offsetX: number, offsetY: number): void => {
    const width = host.clientWidth
    const height = host.clientHeight
    state.offsetX = offsetX
    state.offsetY = offsetY
    camera.setViewOffset(width, height, offsetX, offsetY, width, height)
  }

  const applyPose = (pose: CameraPose): void => {
    controls.target.copy(pose.target)
    camera.position
      .setFromSphericalCoords(pose.distance, pose.polar, pose.azimuth)
      .add(pose.target)
    camera.lookAt(pose.target)
    applyOffset(pose.offsetX, pose.offsetY)
  }

  const currentPose = (): CameraPose => ({
    target: controls.target.clone(),
    distance: camera.position.distanceTo(controls.target),
    polar: controls.getPolarAngle(),
    azimuth: controls.getAzimuthalAngle(),
    offsetX: state.offsetX,
    offsetY: state.offsetY,
  })

  const panelInsets = (): Insets => {
    const panel = document.querySelector<HTMLElement>(PANEL_SELECTOR)
    if (panel === null) {
      return {
        top: OVERVIEW_TOP_INSET_PX,
        right: 0,
        bottom: OVERVIEW_BOTTOM_INSET_PX,
      }
    }
    return wideLayout.matches
      ? {
          top: ROOM_TOP_INSET_PX,
          right: panel.offsetWidth + SIDE_PANEL_GAP_PX * 2,
          bottom: VIEW_EDGE_MARGIN_PX,
        }
      : { top: ROOM_TOP_INSET_PX, right: 0, bottom: panel.offsetHeight }
  }

  const poseForFocus = (azimuth: number): CameraPose => {
    const width = host.clientWidth
    const height = host.clientHeight
    const insets = panelInsets()
    const maybeRoom = Option.flatMap(state.focusRoomId, roomById)
    const bounds = Option.match(maybeRoom, {
      onNone: () => WHOLE_HOUSE,
      onSome: boundsOfRoom,
    })
    const polar = Option.isSome(maybeRoom) ? ROOM_POLAR : OVERVIEW_POLAR
    const target = boundsCenter(bounds)
    return {
      target,
      polar,
      azimuth,
      distance: fittingDistance(
        bounds,
        target,
        polar,
        azimuth,
        width,
        height,
        insets,
      ),
      offsetX: insets.right / 2,
      offsetY: (insets.bottom - insets.top) / 2,
    }
  }

  const setZoomLimits = (distance: number): void => {
    const isInRoom = Option.isSome(state.focusRoomId)
    controls.minDistance =
      distance * (isInRoom ? ROOM_MIN_ZOOM : OVERVIEW_MIN_ZOOM)
    controls.maxDistance =
      distance * (isInRoom ? ROOM_MAX_ZOOM : OVERVIEW_MAX_ZOOM)
  }

  const startFlight = (
    from: CameraPose,
    to: CameraPose,
    durationMs: number,
  ): void => {
    if (reducedMotion.matches) {
      applyPose(to)
      setZoomLimits(to.distance)
      requestFrame()
      return
    }
    controls.minDistance = 0
    controls.maxDistance = Number.POSITIVE_INFINITY
    controls.enabled = false
    state.flightStartedAt = 0
    state.maybeFlight = Option.some({ from, to, durationMs })
    requestFrame()
  }

  const endFlight = (flight: Flight): void => {
    state.maybeFlight = Option.none()
    controls.enabled = true
    setZoomLimits(flight.to.distance)
  }

  const advanceFlight = (now: number): boolean =>
    Option.match(state.maybeFlight, {
      onNone: () => false,
      onSome: flight => {
        state.flightStartedAt =
          state.flightStartedAt === 0 ? now : state.flightStartedAt
        const progress = Math.min(
          1,
          (now - state.flightStartedAt) / flight.durationMs,
        )
        const eased = easeInOutCubic(progress)
        const { from, to } = flight
        applyPose({
          target: from.target.clone().lerp(to.target, eased),
          distance: mix(from.distance, to.distance, eased),
          polar: mix(from.polar, to.polar, eased),
          azimuth:
            from.azimuth + shortestAngle(from.azimuth, to.azimuth) * eased,
          offsetX: mix(from.offsetX, to.offsetX, eased),
          offsetY: mix(from.offsetY, to.offsetY, eased),
        })
        if (progress >= 1) {
          endFlight(flight)
          return false
        }
        return true
      },
    })

  const flyToFocus = (): void => {
    const from = currentPose()
    startFlight(from, poseForFocus(from.azimuth), FLIGHT_MS)
  }

  const scheduleFlightAfterLayout = (): void => {
    if (!state.isPanelMeasureScheduled) {
      state.isPanelMeasureScheduled = true
      state.panelMeasureId = requestAnimationFrame(() => {
        state.isPanelMeasureScheduled = false
        flyToFocus()
      })
    }
  }

  const bakeShadows = (): void => {
    const paired = Array.zip(shadowTargets, allVisuals())
    const positions = Array.join(
      Array.map(paired, ([, visual]) => visual.root.position.toArray().join()),
      ';',
    )
    if (positions === state.bakedPositions) {
      return
    }
    state.bakedPositions = positions
    const previousColor = renderer.getClearColor(new Color()).getHex()
    const previousAlpha = renderer.getClearAlpha()
    renderer.setClearColor(0xffffff, 1)
    emptyShadowCamera.update(renderer, new Scene())
    Array.forEach(paired, ([slot, visual], index) => {
      shadowUniforms.lightPosition.value.copy(visual.root.position)
      slot.camera.position.copy(visual.root.position)
      slot.camera.update(renderer, shadowScene)
      shadowMaps[index] = slot.target.texture
    })
    renderer.setClearColor(previousColor, previousAlpha)
    Array.forEach(Array.drop(shadowMaps, paired.length), (_, index) => {
      shadowMaps[paired.length + index] = emptyShadowTarget.texture
    })
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

  const fadeVisual = (visual: BulbVisual, amount: number): boolean => {
    const { currentColor, targetColor, bulb } = visual
    const nextRed = stepToward(currentColor.r, targetColor.r, amount)
    const nextGreen = stepToward(currentColor.g, targetColor.g, amount)
    const nextBlue = stepToward(currentColor.b, targetColor.b, amount)
    const nextLevel = stepToward(visual.currentLevel, bulb.level, amount)
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

  const applyBulbLights = (): void => {
    const paired = Array.zip(bulbPositions, allVisuals())
    Array.forEach(paired, ([position, visual], index) => {
      position.copy(visual.root.position)
      const strength = visual.currentLevel ** LEVEL_BLOOM_POWER * LIGHT_STRENGTH
      bulbColors[index]?.set(
        visual.currentColor.r * strength,
        visual.currentColor.g * strength,
        visual.currentColor.b * strength,
      )
      bulbSpaces[index] = Option.match(roomById(visual.bulb.roomId), {
        onNone: () => 0,
        onSome: lightSpaceOf,
      })
    })
    uniforms.bulbCount.value = paired.length
    const sharedColor = Array.reduce(
      paired,
      new Color(0x000000),
      (sum, [, visual]) =>
        sum.add(
          visual.currentColor.clone().multiplyScalar(visual.currentLevel),
        ),
    )
    const averageLevel =
      Array.reduce(paired, 0, (sum, [, visual]) => sum + visual.currentLevel) /
      Math.max(1, paired.length)
    capMaterial.color
      .copy(capColor)
      .multiplyScalar(mix(CAP_UNLIT_SHADE, 1, Math.min(1, averageLevel * 1.6)))
    groundGlowMaterial.color
      .copy(sharedColor)
      .multiplyScalar(GROUND_GLOW_STRENGTH / Math.max(1, paired.length))
  }

  const applyFocusFade = (dt: number): boolean => {
    const targetMix = Option.isSome(state.focusRoomId) ? 1 : 0
    const amount = 1 - Math.exp(-dt / FOCUS_FADE_MS)
    uniforms.focusMix.value = stepToward(
      uniforms.focusMix.value,
      targetMix,
      amount,
    )
    Option.match(state.focusRoomId, {
      onNone: () => undefined,
      onSome: roomId => {
        uniforms.focusRoom.value = roomIndexOf(roomId)
      },
    })
    return uniforms.focusMix.value !== targetMix
  }

  // NOTE: Backface culling only hides the focused room's own near walls. The
  // rooms beyond them are cut away along those walls' lines, so the wall of the
  // next room over can't stand in front of the one being controlled. A side is
  // cut only when the camera really is on that side.
  const applyCut = (): void => {
    Option.map(Option.flatMap(state.focusRoomId, roomById), room => {
      state.cutBounds = boundsOfRoom(room)
    })
    const azimuth = controls.getAzimuthalAngle()
    const towardX = Math.sin(azimuth)
    const towardZ = Math.cos(azimuth)
    const open = (1 - uniforms.focusMix.value ** 2) * CUT_OPEN_DISTANCE
    const margin = ROOM_FRAME_MARGIN
    const signX =
      Math.abs(towardX) > CUT_FACING_THRESHOLD ? Math.sign(towardX) : 0
    const signZ =
      Math.abs(towardZ) > CUT_FACING_THRESHOLD ? Math.sign(towardZ) : 0
    const edgeX =
      signX > 0 ? state.cutBounds.maxX - margin : state.cutBounds.minX + margin
    const edgeZ =
      signZ > 0 ? state.cutBounds.maxZ - margin : state.cutBounds.minZ + margin
    const limitX = signX === 0 ? 1 : signX * edgeX - CUT_INSET + open
    const limitZ = signZ === 0 ? 1 : signZ * edgeZ - CUT_INSET + open
    uniforms.cutX.value.set(signX, limitX)
    uniforms.cutZ.value.set(signZ, limitZ)
    cutPlaneX.normal.set(-signX, 0, 0)
    cutPlaneX.constant = signX === 0 ? 1 : limitX + CUT_INSET + CUT_SHELL_MARGIN
    cutPlaneZ.normal.set(0, 0, -signZ)
    cutPlaneZ.constant = signZ === 0 ? 1 : limitZ + CUT_INSET + CUT_SHELL_MARGIN
    Array.forEach(allVisuals(), visual => {
      const isFocusedRoom = Option.exists(
        state.focusRoomId,
        roomId => roomId === visual.bulb.roomId,
      )
      visual.root.visible =
        isFocusedRoom ||
        (signX * visual.root.position.x <= limitX &&
          signZ * visual.root.position.z <= limitZ)
      visual.halo.material.opacity *= isFocusedRoom
        ? 1
        : 1 - uniforms.focusMix.value * (1 - OUT_OF_FOCUS_HALO)
    })
  }

  const placeAnchors = (): void => {
    const width = host.clientWidth
    const height = host.clientHeight
    const placed = Array.map(
      globalThis.Array.from(
        anchorRoot.querySelectorAll<HTMLElement>('[data-anchor]'),
      ),
      element => {
        const { anchorX, anchorY, anchorZ } = element.dataset
        projected
          .set(Number(anchorX ?? 0), Number(anchorY ?? 0), Number(anchorZ ?? 0))
          .project(camera)
        return {
          element,
          x: ((projected.x + 1) / 2) * width,
          y: ((1 - projected.y) / 2) * height,
          halfWidth: element.offsetWidth / 2,
          halfHeight: element.offsetHeight / 2,
        }
      },
    )
    const spread = spreadApart(placed)
    Array.forEach(spread, anchor => {
      const edgeX = anchor.halfWidth + ANCHOR_EDGE_MARGIN_PX
      const edgeY = anchor.halfHeight + ANCHOR_EDGE_MARGIN_PX
      const x = Math.min(
        Math.max(anchor.x, edgeX),
        Math.max(edgeX, width - edgeX),
      )
      const y = Math.min(
        Math.max(anchor.y, edgeY),
        Math.max(edgeY, height - edgeY),
      )
      anchor.element.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`
      anchor.element.style.setProperty(
        '--spread-x',
        `${anchor.push.toFixed(1)}px`,
      )
      anchor.element.dataset['placed'] = ''
    })
  }

  const renderFrame = (now: number): void => {
    state.isFrameScheduled = false
    const dt = Math.min(
      MAX_FRAME_STEP_MS,
      state.lastFrameAt === 0 ? 16 : now - state.lastFrameAt,
    )
    state.lastFrameAt = now
    const isFlying = advanceFlight(now)
    const isMoving = isFlying ? false : controls.update()
    const fadeAmount = 1 - Math.exp(-dt / FADE_MS)
    const isFading = Array.reduce(
      allVisuals(),
      false,
      (anyFading, visual) => fadeVisual(visual, fadeAmount) || anyFading,
    )
    const isFocusFading = applyFocusFade(dt)
    applyCut()
    applyBulbLights()
    bakeShadows()
    uniforms.shadowTaps.value =
      isFlying || isMoving ? SHADOW_TAPS_IN_MOTION : SHADOW_TAPS_AT_REST
    renderer.setRenderTarget(null)
    renderer.render(scene, camera)
    placeAnchors()
    if (isFlying || isMoving || isFading || isFocusFading) {
      requestFrame()
    } else {
      state.lastFrameAt = 0
    }
  }

  const requestFrame = (): void => {
    if (!state.isFrameScheduled) {
      state.isFrameScheduled = true
      state.frameId = requestAnimationFrame(renderFrame)
    }
  }

  const frameHouse = (width: number, height: number): void => {
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    if (!state.hasFramed) {
      state.hasFramed = true
      const settled = poseForFocus(OVERVIEW_AZIMUTH)
      setZoomLimits(settled.distance)
      applyPose({
        ...settled,
        distance: settled.distance * INTRO_DISTANCE_FACTOR,
        polar: INTRO_POLAR,
        azimuth: OVERVIEW_AZIMUTH + INTRO_AZIMUTH_OFFSET,
      })
      startFlight(currentPose(), settled, INTRO_MS)
      return
    }
    state.maybeFlight = Option.none()
    controls.enabled = true
    const pose = poseForFocus(controls.getAzimuthalAngle())
    setZoomLimits(pose.distance)
    applyPose(pose)
  }

  const resize = (): void => {
    const width = host.clientWidth
    const height = host.clientHeight
    const isSameSize =
      width === state.sizedWidth && height === state.sizedHeight
    if (width > 0 && height > 0 && !isSameSize) {
      state.sizedWidth = width
      state.sizedHeight = height
      renderer.setSize(width, height, false)
      frameHouse(width, height)
      requestFrame()
    }
  }

  const screenPoints = (width: number, height: number) =>
    Array.map(allVisuals(), visual => {
      const point = visual.root.position.clone().project(camera)
      return {
        name: visual.bulb.name,
        x: ((point.x + 1) / 2) * width,
        y: ((1 - point.y) / 2) * height,
      }
    })

  const raycaster = new Raycaster()
  const roomIndexAttribute = geometry.getAttribute('roomIndex')

  const roomIndexOfHit = (vertex: number): number =>
    roomIndexAttribute.getX(vertex)

  const isOutsideCut = (roomIndex: number, point: Vector3): boolean =>
    uniforms.focusMix.value > 0 &&
    roomIndex !== uniforms.focusRoom.value &&
    (uniforms.cutX.value.x * point.x > uniforms.cutX.value.y ||
      uniforms.cutZ.value.x * point.z > uniforms.cutZ.value.y)

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
    const maybeRoom = pipe(
      raycaster.intersectObject(houseMesh),
      Array.findFirst(hit => {
        const roomIndex = roomIndexOfHit(hit.face?.a ?? 0)
        return isOutsideCut(roomIndex, hit.point)
          ? Option.none()
          : Option.fromNullishOr(ROOMS[roomIndex])
      }),
      Option.map(room => room.id),
    )
    if (Option.isSome(maybeRoom)) {
      callbacks.onPickRoom(maybeRoom.value)
    } else {
      callbacks.onClearPick()
    }
  }

  const handlePointerDown = (event: PointerEvent): void => {
    Option.map(state.maybeFlight, endFlight)
    state.maybePick =
      event.isPrimary && Option.isNone(state.maybePick)
        ? Option.some({
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            time: event.timeStamp,
          })
        : Option.none()
  }

  const handlePointerUp = (event: PointerEvent): void => {
    const maybeStart = state.maybePick
    state.maybePick = Option.none()
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
    state.maybePick = Option.none()
  }

  const handleContextLost = (event: Event): void => {
    event.preventDefault()
  }

  const handleContextRestored = (): void => {
    state.bakedPositions = ''
    requestFrame()
  }

  canvas.addEventListener('pointerdown', handlePointerDown)
  canvas.addEventListener('pointerup', handlePointerUp)
  canvas.addEventListener('pointercancel', handlePointerCancel)
  canvas.addEventListener('webglcontextlost', handleContextLost)
  canvas.addEventListener('webglcontextrestored', handleContextRestored)
  controls.addEventListener('change', requestFrame)

  const resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(host)
  const anchorObserver = new MutationObserver(requestFrame)
  anchorObserver.observe(anchorRoot, { childList: true })
  resize()

  return {
    setBulbs: bulbs => {
      const names = new Set(Array.map(bulbs, bulb => bulb.name))
      Array.forEach(allVisuals(), visual => {
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
      state.bulbs = bulbs
      const nextRoomId = focusRoomId(state.focus, bulbs)
      if (
        Option.getOrNull(state.focusRoomId) !== Option.getOrNull(nextRoomId)
      ) {
        state.focusRoomId = nextRoomId
        scheduleFlightAfterLayout()
      }
      requestFrame()
    },

    setFocus: focus => {
      state.focus = focus
      state.focusRoomId = focusRoomId(focus, state.bulbs)
      if (state.hasFramed) {
        scheduleFlightAfterLayout()
      }
      requestFrame()
    },

    dispose: () => {
      cancelAnimationFrame(state.frameId)
      cancelAnimationFrame(state.panelMeasureId)
      resizeObserver.disconnect()
      anchorObserver.disconnect()
      canvas.removeEventListener('pointerdown', handlePointerDown)
      canvas.removeEventListener('pointerup', handlePointerUp)
      canvas.removeEventListener('pointercancel', handlePointerCancel)
      canvas.removeEventListener('webglcontextlost', handleContextLost)
      canvas.removeEventListener('webglcontextrestored', handleContextRestored)
      controls.removeEventListener('change', requestFrame)
      controls.dispose()
      disposeObject(scene)
      disposeObject(shadowScene)
      Array.forEach(shadowTargets, ({ target }) => {
        target.dispose()
      })
      emptyShadowTarget.dispose()
      Option.map(maybeHaloTexture, texture => {
        texture.dispose()
      })
      Option.map(maybeContactShadows, texture => {
        texture.dispose()
      })
      Option.map(maybeGroundGlowTexture, texture => {
        texture.dispose()
      })
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
}
