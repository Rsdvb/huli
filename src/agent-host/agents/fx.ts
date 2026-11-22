import type { AgentDefinition } from '../catalog'

// Vercel Labs' fx (github.com/vercel-labs/fx, Apache-2.0) over ACP, as its docs (fx.sh/docs,
// Using fx › ACP) start it, checked on 2026-11-22: `fx acp`, on the provider `fx login` signed in
// to. It serves one session a connection, so each session runs a process of its own. It ships for
// macOS and Linux only; the JSON viewer also named `fx` is another program.
export const FX: AgentDefinition = {
  id: 'fx',
  limitsReason: 'model-provider-managed',
  name: 'fx',
  registryId: 'fx',
  launch: { kind: 'binary', command: 'fx', args: ['acp'], perSession: true },
  install: {
    hint: 'detect.hint.fx',
    url: 'https://fx.sh/docs/getting-started/installation',
  },
  // The routes its install page lists, checked on 2026-11-22; Homebrew's formula is `fx-agent`.
  installs: {
    script: 'https://fx.sh/setup.sh',
    scriptBin: ['.local', 'bin'],
    scriptHome: ['.local', 'bin'],
    brew: 'fx-agent',
    order: ['script', 'brew'],
  },
  // Huli: `fx`, its own UI, as its CLI reference starts it; no source ties the ids it resumes to
  // its ACP sessions', so none resumes there.
  terminal: { args: [] },
}
