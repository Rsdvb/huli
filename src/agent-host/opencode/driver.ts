// OpenCode's driver for its own server: it runs in the agent host, which starts one
// `opencode serve` for the agent's sessions, and a second for those in folders whose own settings
// the user let apply.

import { lazyCode, type HostedDriver } from '../driver'

const code = lazyCode(() => import('./folders'))

export const OPENCODE_SERVER_DRIVER: HostedDriver = {
  kind: 'hosted',
  load: code.load,
  connect: (context) => new (code.get().OpenCodeFolders)(context),
}
