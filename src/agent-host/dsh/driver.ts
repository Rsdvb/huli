// DeepSeek Harness's driver: its SDK interface, run in the agent host, which spawns one
// `dsh --profile sdk` per open session.

import { lazyCode, type HostedDriver } from '../driver'

const code = lazyCode(() => import('./connection'))

export const DSH_DRIVER: HostedDriver = {
  kind: 'hosted',
  load: code.load,
  connect: (context) => new (code.get().DshConnection)(context),
}
