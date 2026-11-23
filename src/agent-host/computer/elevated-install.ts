// Huli: the elevated helper's install in Program Files as the host keeps it: its state for Settings,
// the install (only while the user allows administrator use) and the removal (always), and whether
// administrator use may run at all, which needs an install that is current.
//
// An install whose copies did not land as staged is remembered as tampered in a file of the host's
// own (the installed record's helper hash), so it stays refused until it is removed or installed
// again, rather than reading current at the next look.

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElevatedHelperChange, ElevatedHelperState, ElevatedMode } from '@shared/computer-use'
import type { ComputerHelperLike, InstallState } from './helper'

export interface ElevatedInstallDeps {
  helper: Pick<ComputerHelperLike, 'layout' | 'install' | 'uninstall'> | null
  /** Kite's program, which the install records. */
  client: string
  /** The host's file that remembers a tampered install. */
  markFile: string
  /** The installed helper's path, looked at before the helper is asked while the setting is off. */
  installedHelper: string
  mode(): ElevatedMode
}

export class ElevatedInstall {
  constructor(private readonly deps: ElevatedInstallDeps) {}

  /**
   * How the install stands. With the setting off and nothing installed, the helper is not started
   * at all: only the installed program's place is looked at.
   */
  async status(): Promise<ElevatedHelperState> {
    const helper = this.deps.helper
    if (!helper) return 'unsupported'
    if (this.deps.mode() === 'off' && !(await exists(this.deps.installedHelper))) return 'missing'
    return this.marked(await helper.layout(this.deps.client))
  }

  /** Whether administrator use may run now: on, and installed, current and not remembered as tampered. */
  async ready(): Promise<boolean> {
    if (this.deps.mode() === 'off' || !this.deps.helper) return false
    try {
      return (await this.status()) === 'current'
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
    const result = await helper.install(this.deps.client)
    if (!result) return { state: await this.status(), cancelled: true }
    if (result.state === 'tampered' && result.helperSha256) await this.mark(result.helperSha256)
    else if (result.state === 'current') await this.unmark()
    return { state: await this.marked(result), cancelled: false, exitCode: result.exitCode ?? null }
  }

  /** Removal stays possible whatever the setting says. */
  async uninstall(): Promise<ElevatedHelperChange> {
    const helper = this.deps.helper
    if (!helper) return { state: 'unsupported', cancelled: false }
    const result = await helper.uninstall()
    if (!result) return { state: await this.status(), cancelled: true }
    if (result.state === 'missing') await this.unmark()
    return { state: result.state, cancelled: false, exitCode: result.exitCode ?? null }
  }

  /** A current install the host remembers as tampered stays tampered. */
  private async marked(state: InstallState): Promise<ElevatedHelperState> {
    if (state.state !== 'current') return state.state
    const held = await this.read()
    return held !== null && held === state.helperSha256 ? 'tampered' : 'current'
  }

  private async read(): Promise<string | null> {
    try {
      const data = JSON.parse(await readFile(this.deps.markFile, 'utf8')) as { tampered?: unknown }
      return typeof data.tampered === 'string' ? data.tampered : null
    } catch {
      return null
    }
  }

  private async mark(helperSha256: string): Promise<void> {
    await mkdir(path.dirname(this.deps.markFile), { recursive: true })
    await writeFile(this.deps.markFile, JSON.stringify({ tampered: helperSha256 }))
  }

  private async unmark(): Promise<void> {
    await rm(this.deps.markFile, { force: true })
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}
