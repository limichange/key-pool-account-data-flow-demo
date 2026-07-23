import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Pure-frontend build: the simulation engine (../server/src) is bundled into
// the page via the @kpa/sim alias, so there is no API server and no proxy —
// `vite build` emits static files deployable on any static host.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@kpa/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
      '@kpa/sim': fileURLToPath(new URL('../server/src', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    fs: { allow: ['..'] },
  },
})
