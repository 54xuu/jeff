import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const coreSource = resolve(__dirname, '../../packages/core/src/index.ts')
// 渲染进程只用契约 + 纯工具（类型 + IPC 常量 + modelKey），避免把 node 依赖卷进浏览器 bundle
const coreBrowserSource = resolve(__dirname, '../../packages/core/src/browser.ts')

export default defineConfig({
  main: {
    // @jeff/core 从源码打包；其余依赖（含 better-sqlite3 原生模块）外置
    plugins: [externalizeDepsPlugin({ exclude: ['@jeff/core'] })],
    resolve: {
      alias: { '@jeff/core': coreSource },
    },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@jeff/core': coreBrowserSource,
        '@': resolve(__dirname, 'src/renderer/src'),
      },
    },
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
    },
  },
})
