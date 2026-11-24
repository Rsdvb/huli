// OpenCode's driver for its own server: it runs in the agent host, which starts one
// `opencode serve` for all of the agent's sessions.

import { lazyCode, type HostedDriver } from '../driver'

const code = lazyCode(() => import('./connection'))

export const OPENCODE_SERVER_DRIVER: HostedDriver = {
  kind: 'hosted',
  load: code.load,
  connect: (context) => new (code.get().OpenCodeConnection)(context),
}
