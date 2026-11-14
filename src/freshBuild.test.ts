import { describe, expect, test } from 'vitest'

import { isNewBuild } from './freshBuild'

const page = (src: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="${src}"></script></head><body><div id="root"></div></body></html>`

describe('isNewBuild', () => {
  test('a different bundle is a new build', () => {
    expect(
      isNewBuild('/assets/index-old.js', page('/assets/index-new.js')),
    ).toBe(true)
  })

  test('the same bundle is not', () => {
    expect(
      isNewBuild('/assets/index-old.js', page('/assets/index-old.js')),
    ).toBe(false)
  })

  test('a page without a bundle, such as an error page, is not', () => {
    expect(
      isNewBuild(
        '/assets/index-old.js',
        '<html><body>Bad gateway</body></html>',
      ),
    ).toBe(false)
  })
})
