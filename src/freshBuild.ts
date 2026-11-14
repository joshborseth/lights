import { Effect, Option, Stream, pipe } from 'effect'

/*
 * The app is served over plain HTTP, so it gets no service worker. A phone
 * keeps a home-screen app's page alive in the background, so without this the
 * app would keep running the build it first loaded, even after a deploy, until
 * someone closed it for good. Each time the app comes back to the foreground,
 * it asks the server for the current page and reloads if the build changed.
 */

const MODULE_SCRIPT = 'script[type="module"][src]'

const moduleScriptIn = (root: ParentNode): Option.Option<string> =>
  pipe(
    Option.fromNullishOr(root.querySelector(MODULE_SCRIPT)),
    Option.flatMap(script => Option.fromNullishOr(script.getAttribute('src'))),
  )

/** The built page names its bundle by content hash, so a new src is a new build. */
export const isNewBuild = (loadedSrc: string, servedHtml: string): boolean =>
  Option.exists(
    moduleScriptIn(new DOMParser().parseFromString(servedHtml, 'text/html')),
    servedSrc => servedSrc !== loadedSrc,
  )

const servedPage = Effect.tryPromise(() =>
  fetch('/', { cache: 'no-store' }).then(response =>
    response.ok ? response.text() : Promise.reject(new Error('Not OK')),
  ),
)

const reloadIfNewBuild = (loadedSrc: string): Effect.Effect<void> =>
  servedPage.pipe(
    Effect.flatMap(html =>
      isNewBuild(loadedSrc, html)
        ? Effect.sync(() => window.location.reload())
        : Effect.void,
    ),
    Effect.ignore,
  )

export const reloadOnNewBuild = (): void => {
  Option.match(moduleScriptIn(document), {
    onNone: () => {},
    onSome: loadedSrc => {
      Effect.runFork(
        Stream.fromEventListener(document, 'visibilitychange').pipe(
          Stream.filter(() => document.visibilityState === 'visible'),
          Stream.runForEach(() => reloadIfNewBuild(loadedSrc)),
        ),
      )
    },
  })
}
