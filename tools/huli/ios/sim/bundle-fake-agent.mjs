// Bundles the fake agent into one plain JavaScript file for run.sh, so that the daemon starts it
// quickly. Run from its TypeScript, each start strips the types of its modules and resolves its
// packages' files anew, which on the loaded macOS runner, while the simulator and Maestro start,
// took longer than the 30 s the host gives an agent to answer `initialize`.
// Usage: node bundle-fake-agent.mjs <out dir>. Huli's own; see tools/huli/README.md.

import { build } from 'vite'

const out = process.argv[2]
if (!out) throw new Error('Usage: node bundle-fake-agent.mjs <out dir>')

await build({
  configFile: false,
  logLevel: 'warn',
  ssr: { noExternal: true },
  build: {
    ssr: 'tools/fake-agent/main.ts',
    outDir: out,
    emptyOutDir: true,
    minify: false,
    rolldownOptions: {
      external: [/^node:/],
      output: { format: 'esm', entryFileNames: 'fake-agent.mjs' },
    },
  },
})
