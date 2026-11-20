// Huli: the entries agents keep in the system's credential store, which a reset checks for and
// removes by name: the Keychain through `security`, Credential Manager through `cmdkey`, the
// Secret Service through `secret-tool`. No value is ever read: `security` is not asked for the
// password, `cmdkey` prints none, and `secret-tool lookup`'s output is thrown away unread.

import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Platform } from '@shared/platform'
import type { SecretRef } from './plan'

export interface SecretStore {
  /** Whether the entry is there. */
  has(secret: SecretRef): Promise<boolean>
  /** Removes it, every part of a split one; resolves once none is left. */
  remove(secret: SecretRef): Promise<void>
}

/** How the entry reads in the list: the names the store shows it by. */
export function secretName(secret: SecretRef): string {
  switch (secret.store) {
    case 'keychain':
      return secret.account ? `${secret.service} (${secret.account})` : secret.service
    case 'credential-manager':
      return secret.target
    case 'secret-service':
      return Object.entries(secret.attributes)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ')
  }
}

interface Ran {
  code: number | null
  /** Only for a program asked to keep it, one that prints no secret. */
  stdout: string
}

/** `verbatim`: the arguments go on Windows' command line as they are, quotes and all. */
export type RunStore = (
  program: string,
  args: string[],
  keepOutput: boolean,
  verbatim?: boolean,
) => Promise<Ran>

const STORE_TIMEOUT_MS = 15_000

/** Runs a store's program without a shell; a missing program exits with null. */
export const runStore: RunStore = (program, args, keepOutput, verbatim = false) =>
  new Promise((resolve) => {
    let stdout = ''
    const child = spawn(program, args, {
      stdio: ['ignore', keepOutput ? 'pipe' : 'ignore', 'ignore'],
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      timeout: STORE_TIMEOUT_MS,
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString('latin1')
    })
    child.once('error', () => resolve({ code: null, stdout: '' }))
    child.once('close', (code) => resolve({ code, stdout }))
  })

/** The target names `cmdkey /list` prints, as `Target: LegacyGeneric:target=<name>` in any language. */
export function cmdkeyTargets(output: string): string[] {
  const targets: string[] = []
  for (const line of output.split(/\r?\n/)) {
    const found = /target=(.+?)\s*$/i.exec(line)
    if (found) targets.push(found[1]!)
  }
  return targets
}

function matches(secret: Extract<SecretRef, { store: 'credential-manager' }>, target: string) {
  const want = secret.target.toLowerCase()
  const have = target.toLowerCase()
  return have === want || (secret.parts === true && have.startsWith(`${want}#`))
}

const KEYCHAIN_NOT_FOUND = 44
// A split entry has a few parts; more than this many deletions means something else is wrong.
const MAX_DELETIONS = 64

/** The store of the system Kite runs on. */
export function systemSecretStore(
  platform: Platform,
  run: RunStore = runStore,
  env: Record<string, string | undefined> = process.env,
): SecretStore {
  const cmdkey = path.win32.join(
    env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows',
    'System32',
    'cmdkey.exe',
  )
  const security = '/usr/bin/security'
  const keychainArgs = (secret: Extract<SecretRef, { store: 'keychain' }>): string[] => [
    '-s',
    secret.service,
    ...(secret.account ? ['-a', secret.account] : []),
  ]
  const attributes = (secret: Extract<SecretRef, { store: 'secret-service' }>): string[] =>
    Object.entries(secret.attributes).flat()
  const credentials = async (): Promise<string[]> => {
    const ran = await run(cmdkey, ['/list'], true)
    if (ran.code !== 0) throw new Error('cmdkey could not list the credentials')
    return cmdkeyTargets(ran.stdout)
  }
  return {
    async has(secret) {
      if (secret.store === 'keychain') {
        if (platform !== 'darwin') return false
        const ran = await run(security, ['find-generic-password', ...keychainArgs(secret)], false)
        return ran.code === 0
      }
      if (secret.store === 'credential-manager') {
        if (platform !== 'win32') return false
        return (await credentials()).some((target) => matches(secret, target))
      }
      if (platform !== 'linux') return false
      const ran = await run('secret-tool', ['lookup', ...attributes(secret)], false)
      return ran.code === 0
    },
    async remove(secret) {
      if (secret.store === 'keychain') {
        for (let i = 0; i < MAX_DELETIONS; i++) {
          const ran = await run(
            security,
            ['delete-generic-password', ...keychainArgs(secret)],
            false,
          )
          if (ran.code === KEYCHAIN_NOT_FOUND) return
          if (ran.code !== 0) throw new Error(`security exited with ${ran.code}`)
        }
        throw new Error('the keychain kept the entry')
      }
      if (secret.store === 'credential-manager') {
        // cmdkey takes a name with spaces only quoted after the switch, and exits with 0 even when
        // it deleted nothing, so the list says whether it did.
        for (const target of (await credentials()).filter((t) => matches(secret, t))) {
          if (target.includes('"')) throw new Error(`cmdkey cannot name ${target}`)
          await run(cmdkey, [`/delete:"${target}"`], false, true)
        }
        if ((await credentials()).some((target) => matches(secret, target))) {
          throw new Error('Credential Manager kept the entry')
        }
        return
      }
      const ran = await run('secret-tool', ['clear', ...attributes(secret)], false)
      if (ran.code === null) throw new Error('secret-tool is not installed')
      if ((await run('secret-tool', ['lookup', ...attributes(secret)], false)).code === 0) {
        throw new Error('the Secret Service kept the entry')
      }
    },
  }
}

/**
 * A store of names in a file, for a copy of the app an agent runs to test a change, so its reset
 * reaches none of the owner's real entries: `{"entries": ["gemini:antigravity", ...]}`.
 */
export function recordedSecretStore(file: string): SecretStore {
  const read = async (): Promise<string[]> => {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { entries?: unknown }
      return Array.isArray(parsed.entries)
        ? parsed.entries.filter((entry): entry is string => typeof entry === 'string')
        : []
    } catch {
      return []
    }
  }
  const named = (secret: SecretRef, entry: string): boolean =>
    secret.store === 'credential-manager'
      ? matches(secret, entry)
      : entry === `${secret.store}:${secretName(secret)}`
  return {
    async has(secret) {
      return (await read()).some((entry) => named(secret, entry))
    },
    async remove(secret) {
      const entries = await read()
      await writeFile(
        file,
        JSON.stringify({ entries: entries.filter((entry) => !named(secret, entry)) }, null, 2),
      )
    },
  }
}
