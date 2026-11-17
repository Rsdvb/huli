import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { pageRuntime } from './tools/build/page-runtime'

export default defineConfig({
  plugins: [pageRuntime(resolve('src/shared/artifact-runtime/runtime.ts'))],
  resolve: {
    alias: [{ find: '@shared', replacement: resolve('src/shared') }],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'cloud/test/**/*.test.ts'],
    // A full run on Windows starts processes and writes files many times slower than on Linux,
    // so tests that write a few hundred files outlast the defaults there.
    ...(process.platform === 'win32' ? { testTimeout: 20_000, hookTimeout: 30_000 } : {}),
  },
})
