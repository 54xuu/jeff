import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@jeff/core/remote': path.resolve(root, '../../packages/core/src/remote/index.ts'),
      '@jeff/core': path.resolve(root, '../../packages/core/src/browser.ts'),
    },
  },
  server: {
    fs: { allow: [path.resolve(root, '../..')] },
  },
})
