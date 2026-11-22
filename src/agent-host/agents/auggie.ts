import type { AgentDefinition } from '../catalog'

export const AUGGIE: AgentDefinition = {
  id: 'auggie',
  name: 'Auggie CLI',
  registryId: 'auggie',
  reportsAccount: true,
  launch: {
    kind: 'package',
    package: '@augmentcode/auggie',
    command: 'auggie',
    args: ['--acp'],
    // npm owns the installed version, so the CLI's own updater stays off.
    env: { AUGMENT_DISABLE_AUTO_UPDATE: '1' },
  },
  requiresNode: '>=20',
  install: {
    hint: 'detect.hint.node',
    url: 'https://nodejs.org/en/download',
    guide: 'https://docs.augmentcode.com/cli/setup-auggie/install-auggie-cli',
  },
  // Its install page documents only the `prerelease` tag, checked on 2026-11-21.
  installs: { npm: '@augmentcode/auggie', npmTag: 'prerelease' },
  // Huli: `auggie`, its own UI, as its CLI reference starts it; no source ties the ids it
  // resumes to its ACP sessions', so none resumes there.
  terminal: { args: [] },
}
