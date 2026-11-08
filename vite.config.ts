import { defineConfig } from 'vite'

import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [tailwindcss(), foldkit()],
  server: {
    proxy: {
      '/api': { target: 'ws://127.0.0.1:8080', ws: true },
    },
  },
  optimizeDeps: {
    entries: ['src/entry.ts'],
  },
})
