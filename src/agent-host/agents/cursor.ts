import type { AgentDefinition } from '../catalog'

export const CURSOR: AgentDefinition = {
  id: 'cursor',
  name: 'Cursor',
  reportsAccount: true,
  registryId: 'cursor',
  launch: { kind: 'binary', command: 'cursor-agent', args: ['acp'] },
  install: {
    hint: 'detect.hint.cursor',
    url: 'https://cursor.com/docs/cli/acp',
  },
  // The registry ships Cursor only as a platform archive.
  installs: {
    archive: {},
  },
  // Huli: `cursor-agent`, its own UI, as its CLI reference starts it; no source ties the ids it
  // resumes to its ACP sessions', so none resumes there.
  terminal: { args: [] },
}
