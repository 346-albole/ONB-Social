import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
  },
  // En dev, le front (Vite) relaie /api vers l'API Node (même origine qu'en prod).
  server: {
    proxy: {
      '/api': { target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:3000', changeOrigin: true, ws: true },
    },
  },
  optimizeDeps: {
    exclude: ['@xenova/transformers'],
  },
  worker: {
    format: 'es',
  },
})
