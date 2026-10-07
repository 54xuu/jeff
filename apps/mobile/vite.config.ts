import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import legacy from '@vitejs/plugin-legacy'
import { transformLegacyGfm } from './build/legacy-gfm'
import { defineConfig } from 'vitest/config'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'jeff-mobile-crypto',
      enforce: 'pre',
      transform(code, id) {
        if (id.endsWith('/mdast-util-gfm-autolink-literal/lib/index.js')) {
          return { code: transformLegacyGfm(code), map: null }
        }
      },
      resolveId(source, importer) {
        if (source === './crypto-primitives.js' &&
            importer === path.resolve(root, '../../packages/core/src/remote/crypto.ts')) {
          return path.resolve(root, 'src/crypto-primitives.ts')
        }
      },
    },
    // Capacitor supports WebView 60+. Older Android devices need a classic
    // script fallback as well as syntax transforms and bundled API polyfills.
    legacy({ targets: ['Chrome >= 60'] }),
  ],
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test-setup.ts'],
  },
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
