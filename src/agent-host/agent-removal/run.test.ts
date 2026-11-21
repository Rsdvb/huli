// A removal against a fake home and a fake npm prefix on this computer: the plan lists what is
// there with sizes, a run takes only the steps asked for by id and still in the plan, each path is
// checked again as it goes, what is kept stays byte for byte, and npm gets its words intact.

import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { removalStepId } from '@shared/agent-removal'
import type { Platform } from '@shared/platform'
import { runProgram } from '../adapter-install'
import type { SecretRef } from '../agent-reset/plan'
import type { SecretStore } from '../agent-reset/secrets'
import { CLAUDE_CODE, PI } from '../catalog'
import { tempFolder } from '../testing/temp'
import { npmUninstall } from './commands'
import { prepareRemoval, runRemoval, type RemovalFacts } from './removal'

const platform: Platform = process.platform === 'win32' ? 'win32' : 'linux'

async function put(file: string, text = 'x'): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
}

async function exists(target: string): Promise<boolean> {
  return (await stat(target).catch(() => null)) !== null
}

function memorySecrets(names: string[]): SecretStore & { names: string[] } {
  const key = (secret: SecretRef): string =>
    secret.store === 'credential-manager'
      ? secret.target
      : secret.store === 'keychain'
        ? secret.service
        : JSON.stringify(secret.attributes)
  const store = {
    names,
    has: async (secret: SecretRef) => store.names.includes(key(secret)),
    remove: async (secret: SecretRef) => {
      store.names = store.names.filter((name) => name !== key(secret))
    },
  }
  return store
}

/** A Claude Code native install, its SDK in Kite's harnesses and its data, in a fake home. */
async function claudeHome(): Promise<{ home: string; facts: RemovalFacts; program: string }> {
  const home = await tempFolder('kite-removal-')
  const kiteRoot = path.join(home, '.huli', 'harnesses')
  const program =
    platform === 'win32'
      ? path.join(home, '.local', 'bin', 'claude.exe')
      : path.join(home, '.local', 'share', 'claude', 'versions', '2.1.330')
  await put(program, 'binary')
  if (platform === 'win32') await put(path.join(home, '.local', 'share', 'claude', 'versions', 'v'))
  await put(path.join(kiteRoot, 'claude-code', '0.3.330', 'installed.json'), '{}')
  await put(path.join(home, '.claude', 'projects', '-work', 's1.jsonl'), 'history')
  await put(path.join(home, '.claude', 'settings.json'), '{}')
  await put(path.join(home, '.claude', '.device-keys.json'), 'keys')
  await put(path.join(home, '.claude.json'), '{"userID":"u"}')
  await put(path.join(home, '.claude.json.backup'), '{}')
  await put(path.join(home, 'project', 'keep.txt'), 'mine')
  await put(path.join(home, '.codex', 'auth.json'), 'other agent')
  const facts: RemovalFacts = {
    program: {
      harness: 'claude-code',
      launch: CLAUDE_CODE.launch,
      installs: CLAUDE_CODE.installs!,
      platform,
      home,
      env: {},
      kiteRoot,
      program,
      launcher: program,
      tools: { npm: null, brew: null, winget: null, uv: null },
      others: [],
    },
    data: {
      harness: 'claude-code',
      platform,
      home,
      getEnv: () => undefined,
      chosen: null,
      picked: false,
      others: [],
    },
    protect: [home, kiteRoot],
    otherFolders: [path.join(home, '.codex')],
  }
  return { home, facts, program }
}

const ids = (steps: { id: string }[]): string[] => steps.map((step) => step.id)

