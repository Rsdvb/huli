import type { AgentDefinition } from '../catalog'

// Amazon's Kiro CLI over ACP, as its docs (kiro.dev/docs/cli/acp, the V3 migration guide) and the
// ACP Registry's entry start it, checked on 2026-11-22: `kiro-cli acp --agent-engine=v3`, which
// reads the sign-in `kiro-cli login` left; a signed-out start offers its terminal sign-in to a
// client that declares one, as Kettu does. Models, effort and its agents are session options.
export const KIRO: AgentDefinition = {
  id: 'kiro',
  limitsReason: 'not-yet-supported',
  name: 'Kiro CLI',
  registryId: 'kiro',
  launch: { kind: 'binary', command: 'kiro-cli', args: ['acp', '--agent-engine=v3'] },
  install: {
    hint: 'detect.hint.kiro',
    url: 'https://kiro.dev/docs/getting-started/installation/',
  },
  // The routes its install page lists for macOS and Linux, and the Registry's archives. The
  // Windows installer is a PowerShell script, which is not a route.
  installs: {
    script: 'https://cli.kiro.dev/install',
    scriptBin: ['.local', 'bin'],
    scriptHome: ['.local', 'bin'],
    brewCask: 'kiro-cli',
    archive: {},
    order: ['script', 'brew', 'archive'],
  },
  // Huli: `kiro-cli chat`, its own UI, as its CLI reference starts it; no source ties the ids it
  // resumes to its ACP sessions', so none resumes there.
  terminal: { args: ['chat'] },
}
