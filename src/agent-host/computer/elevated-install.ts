// Huli: the elevated helper's install in Program Files as the host keeps it: its state for Settings,
// the install (only while the user allows administrator use) and the removal (always), and whether
// administrator use may run at all, which needs an install that is current.
//
// How it stands comes from the helper alone, which reads the system's own Program Files folder and
// checks the installed files against the record the elevated command wrote, both in a folder only
// administrators write: a copy that did not land as staged reads tampered there for as long as it
// is there. Hashing the 33 MB driver on every call would be slow, so readiness is kept while the
// installed files' sizes and times stay the same.

import { stat } from 'node:fs/promises'
import path from 'node:path'
import type { ElevatedHelperChange, ElevatedHelperState, ElevatedMode } from '@shared/computer-use'
import type { ComputerHelperLike, InstallState } from './helper'

/** The installed files whose sizes and times a kept state stands on. */
const WATCHED = ['kite-computer-helper.exe', 'cua-driver.exe', 'install.txt']

export interface ElevatedInstallDeps {
  helper: Pick<ComputerHelperLike, 'layout' | 'install' | 'uninstall'> | null
  /** Kite's program, which the install records. */
  client: string
  mode(): ElevatedMode
}

interface Kept {
  installDir: string
  state: InstallState['state']
  stamp: string
}

export class ElevatedInstall {
  private kept: Kept | null = null

  constructor(private readonly deps: ElevatedInstallDeps) {}

  /** How the install stands, asked of the helper afresh. */
  async status(): Promise<ElevatedHelperState> {
    const helper = this.deps.helper
    if (!helper) return 'unsupported'
    return this.look(helper)
  }

  /** Whether administrator use may run now: on, and the install current. */
  async ready(): Promise<boolean> {
    const helper = this.deps.helper
    if (this.deps.mode() === 'off' || !helper) return false
    try {
      const kept = this.kept
      if (kept && (await stamp(kept.installDir)) === kept.stamp) return kept.state === 'current'
      return (await this.look(helper)) === 'current'
    } catch {
      return false
    }
  }

  async install(): Promise<ElevatedHelperChange> {
    const helper = this.deps.helper
    if (!helper) return { state: 'unsupported', cancelled: false }
    if (this.deps.mode() === 'off') {
      throw new Error('Turn on administrator use in Settings before installing its helper.')
    }
    this.kept = null
    const result = await helper.install(this.deps.client)
    if (!result) return { state: await this.status(), cancelled: true }
    return { state: result.state, cancelled: false, exitCode: result.exitCode ?? null }
  }

  /** Removal stays possible whatever the setting says. */
  async uninstall(): Promise<ElevatedHelperChange> {
    const helper = this.deps.helper
    if (!helper) return { state: 'unsupported', cancelled: false }
    this.kept = null
    const result = await helper.uninstall()
    if (!result) return { state: await this.status(), cancelled: true }
    return { state: result.state, cancelled: false, exitCode: result.exitCode ?? null }
  }

  private async look(helper: Pick<ComputerHelperLike, 'layout'>): Promise<InstallState['state']> {
    const answer = await helper.layout(this.deps.client)
    this.kept = {
      installDir: answer.installDir,
      state: answer.state,
      stamp: await stamp(answer.installDir),
    }
    return answer.state
  }
}

/** The installed files' sizes and times, as one text; missing files count as such. */
async function stamp(installDir: string): Promise<string> {
  const parts = await Promise.all(
    WATCHED.map(async (name) => {
      try {
        const info = await stat(path.join(installDir, name))
        return `${info.size}:${info.mtimeMs}`
      } catch {
        return '-'
      }
    }),
  )
  return parts.join('|')
}
