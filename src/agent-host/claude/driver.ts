// Claude Code's driver: the Claude Agent SDK, loaded into the agent host from the folder Kettu
// installed it in, which runs one Claude Code process per open session.

import { lazyCode, type HostedDriver } from '../driver'
import type { LoadSdk } from './connection'
import { loadClaudeSdk } from './sdk'
import { restoreConfig } from './stored-config'

const code = lazyCode(() => import('./connection'))

/** The driver, loading the SDK with `load`; a test passes a fake SDK's. */
export function claudeSdkDriver(load: LoadSdk = loadClaudeSdk): HostedDriver {
  return {
    kind: 'hosted',
    reads: { limits: true, context: true },
    restoreConfig,
    load: code.load,
    connect: (context) => new (code.get().ClaudeConnection)(context, load),
  }
}

export const CLAUDE_SDK_DRIVER = claudeSdkDriver()
