// Cline's driver for its SDK: a process of Kettu's own, one for all of the agent's sessions, loads
// the SDK from the installed `cline` package. An install without the SDK, or a runtime it does not
// load in, fails the start, and the agent then runs `cline --acp`.

import { lazyCode, type HostedDriver } from '../driver'

const code = lazyCode(() => import('./connection'))

export const CLINE_SDK_DRIVER: HostedDriver = {
  kind: 'hosted',
  load: code.load,
  connect: (context) => new (code.get().ClineConnection)(context),
}
