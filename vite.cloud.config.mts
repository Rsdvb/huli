// Huli Cloud's build: one ES module for Node.js, cloud/dist/huli-cloud.mjs, with the shared
// protocol code and uqr bundled in, so the server needs nothing but Node.js itself.

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const source = (file: string): string => fileURLToPath(new URL(file, import.meta.url))

export default defineConfig({
  root: source('.'),
  resolve: { alias: { '@shared': source('src/shared') } },
  ssr: { noExternal: true },
  build: {
    ssr: true,
    target: 'node22',
    outDir: source('cloud/dist'),
    emptyOutDir: true,
    minify: false,
    rolldownOptions: {
      input: { 'huli-cloud': source('cloud/src/main.ts') },
      external: [/^node:/],
      output: { format: 'esm', entryFileNames: '[name].mjs' },
    },
  },
})
