// Huli: the elevated helper's install as the host keeps it: installing waits on the setting while
// removing never does, readiness needs a current install and is kept while the installed files
// stay as they were, and how it stands is always the helper's answer.

import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ElevatedMode } from '@shared/computer-use'
import { ElevatedInstall } from './elevated-install'
import type { InstallState } from './helper'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kite-elevated-install-'))
  for (const name of ['kite-computer-helper.exe', 'cua-driver.exe', 'install.txt']) {
    await writeFile(path.join(dir, name), name)
  }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function fake(state: InstallState['state']) {
  const calls: string[] = []
  const helper = {
    state: { installDir: dir, state } as InstallState,
    next: null as InstallState | null,
    layout: async () => {
      calls.push('layout')
      return helper.state
    },
    install: async () => {
      calls.push('install')
      if (helper.next) helper.state = helper.next
      return helper.next
    },
    uninstall: async () => {
      calls.push('uninstall')
      helper.state = { installDir: dir, state: 'missing' }
      return helper.state
    },
  }
  return { helper, calls }
}

function install(helper: ReturnType<typeof fake>['helper'], mode: { value: ElevatedMode }) {
  return new ElevatedInstall({ helper, client: 'C:\\Kite\\Kite.exe', mode: () => mode.value })
}

describe('the elevated helper’s install', () => {
  it('installs only while the setting is on, and removes whatever it says', async () => {
    const { helper, calls } = fake('current')
    const mode = { value: 'off' as ElevatedMode }
    const kept = install(helper, mode)
    await expect(kept.install()).rejects.toThrow('Turn on administrator use')
    expect(calls).not.toContain('install')
    expect(await kept.uninstall()).toMatchObject({ state: 'missing' })
    mode.value = 'always'
    helper.next = { installDir: dir, state: 'tampered', exitCode: 8 }
    expect(await kept.install()).toEqual({ state: 'tampered', cancelled: false, exitCode: 8 })
  })

  it('counts as ready only while on and current, as the helper says each time it looks', async () => {
    const { helper } = fake('current')
    const mode = { value: 'off' as ElevatedMode }
    const kept = install(helper, mode)
    expect(await kept.ready()).toBe(false)
    mode.value = 'always'
    expect(await kept.ready()).toBe(true)
    // A copy that is not the recorded one reads tampered from the admin-only files themselves.
    helper.state = { installDir: dir, state: 'tampered' }
    expect(await kept.status()).toBe('tampered')
    expect(await kept.ready()).toBe(false)
  })

  it('keeps readiness while the installed files stay as they were, and looks again once one changes', async () => {
    const { helper, calls } = fake('current')
    const kept = install(helper, { value: 'always' })
    expect(await kept.ready()).toBe(true)
    expect(await kept.ready()).toBe(true)
    expect(calls).toEqual(['layout'])
    helper.state = { installDir: dir, state: 'tampered' }
    const later = new Date(Date.now() + 60_000)
    await utimes(path.join(dir, 'cua-driver.exe'), later, later)
    expect(await kept.ready()).toBe(false)
    expect(calls).toEqual(['layout', 'layout'])
    // An install or removal looks afresh.
    helper.next = { installDir: dir, state: 'current', exitCode: 0 }
    await kept.install()
    expect(await kept.ready()).toBe(true)
    expect(calls.at(-1)).toBe('layout')
  })
})
