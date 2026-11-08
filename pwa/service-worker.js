// The build replaces both placeholders. See serviceWorker() in vite.config.ts.
const CACHE_NAME = 'lights-__VERSION__'
const PRECACHE_URLS = __PRECACHE_URLS__
const NAVIGATION_TIMEOUT_MS = 3000

const precachedPaths = new Set(PRECACHE_URLS)

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(cache =>
        cache.addAll(
          PRECACHE_URLS.map(url => new Request(url, { cache: 'reload' })),
        ),
      )
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(names =>
        Promise.all(
          names
            .filter(name => name !== CACHE_NAME)
            .map(name => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

const rejectAfter = ms =>
  new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error('Timed out')), ms)
  })

// The live page wins, so a deploy shows up on the next launch. The cached copy
// opens the app when this device cannot reach the server.
const networkThenCachedShell = async request => {
  try {
    return await Promise.race([
      fetch(request),
      rejectAfter(NAVIGATION_TIMEOUT_MS),
    ])
  } catch (error) {
    const cache = await caches.open(CACHE_NAME)
    const shell = await cache.match('/')
    if (shell === undefined) {
      throw error
    }
    return shell
  }
}

const cacheThenNetwork = async request => {
  const cache = await caches.open(CACHE_NAME)
  return (await cache.match(request)) ?? fetch(request)
}

// Only the app's own files are handled. /api and /automations never reach the
// cache, and no light command is ever stored or replayed.
self.addEventListener('fetch', event => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return
  }
  if (request.mode === 'navigate') {
    event.respondWith(networkThenCachedShell(request))
  } else if (precachedPaths.has(url.pathname)) {
    event.respondWith(cacheThenNetwork(request))
  }
})
