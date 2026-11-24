// Pi's driver: its RPC mode, run in the agent host, which spawns one `pi --mode rpc` per open
// session.

import { lazyCode, type HostedDriver } from '../driver'

const code = lazyCode(() => import('./connection'))

export const PI_DRIVER: HostedDriver = {
  kind: 'hosted',
  load: code.load,
  connect: (context) => new (code.get().PiConnection)(context),
}
