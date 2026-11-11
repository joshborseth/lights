import { Array, Option, pipe } from 'effect'
import { type BufferGeometry, Vector2, Vector3 } from 'three'
import { describe, expect, test } from 'vitest'

import { houseGeometry } from './houseScene'

const PLANE_PRECISION = 1000
const OVERLAP_TOLERANCE = 1e-6
const FLOOR_LEVEL = 1e-4

type Triangle = Readonly<{
  points: ReadonlyArray<Vector3>
  normal: Vector3
  offset: number
  color: string
}>

const roundedKey = (value: number): string =>
  (Math.round(value * PLANE_PRECISION) / PLANE_PRECISION + 0).toFixed(3)

const trianglesOf = (geometry: BufferGeometry): ReadonlyArray<Triangle> => {
  const position = geometry.getAttribute('position')
  const color = geometry.getAttribute('color')
  const vertexAt = (triangle: number, corner: number): number => {
    const vertex = triangle * 3 + corner
    return geometry.index === null ? vertex : geometry.index.getX(vertex)
  }
  const triangleCount = (geometry.index?.count ?? position.count) / 3
  return Array.getSomes(
    Array.map(Array.range(0, triangleCount - 1), triangle => {
      const vertices = Array.map([0, 1, 2], corner =>
        vertexAt(triangle, corner),
      )
      const points = Array.map(
        vertices,
        vertex =>
          new Vector3(
            position.getX(vertex),
            position.getY(vertex),
            position.getZ(vertex),
          ),
      )
      const [first, second, third] = points
      if (first === undefined || second === undefined || third === undefined) {
        return Option.none()
      }
      const normal = new Vector3()
        .subVectors(second, first)
        .cross(new Vector3().subVectors(third, first))
      if (normal.lengthSq() === 0) {
        return Option.none()
      }
      normal.normalize()
      const vertex = vertices[0] ?? 0
      return Option.some({
        points,
        normal,
        offset: normal.dot(first),
        color: [color.getX(vertex), color.getY(vertex), color.getZ(vertex)]
          .map(channel => channel.toFixed(3))
          .join(),
      })
    }),
  )
}

// NOTE: The camera always looks down on the house, so the underside of a piece
// standing on the floor is never drawn.
const isHiddenUnderside = (triangle: Triangle): boolean =>
  triangle.normal.y < -0.9 &&
  Array.every(triangle.points, point => point.y <= FLOOR_LEVEL)

const planeKey = (triangle: Triangle): string =>
  [
    ...triangle.normal.toArray().map(roundedKey),
    roundedKey(triangle.offset),
  ].join('|')

const onPlane = (triangle: Triangle): ReadonlyArray<Vector2> => {
  const helper =
    Math.abs(triangle.normal.y) < 0.9
      ? new Vector3(0, 1, 0)
      : new Vector3(1, 0, 0)
  const across = new Vector3().crossVectors(triangle.normal, helper).normalize()
  const along = new Vector3().crossVectors(triangle.normal, across)
  return Array.map(
    triangle.points,
    point => new Vector2(point.dot(across), point.dot(along)),
  )
}

const edgeNormals = (corners: ReadonlyArray<Vector2>): ReadonlyArray<Vector2> =>
  Array.map(corners, (corner, index) => {
    const next = corners[(index + 1) % corners.length] ?? corner
    return new Vector2(next.y - corner.y, corner.x - next.x)
  })

const isSeparatedAlong = (
  axis: Vector2,
  first: ReadonlyArray<Vector2>,
  second: ReadonlyArray<Vector2>,
): boolean => {
  const firstSpan = Array.map(first, corner => corner.dot(axis))
  const secondSpan = Array.map(second, corner => corner.dot(axis))
  const tolerance = OVERLAP_TOLERANCE * axis.length()
  return (
    Math.max(...firstSpan) <= Math.min(...secondSpan) + tolerance ||
    Math.max(...secondSpan) <= Math.min(...firstSpan) + tolerance
  )
}

const doOverlap = (first: Triangle, second: Triangle): boolean => {
  const firstCorners = onPlane(first)
  const secondCorners = onPlane(second)
  return !Array.some(
    [...edgeNormals(firstCorners), ...edgeNormals(secondCorners)],
    axis => isSeparatedAlong(axis, firstCorners, secondCorners),
  )
}

const describeClash = (first: Triangle, second: Triangle): string => {
  const point = first.points[0] ?? new Vector3()
  return `${first.color} and ${second.color} share plane ${planeKey(first)} near ${point
    .toArray()
    .map(value => value.toFixed(2))
    .join(', ')}`
}

const clashesWithin = (
  triangles: ReadonlyArray<Triangle>,
): ReadonlyArray<string> =>
  Array.flatMap(triangles, (first, index) =>
    pipe(
      Array.drop(triangles, index + 1),
      Array.filter(
        second => second.color !== first.color && doOverlap(first, second),
      ),
      Array.map(second => describeClash(first, second)),
    ),
  )

describe('houseGeometry', () => {
  // NOTE: Two differently colored faces on the same plane, facing the same way,
  // z-fight: the depth test picks a different winner from frame to frame, so
  // the overlap flickers as the camera moves.
  test('no two visible faces of different colors share a plane', () => {
    const groups = pipe(
      trianglesOf(houseGeometry()),
      Array.filter(triangle => !isHiddenUnderside(triangle)),
      Array.groupBy(planeKey),
    )
    const clashes = Array.dedupe(
      Array.flatMap(Object.values(groups), clashesWithin),
    )
    expect(clashes).toEqual([])
  })
})
