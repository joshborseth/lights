import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss(), foldkit()],
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
