import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import type { Env } from '../find-command'
import {
  chooseNode,
  EnvironmentService,
  withNodeBin,
  type ManagedNode,
  type NodeProbe,
} from '../shell-env'
import { createValidators } from '../validate'

const KITE_BIN = '/data/runtimes/node/v26.14.0/bin'
const managed: ManagedNode = { version: 'v26.14.0', binDir: KITE_BIN }
const NONE: NodeProbe = { nodePath: null, nodeVersion: null, npmPath: null }

/** A computer whose own node is `system`, or none, and where Kite's runs once first on PATH. */
function service(system: NodeProbe) {
  const env = new EnvironmentService({
    platform: 'linux',
    nodeRuntime: { command: 'node', env: {} },
    baseEnv: {},
    resolve: async () => ({
      env: { PATH: '/usr/local/bin:/usr/bin', HOME: '/home/me' },
      source: 'login-shell',
      shell: '/bin/zsh',
      durationMs: 1,
      warning: null,
    }),
    probe: async (probed: Env) =>
      probed.PATH?.split(':')[0] === KITE_BIN
        ? {
            nodePath: path.posix.join(KITE_BIN, 'node'),
            nodeVersion: 'v26.14.0',
            npmPath: path.posix.join(KITE_BIN, 'npm'),
          }
        : system,
  })
  return env
}

const v22: NodeProbe = {
  nodePath: '/usr/bin/node',
  nodeVersion: 'v22.21.1',
  npmPath: '/usr/bin/npm',
}
const v26: NodeProbe = {
  nodePath: '/usr/bin/node',
  nodeVersion: 'v26.1.0',
  npmPath: '/usr/bin/npm',
}

describe('the Node.js agents run on', () => {
  it('stays the user’s own while it meets what agents need, unless Kite’s is chosen', () => {
    expect(chooseNode(v26, true, 'auto', '>=24.9.0')).toBe('system')
    expect(chooseNode(v26, true, 'kite', '>=24.9.0')).toBe('kite')
    expect(chooseNode(v22, true, 'auto', '>=24.9.0')).toBe('kite')
    expect(chooseNode(NONE, true, 'auto', '>=24.9.0')).toBe('kite')
    // Without Kite's own, the user's runs whatever its version, and detection says it is old.
    expect(chooseNode(v22, false, 'kite', '>=24.9.0')).toBe('system')
    expect(chooseNode(NONE, false, 'auto', '>=24.9.0')).toBeNull()
    expect(chooseNode({ ...v26, nodeVersion: null }, true, 'auto', null)).toBe('kite')
  })

  it('gives agents the user’s PATH untouched while their own node runs', async () => {
    const env = service(v26)
    await env.setNodeSetup({ managed, choice: 'auto', required: '>=24.9.0' })
    await env.ready()
    expect(env.agentEnv('codex').PATH).toBe('/usr/local/bin:/usr/bin')
    expect(env.agentEnv().PATH).toBe('/usr/local/bin:/usr/bin')
    expect(env.nodeProbe()).toEqual(v26)
    expect(env.info().node).toMatchObject({
      using: 'system',
      system: { path: '/usr/bin/node', version: 'v26.1.0', suitable: true },
      kite: { version: 'v26.14.0' },
    })
  })

  it('puts Kite’s node first on PATH when the user has none, and finds it there', async () => {
    const env = service(NONE)
    await env.ready()
    expect(env.info().node?.using).toBeNull()
    await env.setNodeSetup({ managed, required: '>=24.9.0' })
    expect(env.agentEnv('claude-code').PATH).toBe(`${KITE_BIN}:/usr/local/bin:/usr/bin`)
    expect(env.nodeProbe().nodePath).toBe(`${KITE_BIN}/node`)
    expect(env.info()).toMatchObject({
      nodeVersion: 'v26.14.0',
      node: { using: 'kite', system: null },
    })
    // Removed again: back to the PATH as the shell gave it.
    await env.setNodeSetup({ managed: null })
    expect(env.agentEnv('claude-code').PATH).toBe('/usr/local/bin:/usr/bin')
    expect(env.nodeProbe()).toEqual(NONE)
  })

  it('runs Kite’s when the user’s is too old, or when the user chose Kite’s', async () => {
    const old = service(v22)
    await old.setNodeSetup({ managed, required: '>=24.9.0' })
    await old.ready()
    expect(old.agentEnv().PATH?.startsWith(`${KITE_BIN}:`)).toBe(true)
    expect(old.info().node?.system?.suitable).toBe(false)

    const chosen = service(v26)
    await chosen.ready()
    await chosen.setNodeSetup({ managed, choice: 'kite', required: '>=24.9.0' })
    expect(chosen.agentEnv('codex').PATH?.startsWith(`${KITE_BIN}:`)).toBe(true)
    await chosen.setNodeSetup({ choice: 'auto' })
    expect(chosen.agentEnv('codex').PATH).toBe('/usr/local/bin:/usr/bin')
  })

  it('keeps the user’s node when Kite’s folder holds none any more', async () => {
    const env = service(v22)
    await env.ready()
    await env.setNodeSetup({ managed: { version: 'v26.14.0', binDir: '/gone/bin' } })
    expect(env.info().node?.using).toBe('system')
    expect(env.agentEnv().PATH).toBe('/usr/local/bin:/usr/bin')
  })
})

describe('withNodeBin', () => {
  it('puts the folder first once, under the name PATH has on Windows', () => {
    const platform: Platform = 'win32'
    const bin = 'C:\\Users\\me\\AppData\\Roaming\\Huli\\runtimes\\node\\v26.14.0'
    const env = { Path: `C:\\Windows;${bin.toUpperCase()}\\;"C:\\Tools"`, PATHEXT: '.EXE' }
    expect(withNodeBin(env, bin, platform)).toEqual({
      Path: `${bin};C:\\Windows;"C:\\Tools"`,
      PATHEXT: '.EXE',
    })
    expect(withNodeBin({}, bin, platform)).toEqual({ PATH: bin })
  })

  it('leaves the other variables alone elsewhere', () => {
    expect(withNodeBin({ PATH: '/a:/b/:/b', HOME: '/h' }, '/b', 'darwin')).toEqual({
      PATH: '/b:/a',
      HOME: '/h',
    })
  })
})

describe('Kite’s Node.js requests', () => {
  const validators = createValidators('win32')

  it('take no params to install, stop or remove', () => {
    for (const method of [
      'environment.installNode',
      'environment.cancelNodeInstall',
      'environment.removeNode',
    ] as const) {
      expect(validators[method](undefined)).toBeUndefined()
      expect(validators[method]({})).toBeUndefined()
      expect(() => validators[method]({ version: 'v20.0.0' })).toThrow(
        expect.objectContaining({ code: 'invalid_params' }),
      )
      expect(() => validators[method]({ url: 'https://example.com/node.zip' })).toThrow()
    }
  })

  it('take only a known choice', () => {
    expect(validators['environment.setNodeChoice']({ choice: 'kite' })).toEqual({ choice: 'kite' })
    expect(validators['environment.setNodeChoice']({ choice: 'auto' })).toEqual({ choice: 'auto' })
    for (const bad of [
      undefined,
      {},
      { choice: 'system' },
      { choice: 'kite', path: '/x' },
      'kite',
    ]) {
      expect(() => validators['environment.setNodeChoice'](bad)).toThrow(
        expect.objectContaining({ code: 'invalid_params' }),
      )
    }
  })
})
