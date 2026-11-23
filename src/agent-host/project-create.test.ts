// Huli: Add project's clone and new empty project on the host: the folders a paired device may
// name, the targets refused, and git run with only HTTPS and SSH, no helper, hook or submodule.

import { EventEmitter } from 'node:events'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import type { CloneProgress } from '@shared/project-create'
import { createExec } from './git/exec'
import { ProgressReader, ProjectCreate, type ProjectCreateDeps } from './project-create'
import type { ProcessControl } from './process-tree'

const PLATFORM = process.platform as Platform
const CLONE_ID = 'a'.repeat(32)
const WINDOW = { portId: 'w1', device: false }
const DEVICE = { portId: 'd1', device: true }

let root: string
let home: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'kite-new-project-')))
  home = path.join(root, 'home')
  await mkdir(home)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function there(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  )
}

class FakeChild extends EventEmitter {
  readonly stderr = new PassThrough()
  readonly pid = 4242
}

interface Spawned {
  file: string
  args: string[]
  options: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: unknown }
  child: FakeChild
}

function setup(over: { projects?: string[]; last?: string } = {}) {
  const added: string[] = []
  const progress: { portId: string; progress: CloneProgress }[] = []
  const spawned: Spawned[] = []
  const killed: number[] = []
  let last = over.last
  const control = {
    platform: PLATFORM,
    list: async () => [],
    kill: (target: number) => killed.push(target),
    taskkill: async (pids: number[]) => void killed.push(...pids),
  } as unknown as ProcessControl
  const deps: ProjectCreateDeps = {
    platform: PLATFORM,
    home,
    dataDir: path.join(root, 'data'),
    projects: {
      add: async (value) => {
        added.push(value)
        return { path: value, name: path.basename(value) } as Project
      },
      recentPaths: () => over.projects ?? [],
      lastNewProjectParent: () => last,
      setNewProjectParent: (value) => {
        last = value
      },
    },
    env: async () => ({ PATH: process.env.PATH, HTTPS_PROXY: 'http://127.0.0.1:7890' }),
    findGit: async () => '/usr/bin/git',
    exec: createExec(() => ({ ...process.env, GIT_CONFIG_NOSYSTEM: '1' })).exec,
    control,
    progress: (portId, item) => progress.push({ portId, progress: item }),
    log: () => {},
    spawn: ((file: string, args: string[], options: Spawned['options']) => {
      const child = new FakeChild()
      spawned.push({ file, args, options, child })
      return child
    }) as unknown as ProjectCreateDeps['spawn'],
  }
  return {
    service: new ProjectCreate(deps),
    added,
    progress,
    spawned,
    killed,
    last: () => last,
  }
}

/** Waits for the fake git to start, as the clone first checks the folders. */
async function started(spawned: Spawned[]): Promise<Spawned> {
  await vi.waitFor(() => expect(spawned.length).toBe(1))
  return spawned[0]!
}

describe('places', () => {
  it('lists the last folder, home and the projects’ folders, each once and only if there', async () => {
    const work = path.join(root, 'work')
    await mkdir(path.join(work, 'a'), { recursive: true })
    await mkdir(path.join(work, 'b'), { recursive: true })
    const { service } = setup({
      last: work,
      projects: [path.join(work, 'a'), path.join(work, 'b'), path.join(root, 'gone', 'c')],
    })
    expect(await service.places()).toEqual({
      places: [
        { path: work, kind: 'last' },
        { path: home, kind: 'home' },
      ],
      last: work,
    })
  })
})

