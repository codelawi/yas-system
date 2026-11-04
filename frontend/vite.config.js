import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Production build goes into Laravel's public folder, so one server
// (the Laravel one) serves both the API and the dashboard.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? '/app/' : '/',
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
