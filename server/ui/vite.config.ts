import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Single version source: the daemon package that ships this UI.
const { version } = JSON.parse(readFileSync(new URL('../daemon/package.json', import.meta.url), 'utf8'))

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  server: {
    proxy: {
      '/ui': { target: 'ws://localhost:9091', ws: true },
      '/api': 'http://localhost:9091',
    },
  },
})
