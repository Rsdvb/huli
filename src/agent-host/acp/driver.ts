// ACP over the stdio of the agent's process: the driver of every agent that speaks ACP.

import { lazyCode, type ProcessDriver } from '../driver'

const code = lazyCode(() => import('./connection'))

export const ACP_DRIVER: ProcessDriver = {
  kind: 'process',
  load: code.load,
  connect: (transport, { def, hooks }) =>
    code.get().AcpConnection.connect(transport, {
      ...hooks,
      agentId: def.id,
      name: def.name,
      ...(def.movedAccounts ? { movedAccounts: def.movedAccounts } : {}),
    }),
}
