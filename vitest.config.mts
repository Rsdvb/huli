import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { pageRuntime } from './tools/build/page-runtime.ts'
import { sandboxShim } from './tools/build/sandbox-shim.ts'

export default defineConfig({
  plugins: [
    pageRuntime(resolve('src/shared/artifact-runtime/runtime.ts')),
    sandboxShim(resolve('src/renderer/src/web/sandbox-shim.ts')),
  ],
  resolve: {
    alias: [
      { find: '@shared', replacement: resolve('src/shared') },
      { find: '@renderer', replacement: resolve('src/renderer/src') },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'cloud/test/**/*.test.ts', 'tools/**/*.test.ts'],
    // A poll waits for a connection or a file that comes later under a loaded full run; its 1 s
    // default failed there now and then though the thing came.
    expect: { poll: { timeout: 5_000 } },
    // A full run on Windows starts processes and writes files many times slower than on Linux,
    // so tests that write a few hundred files outlast the defaults there.
    // Huli: there, a worker per core also starts hundreds of short processes in a burst that an
    // antivirus scans one by one, which stutters the owner's machine; a quarter of the cores keeps
    // a full run near its speed without that.
    ...(process.platform === 'win32'
      ? { testTimeout: 20_000, hookTimeout: 30_000, maxWorkers: '25%' }
      : {}),
  },
})
