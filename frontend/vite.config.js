import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const BASE = '/app/'

/**
 * Builds the service worker (src/sw.js) next to the app as sw.js, with the list of app
 * files it saves on the phone. Its version changes whenever a file does (the names carry
 * a hash), so phones pick up each new build.
 */
function serviceWorker() {
  return {
    name: 'repo-service-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(_, bundle) {
      const files = Object.keys(bundle)
        // .woff is only a fallback for very old browsers; every phone uses .woff2
        .filter((file) => file !== 'index.html' && !file.endsWith('.map') && !file.endsWith('.woff'))
        .sort()
      const assets = [...files, 'favicon.svg'].map((file) => BASE + file)
      const version = createHash('sha256').update(files.join('\n')).update(readFileSync('index.html')).digest('hex').slice(0, 12)
      const source = readFileSync('src/sw.js', 'utf8')
        .replace("'__VERSION__'", JSON.stringify(version))
        .replace('/* ASSETS */ []', JSON.stringify(assets))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

// Production build goes into Laravel's public folder, so one server
// (the Laravel one) serves both the API and the dashboard.
export default defineConfig(({ command }) => ({
  plugins: [react(), serviceWorker()],
  base: command === 'build' ? BASE : '/',
  build: {
    outDir: '../backend/public/app',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    host: true,
    proxy: {
      // Override with API_URL=http://127.0.0.1:8001 npm run dev if port 8000 is busy
      // xfwd passes the real device IP to Laravel (used by the Network page)
      '/api': { target: process.env.API_URL || 'http://127.0.0.1:8000', xfwd: true },
    },
  },
}))
