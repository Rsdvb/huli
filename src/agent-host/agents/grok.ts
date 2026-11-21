import type { AgentDefinition } from '../catalog'

export const GROK: AgentDefinition = {
  id: 'grok',
  name: 'Grok',
  registryId: 'grok-build',
  reportsAccount: true,
  launch: {
    kind: 'package',
    package: '@xai-official/grok',
    args: ['agent', 'stdio'],
  },
  requiresNode: '>=20',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
  // Huli: `grok`, its own UI, as its CLI reference starts it; no source ties the ids it
  // resumes to its ACP sessions', so none resumes there.
  terminal: { args: [] },
}
