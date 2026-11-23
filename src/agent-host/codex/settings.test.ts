import { describe, expect, it } from 'vitest'
import type { CodexRequest } from '../marketplace/codex-plugins'
import { checkCodexChange, readCodexSettings, workspaceWrite, writeCodexSetting } from './settings'

const FEATURES = [
  { name: 'memories', stage: 'stable', enabled: true, defaultEnabled: false },
  {
    name: 'apps',
    stage: 'beta',
    enabled: false,
    defaultEnabled: false,
    displayName: 'Apps',
    description: 'Use connected apps',
  },
  { name: 'unfinished', stage: 'underDevelopment', enabled: false, defaultEnabled: false },
  { name: 'nameless', stage: 'beta', enabled: true, defaultEnabled: true, displayName: null },
]
const PROFILES = [
  { id: ':workspace', description: 'Built in', allowed: true },
  { id: 'locked-down', description: null, allowed: false },
]

/** An app-server that answers the config API from these, and records what it is asked. */
function fake(
  answers: Record<string, unknown>,
  missing: readonly string[] = [],
): { request: CodexRequest; asked: { method: string; params: unknown }[] } {
  const asked: { method: string; params: unknown }[] = []
  const request = (async (method: string, params?: unknown) => {
    asked.push({ method, params })
    if (missing.includes(method)) {
      throw Object.assign(new Error(`unknown variant \`${method}\``), { code: -32600 })
    }
    if (!(method in answers)) throw new Error(`unexpected ${method}`)
    return answers[method]
  }) as CodexRequest
  return { request, asked }
}

describe("Codex's settings through app-server's config API", () => {
  it('reads memories, the workspace sandbox, the profile and the features in beta', async () => {
    const { request } = fake({
      'config/read': {
        config: {
          default_permissions: ':workspace',
          sandbox_workspace_write: { network_access: true, writable_roots: ['/tmp/out', 3] },
        },
        origins: {
          default_permissions: { name: { type: 'user' } },
          'features.apps': { name: { type: 'system', file: '/etc/codex/managed_config.toml' } },
        },
      },
      'experimentalFeature/list': { data: FEATURES, nextCursor: null },
      'permissionProfile/list': { data: PROFILES, nextCursor: null },
    })
    expect(await readCodexSettings(request)).toEqual({
      memories: true,
      workspace: { networkAccess: true, writableRoots: ['/tmp/out'] },
      permissionProfile: ':workspace',
      profiles: [
        { id: ':workspace', description: 'Built in', allowed: true },
        { id: 'locked-down', description: null, allowed: false },
      ],
      features: [
        {
          name: 'apps',
          displayName: 'Apps',
          description: 'Use connected apps',
          enabled: false,
          defaultEnabled: false,
        },
      ],
      locked: ['features.apps'],
    })
  })

  it('leaves out the lists an older Codex lacks, reading memories from the file', async () => {
    const { request } = fake(
      { 'config/read': { config: { features: { memories: { enabled: true } } } } },
      ['experimentalFeature/list', 'permissionProfile/list'],
    )
    expect(await readCodexSettings(request)).toMatchObject({
      memories: true,
      workspace: { networkAccess: false, writableRoots: [] },
      permissionProfile: null,
      profiles: null,
      features: null,
    })
  })

  it('writes one key, and only a profile or a feature this Codex lists', async () => {
    const { request, asked } = fake({
      'config/value/write': { status: 'ok' },
      'experimentalFeature/list': { data: FEATURES, nextCursor: null },
      'permissionProfile/list': { data: PROFILES, nextCursor: null },
    })
    const writes = () =>
      asked.filter((call) => call.method === 'config/value/write').map((call) => call.params)
    await writeCodexSetting(request, { setting: 'memories', value: false })
    await writeCodexSetting(request, { setting: 'networkAccess', value: true })
    await writeCodexSetting(request, { setting: 'permissionProfile', value: ':workspace' })
    await writeCodexSetting(request, { setting: 'permissionProfile', value: null })
    await writeCodexSetting(request, { setting: 'feature', name: 'apps', value: true })
    expect(writes()).toEqual([
      { keyPath: 'features.memories', value: false, mergeStrategy: 'replace' },
      { keyPath: 'sandbox_workspace_write.network_access', value: true, mergeStrategy: 'replace' },
      { keyPath: 'default_permissions', value: ':workspace', mergeStrategy: 'replace' },
      { keyPath: 'default_permissions', value: null, mergeStrategy: 'replace' },
      { keyPath: 'features.apps', value: true, mergeStrategy: 'replace' },
    ])
    for (const change of [
      { setting: 'permissionProfile', value: 'locked-down' },
      { setting: 'permissionProfile', value: 'nobody' },
      { setting: 'feature', name: 'unfinished', value: true },
      { setting: 'feature', name: 'gone', value: true },
    ] as const) {
      await expect(writeCodexSetting(request, change)).rejects.toThrow()
    }
    expect(writes()).toHaveLength(5)
  })

  it('takes only changes of the shapes the page sends', () => {
    expect(checkCodexChange({ setting: 'feature', name: 'apps', value: true })).toEqual({
      setting: 'feature',
      name: 'apps',
      value: true,
    })
    for (const bad of [
      null,
      { setting: 'memories', value: 'yes' },
      { setting: 'networkAccess' },
      { setting: 'permissionProfile', value: '../x' },
      { setting: 'permissionProfile', value: 42 },
      { setting: 'feature', name: 'memories', value: true },
      { setting: 'feature', name: 'Features.Apps', value: true },
      { setting: 'feature', name: 'a'.repeat(65), value: true },
      { setting: 'model', value: 'gpt' },
    ]) {
      expect(() => checkCodexChange(bad)).toThrow()
    }
  })

  it("gives Kite's workspace turns the user's network access and folders", () => {
    expect(workspaceWrite({})).toEqual({ networkAccess: false, writableRoots: [] })
    expect(
      workspaceWrite({ sandbox_workspace_write: { network_access: 'yes', writable_roots: '/x' } }),
    ).toEqual({ networkAccess: false, writableRoots: [] })
  })
})
