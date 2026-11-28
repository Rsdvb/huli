import type { AgentDefinition } from '../catalog'

export const CURSOR: AgentDefinition = {
  id: 'cursor',
  name: 'Cursor',
  reportsAccount: true,
  registryId: 'cursor',
  // It reads a folder's own MCP servers and hooks only from its process's folder, the home folder,
  // and the flag keeps them off even so (read in 2026.11.13's bundle; global options go first).
  launch: { kind: 'binary', command: 'cursor-agent', args: ['--disable-project-configs', 'acp'] },
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
