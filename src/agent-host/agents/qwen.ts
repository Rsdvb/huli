import type { AgentDefinition } from '../catalog'

export const QWEN: AgentDefinition = {
  id: 'qwen',
  limitsReason: 'harness-does-not-offer',
  name: 'Qwen Code',
  registryId: 'qwen-code',
  launch: { kind: 'package', package: '@qwen-code/qwen-code', args: ['--acp'] },
  requiresNode: '>=22',
  install: { hint: 'detect.hint.node', url: 'https://nodejs.org/en/download' },
  // Huli: `qwen`, and `--resume <id>`, which looks the id up where ACP's sessions are (0.28.3's
  // source, checked on 2026-11-21).
  terminal: { args: [], resume: (id) => ['--resume', id] },
}
