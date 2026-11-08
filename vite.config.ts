import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

// Emits sw.js with the list of built files to cache, and a version that
// changes with their content so that phones pick up each deploy.
const serviceWorker = (): Plugin => ({
  name: 'lights-service-worker',
  apply: 'build',
  enforce: 'post',
  generateBundle(_options, bundle) {
    const files = Object.values(bundle)
    const version = files
      .reduce(
        (hash, file) =>
          hash.update(file.type === 'chunk' ? file.code : file.source),
        createHash('sha256'),
      )
      .digest('hex')
      .slice(0, 16)
    const urls = [
      '/',
      ...files
        .map(file => `/${file.fileName}`)
        .filter(url => url !== '/index.html'),
    ]
    const template = readFileSync(
      new URL('./pwa/service-worker.js', import.meta.url),
      'utf8',
    )
    this.emitFile({
      type: 'asset',
      fileName: 'sw.js',
      source: template
        .replace('__VERSION__', () => version)
        .replace('__PRECACHE_URLS__', () => JSON.stringify(urls)),
    })
  },
})

export default defineConfig({
  plugins: [tailwindcss(), foldkit(), serviceWorker()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    proxy: {
      '/api': { target: 'ws://127.0.0.1:8080', ws: true },
      '/automations': { target: 'http://127.0.0.1:8093' },
    },
  },
  optimizeDeps: {
    entries: ['src/entry.ts'],
  },
})
