import { Effect, Fiber, Stream } from 'effect'
import { describe, expect, test } from 'vitest'

import { Message, streamPageScrollSettle, streamPageScrollStart } from './main'

const wait = (ms: number) =>
  new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })

const scroll = () => window.dispatchEvent(new Event('scroll'))

describe('page scroll streams', () => {
  test('the first scroll event reports that the page started moving', async () => {
    const fiber = Effect.runFork(Stream.runHead(streamPageScrollStart))
    await wait(0)
    scroll()
    const maybeMessage = await Effect.runPromise(Fiber.join(fiber))
    expect(maybeMessage._tag).toBe('Some')
    expect(maybeMessage).toMatchObject({
      value: Message.StartedPageScroll(),
    })
  })

  test('settles after a quiet period even with no further scrolling', async () => {
    const message = await Effect.runPromise(
      Stream.runHead(streamPageScrollSettle),
    )
    expect(message).toMatchObject({ value: Message.SettledPageScroll() })
  })

  test('keeps waiting while the page is still scrolling', async () => {
    const startedAt = performance.now()
    const fiber = Effect.runFork(Stream.runHead(streamPageScrollSettle))
    await wait(200)
    scroll()
    await wait(200)
    scroll()
    await Effect.runPromise(Fiber.join(fiber))
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(650)
  })
})
