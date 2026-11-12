import { Option, Schema } from 'effect'
import { describe, expect, test } from 'vitest'

import {
  DEFAULT_SCREEN_CONFIG,
  ScreenColorsJson,
  screenConfigProblem,
} from './screen'

const decode = Schema.decodeUnknownOption(ScreenColorsJson)

describe('ScreenColors', () => {
  test('reads the frames the Joshflix relay sends', () => {
    // NOTE: Copied from the relay's own tests (joshflix-protocol).
    expect(
      decode(
        '{"_tag":"ScreenColors","playing":true,"title":"Dune","color":"#c8742f"}',
      ),
    ).toEqual(
      Option.some({
        _tag: 'ScreenColors',
        playing: true,
        title: 'Dune',
        color: '#c8742f',
      }),
    )
    expect(
      Option.isSome(
        decode(
          '{"_tag":"ScreenColors","playing":false,"title":null,"color":null}',
        ),
      ),
    ).toBe(true)
  })

  test('refuses frames with a broken color or another tag', () => {
    for (const text of [
      '{"_tag":"ScreenColors","playing":true,"title":null,"color":"orange"}',
      '{"_tag":"NowPlaying","playing":true,"title":null,"color":null}',
      'not json',
    ]) {
      expect(decode(text)).toEqual(Option.none())
    }
  })
})

describe('screenConfigProblem', () => {
  test('needs a group', () => {
    expect(screenConfigProblem(DEFAULT_SCREEN_CONFIG)).toEqual(Option.none())
    expect(
      Option.isSome(
        screenConfigProblem({ ...DEFAULT_SCREEN_CONFIG, group: '  ' }),
      ),
    ).toBe(true)
  })
})
