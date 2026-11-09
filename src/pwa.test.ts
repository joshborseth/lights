import { Option } from 'effect'
import { describe, expect, it } from 'vitest'

import { installedAppHeight } from './pwa'

const PHONE = { width: 390, height: 844 }

describe('installedAppHeight', () => {
  it('fills the screen when iOS reports a viewport one status bar short', () => {
    expect(
      installedAppHeight({ width: 390, height: 797 }, PHONE),
    ).toStrictEqual(Option.some(844))
  })

  it('uses the short side once the phone turns sideways', () => {
    expect(
      installedAppHeight({ width: 844, height: 390 }, PHONE),
    ).toStrictEqual(Option.some(390))
  })

  it('leaves a window narrower than the screen alone', () => {
    expect(
      installedAppHeight(
        { width: 507, height: 1024 },
        { width: 1024, height: 1366 },
      ),
    ).toStrictEqual(Option.none())
  })
})
