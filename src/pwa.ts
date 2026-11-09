import { Effect, Stream } from 'effect'

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
