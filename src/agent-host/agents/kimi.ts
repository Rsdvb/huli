import type { AgentDefinition } from '../catalog'

export const KIMI: AgentDefinition = {
  id: 'kimi',
  name: 'Kimi Code',
  registryId: 'kimi-code',
  launch: { kind: 'package', package: '@moonshot-ai/kimi-code', args: ['acp'] },
  requiresNode: '>=22.19.0',
  install: {
    hint: 'detect.hint.kimi',
    url: 'https://github.com/MoonshotAI/kimi-code',
  },
  installs: { npm: '@moonshot-ai/kimi-code' },
  // Huli: `kimi`, its own UI, as its CLI reference starts it; no source ties the ids it
  // resumes to its ACP sessions', so none resumes there.
  terminal: { args: [] },
}
