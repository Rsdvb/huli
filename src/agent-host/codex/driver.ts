// `codex app-server` over the stdio of the one process Kettu runs for Codex.

import type { Platform } from '@shared/platform'
import { lazyCode, type ProcessDriver } from '../driver'

const code = lazyCode(() => import('./connection'))

export const CODEX_DRIVER: ProcessDriver = {
  kind: 'process',
  reads: { limits: true, contextEstimates: true },
  load: code.load,
  connect: (transport, { hooks, spec, env }) =>
    new (code.get().CodexConnection)(
      transport,
      hooks,
      spec && env ? { spec, env, platform: process.platform as Platform } : null,
    ),
}