describe('agent removal on disk', () => {
  it('lists what is there with sizes, and nothing that is not', async () => {
    const { home, facts } = await claudeHome()
    const secrets = memorySecrets([])
    const { preview } = await prepareRemoval(facts, { secrets, log: () => {} })
    const program = preview.program.steps
    expect(program.at(-1)).toMatchObject({
      kind: 'folder',
      path: path.join(home, '.huli', 'harnesses', 'claude-code'),
      kite: true,
      bytes: 2,
    })
    expect(preview.data.steps.map((step) => [step.kind, step.path])).toEqual([
      ['folder', path.join(home, '.claude')],
      ['file', path.join(home, '.claude.json')],
      ['file', path.join(home, '.claude.json.backup')],
    ])
    expect(preview.data.steps[0]?.bytes).toBe('history'.length + 2 + 'keys'.length)
  })

  it('takes only the steps asked for, and keeps everything else byte for byte', async () => {
    const { home, facts } = await claudeHome()
    const prepared = await prepareRemoval(facts, { secrets: memorySecrets([]), log: () => {} })
    const progress: string[] = []
    const result = await runRemoval(prepared, ids(prepared.preview.program.steps), {
      secrets: memorySecrets([]),
      trash: null,
      run: async () => 'not asked',
      progress: (step, state) => progress.push(`${state} ${step.kind}`),
      log: () => {},
    })
    expect(result.failed).toEqual([])
    expect(result.skipped).toEqual([])
    expect(await exists(path.join(home, '.local', 'share', 'claude'))).toBe(false)
    expect(await exists(path.join(home, '.huli', 'harnesses', 'claude-code'))).toBe(false)
    expect(await exists(path.join(home, '.huli', 'harnesses'))).toBe(true)
    expect(
      await readFile(path.join(home, '.claude', 'projects', '-work', 's1.jsonl'), 'utf8'),
    ).toBe('history')
    expect(await readFile(path.join(home, 'project', 'keep.txt'), 'utf8')).toBe('mine')
    expect(progress[0]).toMatch(/^running /)
    expect(progress.filter((line) => line.startsWith('done '))).toHaveLength(result.done.length)
  })

  it('runs no step it does not plan itself, whatever id it is sent', async () => {
    const { home, facts } = await claudeHome()
    const prepared = await prepareRemoval(facts, { secrets: memorySecrets([]), log: () => {} })
    const forged = [
      removalStepId('data', 'folder', path.join(home, 'project')),
      removalStepId('data', 'folder', home),
      removalStepId('program', 'command', 'rm -rf ~'),
    ]
    const result = await runRemoval(prepared, forged, {
      secrets: memorySecrets([]),
      trash: null,
      run: async () => {
        throw new Error('ran a command')
      },
      progress: () => {},
      log: () => {},
    })
    expect(result).toEqual({ done: [], failed: [], skipped: forged })
    expect(await exists(path.join(home, 'project', 'keep.txt'))).toBe(true)
  })

  it('keeps what other Claude agents share, and moves the rest to the trash when asked', async () => {
    const { home, facts } = await claudeHome()
    facts.data = { ...facts.data, others: ['Claude (work)'] }
    // Windows keeps the sign-in in Credential Manager; Linux has no entry of Claude Code's.
    const secrets = memorySecrets(
      platform === 'win32' ? ['Claude Code-credentials/claude-code-user'] : [],
    )
    const prepared = await prepareRemoval(facts, { secrets, log: () => {} })
    const trashed: string[] = []
    const result = await runRemoval(prepared, ids(prepared.preview.data.steps), {
      secrets,
      trash: async (paths) => {
        trashed.push(...paths)
      },
      run: async () => null,
      progress: () => {},
      log: () => {},
    })
    expect(result.failed).toEqual([])
    expect(trashed.sort()).toEqual(
      [
        path.join(home, '.claude', 'projects'),
        path.join(home, '.claude', 'settings.json'),
        path.join(home, '.claude.json'),
        path.join(home, '.claude.json.backup'),
      ].sort(),
    )
    expect(trashed).not.toContain(path.join(home, '.claude', '.device-keys.json'))
    expect(secrets.names).toEqual([])
    expect(prepared.preview.data.kept).toEqual([
      { path: path.join(home, '.claude', '.device-keys.json'), reason: 'agents' },
    ])
  })

  it('reports each failure with its step and goes on with the rest', async () => {
    const { home, facts } = await claudeHome()
    const prefix = path.join(home, 'npm prefix')
    const pkg = path.join(
      prefix,
      ...(platform === 'win32' ? [] : ['lib']),
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
    )
    await put(path.join(pkg, 'dist', 'cli.js'), 'cli')
    facts.program = {
      ...facts.program,
      harness: 'pi',
      launch: PI.launch,
      installs: PI.installs!,
      program: path.join(pkg, 'dist', 'cli.js'),
      launcher: null,
      tools: { npm: path.join(home, 'npm'), brew: null, winget: null, uv: null },
      kiteRoot: path.join(home, '.huli', 'harnesses'),
    }
    facts.data = { ...facts.data, harness: 'pi' }
    await put(path.join(home, '.pi', 'agent', 'auth.json'), '{}')
    const prepared = await prepareRemoval(facts, { secrets: memorySecrets([]), log: () => {} })
    expect(prepared.preview.program.method).toBe('npm')
    const result = await runRemoval(
      prepared,
      ids([...prepared.preview.program.steps, ...prepared.preview.data.steps]),
      {
        secrets: memorySecrets([]),
        trash: null,
        run: async () => 'npm exited with code 1.',
        progress: () => {},
        log: () => {},
      },
    )
    expect(result.failed.map(({ step, error }) => [step.kind, error])).toEqual([
      ['command', 'npm exited with code 1.'],
    ])
    expect(result.done.map((step) => step.path)).toEqual([path.join(home, '.pi', 'agent')])
    // The now-empty ~/.pi goes with it; what npm was to remove stays.
    expect(await exists(path.join(home, '.pi'))).toBe(false)
    expect(await exists(pkg)).toBe(true)
  })

  it('hands npm its words intact, spaces and all, through cmd.exe on Windows', async () => {
    const root = await tempFolder('kite-fake-npm-')
    const prefix = path.join(root, 'Jane Doe & co', 'npm (global)')
    const record = path.join(root, 'args.json')
    const script = path.join(root, 'fake-npm.js')
    await writeFile(
      script,
      `require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)))\n`,
    )
    let npm: string
    if (platform === 'win32') {
      npm = path.join(root, 'npm.cmd')
      await writeFile(npm, `@"${process.execPath}" "%~dp0fake-npm.js" %*\r\n`)
    } else {
      npm = path.join(root, 'npm')
      await writeFile(npm, `#!${process.execPath}\n${await readFile(script, 'utf8')}`)
      await chmod(npm, 0o755)
    }
    const command = npmUninstall('@earendil-works/pi-coding-agent', prefix, npm, platform)
    expect(command?.run).not.toBeNull()
    const run = await runProgram({
      program: command!.run!.program,
      args: command!.run!.args,
      cwd: root,
      env: process.env,
      platform,
      timeoutMs: 30_000,
    })
    expect(run.code).toBe(0)
    expect(JSON.parse(await readFile(record, 'utf8'))).toEqual(command!.run!.args)
    expect(await readdir(root)).not.toContain('co')
  })
})