describe('parentFor', () => {
  it('lets a device name only a folder the places list', async () => {
    const work = path.join(root, 'work')
    const elsewhere = path.join(root, 'elsewhere')
    await mkdir(path.join(work, 'a'), { recursive: true })
    await mkdir(elsewhere)
    const { service } = setup({ projects: [path.join(work, 'a')] })
    expect(await service.parentFor(work, DEVICE)).toBe(work)
    expect(await service.parentFor(home, DEVICE)).toBe(home)
    await expect(service.parentFor(elsewhere, DEVICE)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(service.parentFor(path.join(work, 'a'), DEVICE)).rejects.toMatchObject({
      code: 'forbidden',
    })
    await expect(
      service.parentFor(path.join(work, '..', 'elsewhere'), DEVICE),
    ).rejects.toMatchObject({ code: 'forbidden' })
    // A window names any folder, as it chose it in the system's dialog.
    expect(await service.parentFor(elsewhere, WINDOW)).toBe(elsewhere)
  })

  it('refuses a parent that is not a folder', async () => {
    const file = path.join(root, 'file.txt')
    await writeFile(file, 'x')
    const { service } = setup()
    await expect(service.parentFor(file, WINDOW)).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(service.parentFor(path.join(root, 'none'), WINDOW)).rejects.toMatchObject({
      code: 'invalid_params',
    })
    await expect(service.parentFor('relative/x', WINDOW)).rejects.toMatchObject({
      code: 'invalid_params',
    })
  })
})

describe('targetFor', () => {
  it('takes a new name or an empty folder', async () => {
    const { service } = setup()
    await mkdir(path.join(home, 'empty'))
    expect(await service.targetFor(home, 'new')).toEqual({
      parent: home,
      path: path.join(home, 'new'),
      existed: false,
    })
    expect(await service.targetFor(home, 'empty')).toMatchObject({ existed: true })
  })

  it('refuses a folder with files, a file, a link and a name that leaves the parent', async () => {
    const { service } = setup()
    await mkdir(path.join(home, 'full'))
    await writeFile(path.join(home, 'full', 'x'), 'x')
    await writeFile(path.join(home, 'file'), 'x')
    await mkdir(path.join(root, 'outside'))
    await symlink(path.join(root, 'outside'), path.join(home, 'link'), 'junction')
    await expect(service.targetFor(home, 'full')).rejects.toMatchObject({ code: 'conflict' })
    await expect(service.targetFor(home, 'file')).rejects.toMatchObject({ code: 'conflict' })
    await expect(service.targetFor(home, 'link')).rejects.toMatchObject({ code: 'conflict' })
    for (const name of ['..', '../outside', '..\\outside', 'a/b', '', 'con']) {
      await expect(service.targetFor(home, name), name).rejects.toMatchObject({
        code: 'invalid_params',
      })
    }
  })
})

describe('clone', () => {
  it('runs git with only HTTPS and SSH, no helper, hook or submodule, through the proxy', async () => {
    const { service, spawned, added, progress, last } = setup()
    const url = 'https://github.com/owner/repo.git'
    const done = service.clone({ cloneId: CLONE_ID, url, parent: home, name: 'repo' }, DEVICE)
    const run = await started(spawned)
    const target = path.join(home, 'repo')
    expect(run.file).toBe('/usr/bin/git')
    expect(run.args).toEqual([
      '-c',
      'protocol.ext.allow=never',
      '-c',
      `core.hooksPath=${path.join(root, 'data', 'no-hooks')}`,
      'clone',
      '--progress',
      '--no-recurse-submodules',
      '--',
      url,
      target,
    ])
    expect(run.options.cwd).toBe(home)
    expect(run.options.env).toMatchObject({
      GIT_ALLOW_PROTOCOL: 'https:ssh',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
    })
    run.child.stderr.write("Cloning into 'repo'...\n")
    run.child.stderr.write('Receiving objects:  50% (5/10)\r')
    run.child.stderr.write('Receiving objects: 100% (10/10), done.\n')
    run.child.emit('close', 0)
    await expect(done).resolves.toMatchObject({ path: target })
    expect(added).toEqual([target])
    expect(last()).toBe(home)
    expect(
      progress.map((item) => [item.portId, item.progress.phase, item.progress.percent]),
    ).toEqual([
      ['d1', 'connecting', null],
      ['d1', 'receiving', 50],
      ['d1', 'receiving', 100],
    ])
  })

  it('lets the computer’s own credential helper ask only a window’s user', async () => {
    const { service, spawned } = setup()
    const done = service.clone(
      { cloneId: CLONE_ID, url: 'git@github.com:o/r.git', parent: home, name: 'r' },
      WINDOW,
    )
    const run = await started(spawned)
    expect(run.options.env?.GCM_INTERACTIVE).toBe('auto')
    run.child.emit('close', 0)
    await done
  })

  it('refuses an address git could run a command from before anything runs', async () => {
    const { service, spawned } = setup()
    for (const url of ['ext::sh -c id', 'ext::id', '--upload-pack=id', 'file:///tmp/x', '/tmp/x']) {
      await expect(
        service.clone({ cloneId: CLONE_ID, url, parent: home, name: 'x' }, WINDOW),
        url,
      ).rejects.toMatchObject({ code: 'invalid_params' })
    }
    expect(spawned).toEqual([])
    expect(await readdir(home)).toEqual([])
  })

  it('shows git’s words without the sign-in, and removes what the clone left', async () => {
    const { service, spawned, added } = setup()
    const done = service.clone(
      { cloneId: CLONE_ID, url: 'https://ann@github.com/o/private.git', parent: home, name: 'p' },
      WINDOW,
    )
    const run = await started(spawned)
    await mkdir(path.join(home, 'p'))
    await writeFile(path.join(home, 'p', 'partial'), 'x')
    run.child.stderr.write('Receiving objects:  10% (1/10)\r')
    run.child.stderr.write(
      "remote: Repository not found.\nfatal: repository 'https://ann:tok@github.com/o/private.git/' not found\n",
    )
    run.child.emit('close', 128)
    const error = (await done.then(
      () => null,
      (caught: unknown) => caught,
    )) as Error & { code: string }
    expect(error).toMatchObject({ code: 'git_error' })
    expect(error.message).toContain(
      "fatal: repository 'https://github.com/o/private.git/' not found",
    )
    expect(error.message).not.toContain('tok')
    expect(error.message).not.toContain('ann')
    expect(error.message).not.toContain('Receiving')
    expect(await there(path.join(home, 'p'))).toBe(false)
    expect(added).toEqual([])
  })

  it('ends git’s process tree when cancelled and leaves an empty folder empty', async () => {
    const { service, spawned, killed, added } = setup()
    await mkdir(path.join(home, 'r'))
    const done = service.clone(
      { cloneId: CLONE_ID, url: 'https://host/r.git', parent: home, name: 'r' },
      WINDOW,
    )
    const run = await started(spawned)
    await writeFile(path.join(home, 'r', 'partial'), 'x')
    service.cancelClone(CLONE_ID)
    await vi.waitFor(() => expect(killed).toEqual([4242]))
    run.child.emit('close', null)
    await expect(done).rejects.toMatchObject({ code: 'conflict', data: { reason: 'cancelled' } })
    expect(await readdir(path.join(home, 'r'))).toEqual([])
    expect(added).toEqual([])
  })

  it('refuses a folder that is there and not empty, without running git', async () => {
    const { service, spawned } = setup()
    await mkdir(path.join(home, 'r'))
    await writeFile(path.join(home, 'r', 'keep'), 'x')
    await expect(
      service.clone(
        { cloneId: CLONE_ID, url: 'https://host/r.git', parent: home, name: 'r' },
        WINDOW,
      ),
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(spawned).toEqual([])
    expect(await readFile(path.join(home, 'r', 'keep'), 'utf8')).toBe('x')
  })
})

describe('create', () => {
  it('makes the folder with Git, a README and a .gitignore, and adds it', async () => {
    const { service, added, last } = setup()
    const project = await service.create(
      { parent: home, name: 'fresh', readme: true, gitignore: 'node' },
      WINDOW,
    )
    const target = path.join(home, 'fresh')
    expect(project.path).toBe(target)
    expect(added).toEqual([target])
    expect(last()).toBe(home)
    expect(await there(path.join(target, '.git'))).toBe(true)
    expect(await readFile(path.join(target, 'README.md'), 'utf8')).toBe('# fresh\n')
    expect(await readFile(path.join(target, '.gitignore'), 'utf8')).toContain('node_modules/')
  })

  it('makes only Git when nothing else is asked', async () => {
    const { service } = setup()
    await service.create({ parent: home, name: 'bare', readme: false, gitignore: null }, WINDOW)
    expect((await readdir(path.join(home, 'bare'))).sort()).toEqual(['.git'])
  })

  it('refuses a device’s folder outside the places', async () => {
    const elsewhere = path.join(root, 'elsewhere')
    await mkdir(elsewhere)
    const { service } = setup()
    await expect(
      service.create({ parent: elsewhere, name: 'x', readme: false, gitignore: null }, DEVICE),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(await readdir(elsewhere)).toEqual([])
  })
})

describe('ProgressReader', () => {
  it('sends each phase and at most one change per quarter second within one', () => {
    let now = 0
    const sent: CloneProgress[] = []
    const reader = new ProgressReader(
      CLONE_ID,
      (item) => sent.push(item),
      () => now,
    )
    reader.start()
    reader.read('remote: Counting objects:  10% (1/10)\r')
    now = 100
    reader.read('remote: Counting objects:  20% (2/10)\r')
    now = 400
    reader.read('remote: Counting objects:  30% (3/10)\rReceiving objects:   5% (1/20)\r')
    reader.read('Receiving objects: 100% (20/20), done.\nfatal: early EOF\n')
    expect(sent.map((item) => `${item.phase}:${item.percent}`)).toEqual([
      'connecting:null',
      'counting:10',
      'counting:30',
      'receiving:5',
      'receiving:100',
    ])
    expect(reader.message()).toBe('fatal: early EOF')
  })
})
