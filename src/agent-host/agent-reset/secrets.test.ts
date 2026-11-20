// The credential stores a reset clears: the commands it runs on each system, which never ask for
// a secret's value, and the names it finds in Credential Manager's list in any language.

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { tempFolder } from '../testing/temp'
import { cmdkeyTargets, recordedSecretStore, systemSecretStore, type RunStore } from './secrets'

const CMDKEY_EN = `
Currently stored credentials:

    Target: LegacyGeneric:target=gemini:antigravity
    Type: Generic
    User: antigravity
    Local machine persistence

    Target: LegacyGeneric:target=Claude Code-credentials/claude-code-user
    Type: Generic
    User: claude-code-user

    Target: LegacyGeneric:target=Claude Code-credentials/claude-code-user#0
    Type: Generic

    Target: LegacyGeneric:target=Claude Code-credentials-1a2b3c4d/claude-code-user
    Type: Generic

    Target: LegacyGeneric:target=cli|0011223344556677.Codex Auth
    Type: Generic
`

const CMDKEY_ZH =
  '\r\n当前保存的凭据:\r\n\r\n    目标: LegacyGeneric:target=gemini:antigravity\r\n    类型: 普通\r\n'

/** cmdkey as it behaves: it deletes a name quoted after its switch, and exits with 0 regardless. */
function recorder(output = CMDKEY_EN, stuck: string[] = []) {
  const calls: { program: string; args: string[]; keepOutput: boolean; verbatim?: boolean }[] = []
  let listed = output
  const run: RunStore = async (program, args, keepOutput, verbatim) => {
    calls.push({ program, args, keepOutput, verbatim })
    const quoted = /^\/delete:"(.*)"$/.exec(args[0] ?? '')
    if (quoted && verbatim && !stuck.includes(quoted[1]!)) {
      listed = listed
        .split('\n')
        .filter((line) => !line.endsWith(`target=${quoted[1]}`))
        .join('\n')
    }
    return { code: 0, stdout: keepOutput ? listed : '' }
  }
  return { run, calls }
}

describe('cmdkeyTargets', () => {
  it('reads the target names in English and in Chinese', () => {
    expect(cmdkeyTargets(CMDKEY_EN)).toEqual([
      'gemini:antigravity',
      'Claude Code-credentials/claude-code-user',
      'Claude Code-credentials/claude-code-user#0',
      'Claude Code-credentials-1a2b3c4d/claude-code-user',
      'cli|0011223344556677.Codex Auth',
    ])
    expect(cmdkeyTargets(CMDKEY_ZH)).toEqual(['gemini:antigravity'])
  })
})

describe('Credential Manager', () => {
  it('deletes the entry and its parts, and no other folder’s entry', async () => {
    const { run, calls } = recorder()
    const store = systemSecretStore('win32', run, { SystemRoot: 'C:\\Windows' })
    const secret = {
      store: 'credential-manager',
      target: 'Claude Code-credentials/claude-code-user',
      parts: true,
    } as const
    expect(await store.has(secret)).toBe(true)
    await store.remove(secret)
    const deleted = calls.filter((call) => call.args[0]?.startsWith('/delete:'))
    expect(deleted.map((call) => [call.args, call.verbatim])).toEqual([
      [['/delete:"Claude Code-credentials/claude-code-user"'], true],
      [['/delete:"Claude Code-credentials/claude-code-user#0"'], true],
    ])
    expect(calls.every((call) => call.program === 'C:\\Windows\\System32\\cmdkey.exe')).toBe(true)
    expect(
      await store.has({
        store: 'credential-manager',
        target: 'Claude Code-credentials-1a2b3c4d/claude-code-user',
      }),
    ).toBe(true)
  })

  it('reports an entry cmdkey did not delete, though it exited with 0', async () => {
    const { run } = recorder(CMDKEY_EN, ['gemini:antigravity'])
    const store = systemSecretStore('win32', run, {})
    await expect(
      store.remove({ store: 'credential-manager', target: 'gemini:antigravity' }),
    ).rejects.toThrow(/kept the entry/)
  })
})

describe('the Keychain and the Secret Service', () => {
  it('never asks security for a password, and deletes until none is left', async () => {
    const calls: string[][] = []
    let left = 2
    const run: RunStore = async (_program, args, keepOutput) => {
      calls.push(args)
      expect(keepOutput).toBe(false)
      if (args[0] === 'delete-generic-password') return { code: left-- > 0 ? 0 : 44, stdout: '' }
      return { code: 0, stdout: '' }
    }
    const store = systemSecretStore('darwin', run, {})
    const secret = { store: 'keychain', service: 'Claude Code-credentials' } as const
    expect(await store.has(secret)).toBe(true)
    await store.remove(secret)
    expect(calls[0]).toEqual(['find-generic-password', '-s', 'Claude Code-credentials'])
    expect(calls.slice(1)).toEqual(
      Array(3).fill(['delete-generic-password', '-s', 'Claude Code-credentials']),
    )
    expect(calls.flat()).not.toContain('-w')
    expect(calls.flat()).not.toContain('-g')
  })

  it('throws away what secret-tool prints', async () => {
    const calls: { args: string[]; keepOutput: boolean }[] = []
    let present = true
    const run: RunStore = async (_program, args, keepOutput) => {
      calls.push({ args, keepOutput })
      if (args[0] === 'clear') present = false
      return { code: args[0] === 'lookup' && !present ? 1 : 0, stdout: '' }
    }
    const store = systemSecretStore('linux', run, {})
    const secret = {
      store: 'secret-service',
      attributes: { service: 'gemini', username: 'antigravity' },
    } as const
    expect(await store.has(secret)).toBe(true)
    await store.remove(secret)
    expect(calls.map((call) => call.args)).toEqual([
      ['lookup', 'service', 'gemini', 'username', 'antigravity'],
      ['clear', 'service', 'gemini', 'username', 'antigravity'],
      ['lookup', 'service', 'gemini', 'username', 'antigravity'],
    ])
    expect(calls.every((call) => !call.keepOutput)).toBe(true)
  })

  it('asks no store of another system', async () => {
    const run: RunStore = async () => {
      throw new Error('ran')
    }
    expect(await systemSecretStore('linux', run, {}).has({ store: 'keychain', service: 'x' })).toBe(
      false,
    )
    expect(
      await systemSecretStore('darwin', run, {}).has({ store: 'credential-manager', target: 'x' }),
    ).toBe(false)
  })
})

describe('recordedSecretStore', () => {
  it('keeps names in its file, for a test copy of the app', async () => {
    const file = path.join(await tempFolder('kite-secrets-'), 'test-secrets.json')
    await writeFile(
      file,
      JSON.stringify({ entries: ['gemini:antigravity', 'keychain:Codex Auth'] }),
    )
    const store = recordedSecretStore(file)
    expect(await store.has({ store: 'credential-manager', target: 'gemini:antigravity' })).toBe(
      true,
    )
    expect(await store.has({ store: 'keychain', service: 'Codex Auth' })).toBe(true)
    await store.remove({ store: 'credential-manager', target: 'gemini:antigravity' })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ entries: ['keychain:Codex Auth'] })
  })
})
