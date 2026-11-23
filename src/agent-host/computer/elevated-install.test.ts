// Huli: the elevated helper's install as the host keeps it: an install that did not land as staged
// stays refused, installing waits on the setting while removing never does, and with the setting
// off nothing starts the helper unless something is installed.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ElevatedMode } from '@shared/computer-use'
import { ElevatedInstall } from './elevated-install'
import type { InstallState } from './helper'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kite-elevated-install-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function fake(initial: InstallState) {
  const calls: string[] = []
  const helper = {
    state: initial,
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
      helper.state = { installDir: 'C:\\x', state: 'missing' }
      return helper.state
    },
  }
  return { helper, calls }
}

function install(helper: ReturnType<typeof fake>['helper'], mode: { value: ElevatedMode }) {
  return new ElevatedInstall({
    helper,
    client: 'C:\\Kite\\Kite.exe',
    markFile: path.join(dir, 'computer-helper.json'),
    installedHelper: path.join(dir, 'kite-computer-helper.exe'),
    mode: () => mode.value,
  })
}

const current = (sha: string): InstallState => ({
  installDir: 'C:\\x',
  state: 'current',
  helperSha256: sha,
})

describe('the elevated helper’s install', () => {
  it('keeps an install that did not land as staged refused until it is installed again', async () => {
    const { helper } = fake({ installDir: 'C:\\x', state: 'missing' })
    const mode = { value: 'always' as ElevatedMode }
    const kept = install(helper, mode)
    helper.next = { installDir: 'C:\\x', state: 'tampered', helperSha256: 'aa', exitCode: 0 }
    expect(await kept.install()).toMatchObject({ state: 'tampered' })
    // On disk the forged record matches its files, so the helper alone would call it current.
    helper.state = current('aa')
    expect(await kept.status()).toBe('tampered')
    expect(await kept.ready()).toBe(false)
    // A fresh host reads the same.
    expect(await install(helper, mode).status()).toBe('tampered')
    // Installed again as staged, it is current.
    helper.next = current('aa')
    expect(await kept.install()).toMatchObject({ state: 'current' })
    expect(await kept.ready()).toBe(true)
  })

  it('forgets a tampered install once it is removed', async () => {
    const { helper } = fake({ installDir: 'C:\\x', state: 'missing' })
    const mode = { value: 'always' as ElevatedMode }
    const kept = install(helper, mode)
    helper.next = { installDir: 'C:\\x', state: 'tampered', helperSha256: 'bb', exitCode: 0 }
    await kept.install()
    expect(await kept.uninstall()).toMatchObject({ state: 'missing' })
    helper.state = current('bb')
    expect(await kept.status()).toBe('current')
  })

  it('installs only while the setting is on, and removes whatever it says', async () => {
    const { helper, calls } = fake(current('cc'))
    const mode = { value: 'off' as ElevatedMode }
    await writeFile(path.join(dir, 'kite-computer-helper.exe'), 'x')
    const kept = install(helper, mode)
    await expect(kept.install()).rejects.toThrow('Turn on administrator use')
    expect(calls).not.toContain('install')
    expect(await kept.uninstall()).toMatchObject({ state: 'missing' })
  })

  it('counts as ready only while on and current', async () => {
    const { helper } = fake(current('dd'))
    const mode = { value: 'off' as ElevatedMode }
    await writeFile(path.join(dir, 'kite-computer-helper.exe'), 'x')
    const kept = install(helper, mode)
    expect(await kept.ready()).toBe(false)
    mode.value = 'always'
    expect(await kept.ready()).toBe(true)
    helper.state = { installDir: 'C:\\x', state: 'outdated', helperSha256: 'dd' }
    expect(await kept.ready()).toBe(false)
  })

  it('with the setting off and nothing installed, starts no helper to tell', async () => {
    const { helper, calls } = fake({ installDir: 'C:\\x', state: 'missing' })
    const kept = install(helper, { value: 'off' })
    expect(await kept.status()).toBe('missing')
    expect(calls).toEqual([])
    // Something there: it asks, so Settings can offer to remove it.
    await writeFile(path.join(dir, 'kite-computer-helper.exe'), 'x')
    helper.state = current('ee')
    expect(await kept.status()).toBe('current')
    expect(calls).toEqual(['layout'])
  })
})
