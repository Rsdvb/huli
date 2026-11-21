import type { AgentDefinition } from '../catalog'

export const GLM: AgentDefinition = {
  id: 'glm',
  // Its Coding Plan quota comes from its own `_glm/usage` (vendor-usage/glm.ts), from 1.16.0.
  name: 'GLM Agent',
  registryId: 'glm-acp-agent',
  launch: { kind: 'package', package: 'glm-acp-agent' },
  // The package allows ^20.19, ^22.13 or >=24; detection reads one minimum.
  requiresNode: '>=20.19',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
}
