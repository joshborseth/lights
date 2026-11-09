import { Effect, Option, Stream } from 'effect'

const isVisible = (): boolean => document.visibilityState === 'visible'

const checkForUpdateOnResume = (
  registration: ServiceWorkerRegistration,
): Effect.Effect<void> =>
  Stream.fromEventListener(document, 'visibilitychange').pipe(
    Stream.filter(isVisible),
    Stream.runForEach(() =>
      Effect.tryPromise(() => registration.update()).pipe(Effect.ignore),
    ),
  )

// NOTE: The first install also takes control of the page, and that page is
// already current. Only a page that already had a worker needs to reload.
const reloadOnceReplaced = (
  container: ServiceWorkerContainer,
): Effect.Effect<void> =>
  container.controller
    ? Stream.fromEventListener(container, 'controllerchange').pipe(
        Stream.take(1),
        Stream.runForEach(() => Effect.sync(() => window.location.reload())),
      )
    : Effect.void

const register = (container: ServiceWorkerContainer): Effect.Effect<void> =>
  Effect.tryPromise(() => container.register('/sw.js')).pipe(
    Effect.flatMap(checkForUpdateOnResume),
    Effect.ignore,
  )

export const startServiceWorker = (container: ServiceWorkerContainer): void => {
  Effect.runFork(
    Effect.all([reloadOnceReplaced(container), register(container)], {
      concurrency: 'unbounded',
      discard: true,
    }),
  )
}

type Size = Readonly<{ width: number; height: number }>

const APP_HEIGHT_PROPERTY = '--app-height'

// NOTE: An installed app fills the whole screen, unless iPad multitasking has
// put it in a narrower window. Screen size does not swap when the phone turns,
// so the viewport shape decides which side is the height.
export const installedAppHeight = (
  viewport: Size,
  screen: Size,
): Option.Option<number> => {
  const shortSide = Math.min(screen.width, screen.height)
  const longSide = Math.max(screen.width, screen.height)
  const isLandscape = viewport.width > viewport.height
  return viewport.width === (isLandscape ? longSide : shortSide)
    ? Option.some(isLandscape ? shortSide : longSide)
    : Option.none()
}

const applyInstalledAppHeight = (): void => {
  const { style } = document.documentElement
  Option.match(
    installedAppHeight(
      { width: window.innerWidth, height: window.innerHeight },
      window.screen,
    ),
    {
      onNone: () => style.removeProperty(APP_HEIGHT_PROPERTY),
      onSome: height => style.setProperty(APP_HEIGHT_PROPERTY, `${height}px`),
    },
  )
}

// NOTE: In an installed iPhone app, iOS reports a viewport one status bar too
// short, so full-height layout stops above the bottom of the screen.
export const startInstalledAppHeight = (): void => {
  if (!('standalone' in navigator) || navigator.standalone !== true) {
    return
  }
  applyInstalledAppHeight()
  Effect.runFork(
    Stream.fromEventListener(window, 'resize').pipe(
      Stream.runForEach(() => Effect.sync(applyInstalledAppHeight)),
    ),
  )
}
