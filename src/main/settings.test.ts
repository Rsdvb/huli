import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { splitSettingsPatch } from '@shared/remote/host-admin'
import { DEFAULT_SETTINGS } from '@shared/settings'
import { DEFAULT_PORT_BASE } from '@shared/worktree-ports'
import { SettingsStore } from './settings'
import { hostSettings, mergeSettings, validateSettingsPatch } from './settings-schema'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kettu-settings-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const save = (value: unknown): Promise<void> =>
  writeFile(join(dir, 'settings.json'), typeof value === 'string' ? value : JSON.stringify(value))

it('sends the exact Claude test label only when enabled and takes any text', async () => {
  await save({ version: 1, general: { claudeTestEntrypointLabel: 'kite_lab-42' } })
  const store = await SettingsStore.load(dir)
  const settings = store.get()
  expect(settings.general.claudeTestEntrypointLabel).toBe('kite_lab-42')
  expect(hostSettings(settings, 'en').claudeTestEntrypoint).toBeNull()
  const enabled = mergeSettings(settings, { general: { claudeTestEntrypoint: true } })
  expect(hostSettings(enabled, 'en').claudeTestEntrypoint).toBe('kite_lab-42')
  for (const label of ['cli', 'claude-desktop', 'sdk-ts', '中文 标识/1.0', '-x', '']) {
    expect(() =>
      validateSettingsPatch({ general: { claudeTestEntrypointLabel: label } }),
    ).not.toThrow()
  }
  for (const label of ['a\0b', 'x'.repeat(1025), 42]) {
    expect(() => validateSettingsPatch({ general: { claudeTestEntrypointLabel: label } })).toThrow(
      'valid custom Claude entrypoint label',
    )
  }
})

describe("Claude Code agents' fallback model and budget", () => {
  const run = { fallbackModel: 'claude-sonnet-5-5', budgetUsd: 2.5, budgetAllSessions: false }

  it('reads a file from before them as no fallback and no budget', async () => {
    await save({ version: 1, general: { language: 'en' } })
    const settings = (await SettingsStore.load(dir)).get()
    expect(settings.general.claudeRuns).toEqual({})
    expect(hostSettings(settings, 'en').claudeRuns).toEqual({})
  })

  it('keeps valid entries and sends them to the host', async () => {
    await save({ version: 1, general: { claudeRuns: { 'claude-code': run } } })
    const settings = (await SettingsStore.load(dir)).get()
    expect(hostSettings(settings, 'en').claudeRuns).toEqual({ 'claude-code': run })
    const none = { fallbackModel: null, budgetUsd: null, budgetAllSessions: true }
    const next = mergeSettings(settings, { general: { claudeRuns: { 'claude-code': none } } })
    expect(hostSettings(next, 'en').claudeRuns).toEqual({ 'claude-code': none })
  })

  it('drops a file entry that does not validate, leaving the default', async () => {
    await save({
      version: 1,
      general: { claudeRuns: { 'claude-code': { ...run, budgetUsd: -1 } } },
    })
    expect((await SettingsStore.load(dir)).get().general.claudeRuns).toEqual({})
  })

  it('takes a model id and a budget above 0 up to the cap', () => {
    for (const change of [
      { fallbackModel: null, budgetUsd: null },
      { budgetUsd: 0.01 },
      { budgetUsd: 10_000 },
      { fallbackModel: 'claude-opus-5-5[1m]' },
    ]) {
      expect(() =>
        validateSettingsPatch({
          general: { claudeRuns: { 'claude-code': { ...run, ...change } } },
        }),
      ).not.toThrow()
    }
  })

  it('rejects other budgets, models, keys and agents', () => {
    const bad: unknown[] = [
      { 'claude-code': { ...run, budgetUsd: 0 } },
      { 'claude-code': { ...run, budgetUsd: -5 } },
      { 'claude-code': { ...run, budgetUsd: 10_000.01 } },
      { 'claude-code': { ...run, budgetUsd: Number.POSITIVE_INFINITY } },
      { 'claude-code': { ...run, budgetUsd: Number.NaN } },
      { 'claude-code': { ...run, budgetUsd: '5' } },
      { 'claude-code': { ...run, fallbackModel: 42 } },
      { 'claude-code': { ...run, fallbackModel: '' } },
      { 'claude-code': { ...run, fallbackModel: 'opus sonnet' } },
      { 'claude-code': { ...run, fallbackModel: 'opus,sonnet' } },
      { 'claude-code': { ...run, fallbackModel: 'x'.repeat(257) } },
      { 'claude-code': { ...run, budgetAllSessions: 'yes' } },
      { 'claude-code': { fallbackModel: null, budgetUsd: null } },
      { 'claude-code': { ...run, maxTurns: 3 } },
      { 'claude-code': null },
      { codex: run },
      { nobody: run },
      [],
    ]
    for (const claudeRuns of bad) {
      expect(() => validateSettingsPatch({ general: { claudeRuns } })).toThrow()
    }
  })
})

describe('prompt suggestions', () => {
  it('are on for a file from before them and reach the host', async () => {
    await save({ version: 1, general: { language: 'en' } })
    const settings = (await SettingsStore.load(dir)).get()
    expect(settings.general.promptSuggestions).toBe(true)
    expect(hostSettings(settings, 'en').promptSuggestions).toBe(true)
    const off = mergeSettings(settings, { general: { promptSuggestions: false } })
    expect(hostSettings(off, 'en').promptSuggestions).toBe(false)
  })

  it('take only a boolean, kept by the host for a paired device', async () => {
    await save({ version: 1, general: { promptSuggestions: 'no' } })
    expect((await SettingsStore.load(dir)).get().general.promptSuggestions).toBe(true)
    expect(() => validateSettingsPatch({ general: { promptSuggestions: false } })).not.toThrow()
    for (const value of ['false', 0, null, {}]) {
      expect(() => validateSettingsPatch({ general: { promptSuggestions: value } })).toThrow()
    }
    const split = splitSettingsPatch({ general: { promptSuggestions: false, sendKey: 'enter' } })
    expect(split.host).toEqual({ general: { promptSuggestions: false } })
    expect(split.client).toEqual({ general: { sendKey: 'enter' } })
  })
})

describe("the agents' lower priority", () => {
  it('is on for a file from before it and reaches the host', async () => {
    await save({ version: 1, general: { language: 'en' } })
    const settings = (await SettingsStore.load(dir)).get()
    expect(settings.general.lowerAgentPriority).toBe(true)
    expect(hostSettings(settings, 'en').lowerAgentPriority).toBe(true)
    const off = mergeSettings(settings, { general: { lowerAgentPriority: false } })
    expect(off.general.lowerAgentPriority).toBe(false)
    expect(hostSettings(off, 'en').lowerAgentPriority).toBe(false)
  })

  it('keeps a stored off and drops a value that is no boolean', async () => {
    await save({ version: 1, general: { lowerAgentPriority: false } })
    expect((await SettingsStore.load(dir)).get().general.lowerAgentPriority).toBe(false)
    await save({ version: 1, general: { lowerAgentPriority: 'no' } })
    expect((await SettingsStore.load(dir)).get().general.lowerAgentPriority).toBe(true)
  })

  it('takes only a boolean, kept by the host for a paired device', () => {
    expect(() => validateSettingsPatch({ general: { lowerAgentPriority: false } })).not.toThrow()
    for (const value of ['false', 0, null, {}]) {
      expect(() => validateSettingsPatch({ general: { lowerAgentPriority: value } })).toThrow()
    }
    const split = splitSettingsPatch({ general: { lowerAgentPriority: false, sendKey: 'enter' } })
    expect(split.host).toEqual({ general: { lowerAgentPriority: false } })
    expect(split.client).toEqual({ general: { sendKey: 'enter' } })
  })
})

// Huli: the sandbox default and its approvals rule.
describe('the sandbox settings', () => {
  it('start off, keep known values and drop the rest', async () => {
    await save({ version: 1, general: { language: 'en' } })
    const settings = (await SettingsStore.load(dir)).get()
    expect(settings.sandbox).toEqual({ tier: 'off', network: 'none', autoApproveEdits: false })
    expect(hostSettings(settings, 'en').sandbox).toEqual(settings.sandbox)
    await save({
      version: 1,
      sandbox: { tier: 'container', network: 'open', autoApproveEdits: true },
    })
    expect((await SettingsStore.load(dir)).get().sandbox).toEqual({
      tier: 'container',
      network: 'open',
      autoApproveEdits: true,
    })
    await save({
      version: 1,
      sandbox: { tier: 'vm', network: 'everything', autoApproveEdits: 'yes' },
    })
    expect((await SettingsStore.load(dir)).get().sandbox).toEqual({
      tier: 'off',
      network: 'none',
      autoApproveEdits: false,
    })
  })

  it('takes only known tiers, networks and a boolean', () => {
    expect(() =>
      validateSettingsPatch({ sandbox: { tier: 'native', network: 'agent' } }),
    ).not.toThrow()
    for (const sandbox of [
      { tier: 'vm' },
      { network: 'all' },
      { autoApproveEdits: 'true' },
      { tier: null },
    ]) {
      expect(() => validateSettingsPatch({ sandbox })).toThrow()
    }
  })
})

describe('the first start record on load', () => {
  it('leaves a host without a settings file to run its first start', async () => {
    const store = await SettingsStore.load(dir)
    expect(store.get().initialSetup).toEqual({ done: false })
  })

  it('counts a file from before the record as a host set up by hand', async () => {
    await save({ version: 1, general: { language: 'en' } })
    const store = await SettingsStore.load(dir)
    expect(store.get().initialSetup).toEqual({ done: true })
  })

  it('counts an unreadable file the same, since it has history', async () => {
    await save('{ not json')
    const store = await SettingsStore.load(dir)
    expect(store.get().initialSetup.done).toBe(true)
  })

  it('keeps a record that says the first start has not run', async () => {
    await save({ version: 1, initialSetup: { done: false } })
    const store = await SettingsStore.load(dir)
    expect(store.get().initialSetup.done).toBe(false)
  })
})

describe('the onboarding and the cloud switch on load', () => {
  // The cloud's default is the build's: on in Kettu, off in Huli.
  it('starts the onboarding on a fresh install, with the cloud at its default', async () => {
    const store = await SettingsStore.load(dir)
    expect(store.get().onboarding).toEqual({ done: false, step: 'welcome' })
    expect(store.get().cloud).toEqual(DEFAULT_SETTINGS.cloud)
  })

  it('skips the onboarding for a file from before it, the cloud at its default', async () => {
    await save({ version: 1, initialSetup: { done: true }, general: { language: 'en' } })
    const store = await SettingsStore.load(dir)
    expect(store.get().onboarding.done).toBe(true)
    expect(store.get().cloud).toEqual(DEFAULT_SETTINGS.cloud)
  })

  it('skips it for an unreadable file too, since it has history', async () => {
    await save('{ not json')
    const store = await SettingsStore.load(dir)
    expect(store.get().onboarding.done).toBe(true)
  })

  it('resumes an unfinished onboarding at its step and keeps a self-hosted choice', async () => {
    await save({
      version: 1,
      initialSetup: { done: true },
      onboarding: { done: false, step: 'agents' },
      cloud: { enabled: false },
    })
    const store = await SettingsStore.load(dir)
    expect(store.get().onboarding).toEqual({ done: false, step: 'agents' })
    expect(store.get().cloud.enabled).toBe(false)
  })

  it('falls back to the defaults for values it does not know', async () => {
    await save({ version: 1, onboarding: { done: 'no', step: 'nowhere' }, cloud: { enabled: 0 } })
    const store = await SettingsStore.load(dir)
    expect(store.get().onboarding).toEqual({ done: false, step: 'welcome' })
    expect(store.get().cloud).toEqual(DEFAULT_SETTINGS.cloud)
  })
})

describe('adding the agents the first start found', () => {
  it('adds the default agents in the list order and records them once', async () => {
    const store = await SettingsStore.load(dir)
    const next = store.firstStart(['codex', 'not-a-harness', 'claude-code', 'codex'])
    expect(next.initialSetup).toEqual({ done: true })
    expect(next.agents['claude-code']).toEqual({ enabled: true })
    expect(next.agents.codex).toEqual({ enabled: true })
    expect(store.firstStart(['opencode']).agents.opencode).toBeUndefined()
    await store.flush()
  })

  it('makes the first agent added the default when none is chosen', async () => {
    const store = await SettingsStore.load(dir)
    expect(store.firstStart(['codex', 'claude-code']).general.defaultAgent).toBe('claude-code')
    await store.flush()
  })

  it('keeps a default agent that was chosen', async () => {
    await save({
      version: 1,
      initialSetup: { done: false },
      general: { defaultAgent: 'pi' },
    })
    const store = await SettingsStore.load(dir)
    expect(store.firstStart(['claude-code']).general.defaultAgent).toBe('pi')
    await store.flush()
  })

  it('is done even when it found nothing', async () => {
    const store = await SettingsStore.load(dir)
    expect(store.firstStart([]).initialSetup).toEqual({ done: true })
    await store.flush()
  })

  it('adds only harnesses that run the user program', async () => {
    const store = await SettingsStore.load(dir)
    const next = store.firstStart(['gemini', 'opencode'])
    expect(next.agents.gemini).toBeUndefined()
    expect(next.agents.opencode).toEqual({ enabled: true })
    await store.flush()
  })

  it('adds Antigravity, which runs the user agy, after the others', async () => {
    const store = await SettingsStore.load(dir)
    const next = store.firstStart(['antigravity', 'codex'])
    expect(next.agents.antigravity).toEqual({ enabled: true })
    expect(next.general.defaultAgent).toBe('codex')
    await store.flush()
  })

  it('leaves a harness the user removed before as it is', async () => {
    await save({
      version: 1,
      initialSetup: { done: false },
      agents: { codex: { enabled: false } },
    })
    const store = await SettingsStore.load(dir)
    const next = store.firstStart(['claude-code', 'codex'])
    expect(next.agents['claude-code']).toEqual({ enabled: true })
    expect(next.agents.codex).toEqual({ enabled: false })
    await store.flush()
  })
})

describe('where worktrees go', () => {
  it('puts them beside each project until a folder is chosen', async () => {
    const store = await SettingsStore.load(dir)
    expect(store.get().git.worktreeRoot).toBeNull()
  })

  it('keeps an absolute folder and drops anything else on load', async () => {
    const root = join(dir, 'worktrees')
    await save({ version: 1, git: { backgroundFetch: true, worktreeRoot: root } })
    expect((await SettingsStore.load(dir)).get().git).toEqual({
      backgroundFetch: true,
      worktreeRoot: root,
      portBase: DEFAULT_PORT_BASE,
    })
    for (const bad of ['relative/worktrees', '', 7, `${root}\0x`]) {
      await save({ version: 1, git: { worktreeRoot: bad } })
      expect((await SettingsStore.load(dir)).get().git.worktreeRoot).toBeNull()
    }
  })

  it('takes an absolute folder or null in a change and refuses the rest', () => {
    const root = join(dir, 'worktrees')
    expect(validateSettingsPatch({ git: { worktreeRoot: root } })).toEqual({
      git: { worktreeRoot: root },
    })
    expect(validateSettingsPatch({ git: { worktreeRoot: null } })).toEqual({
      git: { worktreeRoot: null },
    })
    for (const bad of ['relative', '', 3, `${root}\0x`]) {
      expect(() => validateSettingsPatch({ git: { worktreeRoot: bad } })).toThrow()
    }
  })
})

// Huli: where the port blocks of worktree sessions start.
describe('the worktree ports', () => {
  it('start at the default until changed, and keep a base with room for a block', async () => {
    expect((await SettingsStore.load(dir)).get().git.portBase).toBe(DEFAULT_PORT_BASE)
    await save({ version: 1, git: { portBase: 41_000 } })
    expect((await SettingsStore.load(dir)).get().git.portBase).toBe(41_000)
    for (const bad of [80, 65_530, 20_000.5, '20000', null]) {
      await save({ version: 1, git: { portBase: bad } })
      expect((await SettingsStore.load(dir)).get().git.portBase).toBe(DEFAULT_PORT_BASE)
    }
  })

  it('takes a base from 1024 that leaves a whole block, and refuses the rest', () => {
    expect(validateSettingsPatch({ git: { portBase: 1024 } })).toEqual({ git: { portBase: 1024 } })
    expect(validateSettingsPatch({ git: { portBase: 65_526 } })).toEqual({
      git: { portBase: 65_526 },
    })
    for (const bad of [1023, 65_527, 3.5, '4000', null]) {
      expect(() => validateSettingsPatch({ git: { portBase: bad } })).toThrow()
    }
  })
})

describe('the mode new sessions start in', () => {
  const modes = {
    'claude-code': 'bypassPermissions',
    codex: 'agent-full-access',
    deepseek: 'danger-full-access',
  }

  it('keeps any mode the user chose on load, full access included', async () => {
    await save({ version: 1, startModes: { ...modes, opencode: 'build' } })
    expect((await SettingsStore.load(dir)).get().startModes).toEqual(modes)
  })

  it('takes full access in a change, and refuses an agent that takes no mode', () => {
    expect(validateSettingsPatch({ startModes: modes })).toEqual({ startModes: modes })
    expect(validateSettingsPatch({ startModes: { codex: null } })).toEqual({
      startModes: { codex: null },
    })
    for (const bad of [{ opencode: 'build' }, { codex: '' }, { codex: 7 }]) {
      expect(() => validateSettingsPatch({ startModes: bad })).toThrow()
    }
  })
})

describe('the model of lightweight tasks', () => {
  const pinned = { mode: 'pinned', agentId: 'codex', model: 'gpt-5.5-mini' }

  it('picks a small model until another is chosen, and keeps a valid choice on load', async () => {
    expect((await SettingsStore.load(dir)).get().general.lightModel).toEqual({ mode: 'small' })
    for (const choice of [{ mode: 'session' }, pinned]) {
      await save({ version: 1, general: { lightModel: choice } })
      expect((await SettingsStore.load(dir)).get().general.lightModel).toEqual(choice)
    }
  })

  const bad = [
    'small',
    { mode: 'other' },
    { mode: 'small', agentId: 'codex' },
    { mode: 'pinned', agentId: 'codex' },
    { mode: 'pinned', agentId: 'not an agent', model: 'm' },
    { mode: 'pinned', agentId: 'codex', model: ' ' },
    { mode: 'pinned', agentId: 'codex', model: 'm\0' },
    { mode: 'pinned', agentId: 'codex', model: 'm'.repeat(201) },
    { ...pinned, extra: true },
  ]

  it('drops anything else on load', async () => {
    for (const choice of bad) {
      await save({ version: 1, general: { lightModel: choice } })
      expect((await SettingsStore.load(dir)).get().general.lightModel).toEqual({ mode: 'small' })
    }
  })

  it('takes one of the three in a change, replaced whole, and refuses the rest', () => {
    const patch = validateSettingsPatch({ general: { lightModel: pinned } })
    const next = mergeSettings(DEFAULT_SETTINGS, patch)
    expect(next.general.lightModel).toEqual(pinned)
    const back = mergeSettings(
      next,
      validateSettingsPatch({ general: { lightModel: { mode: 'session' } } }),
    )
    expect(back.general.lightModel).toEqual({ mode: 'session' })
    for (const choice of bad) {
      expect(() => validateSettingsPatch({ general: { lightModel: choice } })).toThrow()
    }
  })

  it('is kept by the host and reaches its agent host', () => {
    expect(splitSettingsPatch({ general: { lightModel: { mode: 'session' } } })).toEqual({
      host: { general: { lightModel: { mode: 'session' } } },
      client: null,
    })
    const settings = mergeSettings(DEFAULT_SETTINGS, {
      general: { lightModel: { mode: 'session' } },
    })
    expect(hostSettings(settings, 'en').lightModel).toEqual({ mode: 'session' })
  })
})

describe('when idle sessions let their agent go', () => {
  it('releases by memory until the user picks, with Custom at 5 and 30 minutes and no limit', async () => {
    const store = await SettingsStore.load(dir)
    expect(store.get().idleSessions).toEqual({
      release: 'auto',
      outOfView: 5,
      inView: 30,
      limit: null,
    })
    expect(hostSettings(store.get(), 'en').idleSessions).toEqual(store.get().idleSessions)
  })

  it('takes only the listed modes, minutes and limits in a change', () => {
    for (const release of ['auto', 'custom', 'never']) {
      expect(validateSettingsPatch({ idleSessions: { release } })).toEqual({
        idleSessions: { release },
      })
    }
    for (const outOfView of [1, 5, 15, 30, 60]) {
      expect(() => validateSettingsPatch({ idleSessions: { outOfView } })).not.toThrow()
    }
    for (const inView of [5, 15, 30, 60]) {
      expect(() => validateSettingsPatch({ idleSessions: { inView } })).not.toThrow()
    }
    for (const limit of [null, 1, 2, 3, 5]) {
      expect(() => validateSettingsPatch({ idleSessions: { limit } })).not.toThrow()
    }
    for (const bad of [
      { release: 'always' },
      { release: null },
      { outOfView: 0 },
      { outOfView: 2 },
      { outOfView: '5' },
      { outOfView: 120 },
      { inView: 1 },
      { inView: 45 },
      { limit: 0 },
      { limit: 4 },
      { limit: 'none' },
      { limit: 1.5 },
      { other: true },
    ]) {
      expect(() => validateSettingsPatch({ idleSessions: bad })).toThrow()
    }
    expect(() => validateSettingsPatch({ idleSessions: 'never' })).toThrow()
  })

  it('merges a change key by key and keeps it the host’s', () => {
    const before = structuredClone(DEFAULT_SETTINGS)
    const patch = validateSettingsPatch({ idleSessions: { release: 'custom', limit: 2 } })
    expect(mergeSettings(before, patch).idleSessions).toEqual({
      release: 'custom',
      outOfView: 5,
      inView: 30,
      limit: 2,
    })
    expect(splitSettingsPatch(patch)).toEqual({ host: patch, client: null })
  })

  it('keeps the valid values of a stored section and drops the rest', async () => {
    await save({
      version: 1,
      idleSessions: { release: 'custom', outOfView: 60, inView: 7, limit: 3, extra: 1 },
    })
    expect((await SettingsStore.load(dir)).get().idleSessions).toEqual({
      release: 'custom',
      outOfView: 60,
      inView: 30,
      limit: 3,
    })
    await save({ version: 1, idleSessions: 'never' })
    expect((await SettingsStore.load(dir)).get().idleSessions.release).toBe('auto')
  })
})

describe('items from the Kettu Marketplace in a patch', () => {
  const skill = {
    id: 'kettu:abcdefgh23',
    name: 'greeter',
    description: 'Greets the user.',
    source: 'kettu',
    origin: '@amigoer/greeter',
    version: '1.0.0',
    agents: 'all',
    on: true,
  }
  const server = {
    id: 'kettu:abcdefgh23',
    name: 'memory-notes',
    title: 'Memory Notes',
    source: 'kettu',
    version: '2.1.1',
    spec: { type: 'stdio', command: 'npx', args: ['-y', 'pkg@2.1.1'], env: [] },
    agents: 'all',
    on: true,
  }

  it('keeps a skill and a server by their listing', () => {
    expect(validateSettingsPatch({ marketplace: { skills: [skill] } })).toEqual({
      marketplace: { skills: [skill] },
    })
    expect(validateSettingsPatch({ marketplace: { mcp: [server] } })).toEqual({
      marketplace: { mcp: [server] },
    })
  })

  it('keeps a bundle’s server on Kettu’s Node.js with its inputs’ labels and kinds', () => {
    const bundled = {
      ...server,
      spec: {
        type: 'stdio',
        command: 'node',
        args: ['/data/marketplace/mcpb/abcdefgh23/1.0.0/server/index.js'],
        env: [
          {
            name: 'ECHO_KEY',
            input: true,
            secret: false,
            required: true,
            title: 'Port',
            kind: 'number',
            default: '8080',
            min: 1,
            max: 65535,
          },
        ],
        runtime: 'node',
      },
    }
    expect(validateSettingsPatch({ marketplace: { mcp: [bundled] } })).toEqual({
      marketplace: { mcp: [bundled] },
    })
    const env = (over: Record<string, unknown>) => ({
      ...bundled,
      spec: { ...bundled.spec, env: [{ ...bundled.spec.env[0], ...over }] },
    })
    for (const bad of [
      { ...bundled, spec: { ...bundled.spec, runtime: '/Applications/Kettu.app' } },
      env({ kind: 'color' }),
      env({ min: 'one' }),
      env({ title: 'a\nb' }),
      env({ default: 1 }),
    ]) {
      expect(() => validateSettingsPatch({ marketplace: { mcp: [bad] } })).toThrow()
    }
  })

  it('keeps a catalog skill from any repository by owner/repo and name', () => {
    const catalog = {
      ...skill,
      id: 'trailofbits/skills:semgrep',
      name: 'semgrep',
      source: 'catalog',
      origin: 'https://github.com/trailofbits/skills',
    }
    expect(validateSettingsPatch({ marketplace: { skills: [catalog] } })).toEqual({
      marketplace: { skills: [catalog] },
    })
    for (const id of ['semgrep', '../skills:semgrep', 'trailofbits/skills:Semgrep']) {
      expect(() =>
        validateSettingsPatch({ marketplace: { skills: [{ ...catalog, id }] } }),
      ).toThrow()
    }
  })

  it('refuses an id or origin that names no listing', () => {
    for (const bad of [
      { ...skill, id: 'kettu:../x' },
      { ...skill, id: 'local:abcdefgh23' },
      { ...skill, origin: 'https://example.com/greeter' },
      { ...skill, origin: '@amigoer/../x' },
    ]) {
      expect(() => validateSettingsPatch({ marketplace: { skills: [bad] } })).toThrow()
    }
    expect(() =>
      validateSettingsPatch({ marketplace: { mcp: [{ ...server, id: 'kettu:ABC' }] } }),
    ).toThrow()
  })
})

describe('the terminal font', () => {
  it('uses the theme’s code font until a face is named', async () => {
    const store = await SettingsStore.load(dir)
    expect(store.get().terminal.fontFamily).toBeUndefined()
  })

  it('keeps a stored face and drops one that could break out of a font stack on load', async () => {
    await save({ version: 1, terminal: { fontSize: 14, fontFamily: 'Maple Mono NF CN' } })
    expect((await SettingsStore.load(dir)).get().terminal).toEqual({
      fontSize: 14,
      fontFamily: 'Maple Mono NF CN',
    })
    for (const bad of ['', ' padded ', 'A", evil', "A'; x", 'A\nB', 'a{b}', 7, 'x'.repeat(101)]) {
      await save({ version: 1, terminal: { fontSize: 14, fontFamily: bad } })
      expect((await SettingsStore.load(dir)).get().terminal).toEqual({ fontSize: 14 })
    }
  })

  it('takes one face name or null in a change and refuses the rest', () => {
    expect(validateSettingsPatch({ terminal: { fontFamily: 'Maple Mono NF CN' } })).toEqual({
      terminal: { fontFamily: 'Maple Mono NF CN' },
    })
    expect(validateSettingsPatch({ terminal: { fontFamily: null } })).toEqual({
      terminal: { fontFamily: null },
    })
    for (const bad of ['', ' padded ', 'A", evil', 'A, B', 'url(x)', 'A;B', 3]) {
      expect(() => validateSettingsPatch({ terminal: { fontFamily: bad } })).toThrow()
    }
  })

  it('sets the face in a change and clears it with null', () => {
    const named = mergeSettings(DEFAULT_SETTINGS, { terminal: { fontFamily: 'Menlo' } })
    expect(named.terminal.fontFamily).toBe('Menlo')
    const cleared = mergeSettings(named, { terminal: { fontFamily: null } })
    expect('fontFamily' in cleared.terminal).toBe(false)
  })

  it('stays with the window that draws the terminal, never on the host', () => {
    const { host, client } = splitSettingsPatch({ terminal: { fontFamily: 'Menlo' } })
    expect(host).toBeNull()
    expect(client).toEqual({ terminal: { fontFamily: 'Menlo' } })
  })
})

// Huli: the daily backup of the data folder.
describe('the backup', () => {
  it('runs daily at 03:00 into the default folder, keeping 7, until the user changes it', async () => {
    expect((await SettingsStore.load(dir)).get().backup).toEqual({
      enabled: true,
      time: '03:00',
      keep: 7,
      folder: null,
    })
  })

  it('keeps the valid values of a stored section and drops the rest on load', async () => {
    const folder = join(dir, 'backups')
    await save({ version: 1, backup: { enabled: false, time: '21:45', keep: 30, folder } })
    expect((await SettingsStore.load(dir)).get().backup).toEqual({
      enabled: false,
      time: '21:45',
      keep: 30,
      folder,
    })
    await save({
      version: 1,
      backup: { enabled: 'yes', time: '24:00', keep: 0, folder: 'relative/backups' },
    })
    expect((await SettingsStore.load(dir)).get().backup).toEqual({
      enabled: true,
      time: '03:00',
      keep: 7,
      folder: null,
    })
  })

  it('takes a switch, a time of day and a count in a change, and clears the folder', () => {
    const patch = { backup: { enabled: false, time: '00:05', keep: 60, folder: null } }
    expect(validateSettingsPatch(patch)).toEqual(patch)
    const next = mergeSettings(
      { ...DEFAULT_SETTINGS, backup: { ...DEFAULT_SETTINGS.backup, folder: join(dir, 'b') } },
      patch,
    )
    expect(next.backup).toEqual({ enabled: false, time: '00:05', keep: 60, folder: null })
  })

  it('refuses a folder from the renderer, which only the dialog in main may name', () => {
    expect(() => validateSettingsPatch({ backup: { folder: join(dir, 'elsewhere') } })).toThrow(
      'can only be cleared with null',
    )
  })

  it('refuses times, counts and keys it does not know', () => {
    for (const time of ['3:00', '24:00', '12:60', '12:00:00', '', 300]) {
      expect(() => validateSettingsPatch({ backup: { time } })).toThrow('HH:MM')
    }
    for (const keep of [0, 61, 1.5, '7', null]) {
      expect(() => validateSettingsPatch({ backup: { keep } })).toThrow('whole number')
    }
    expect(() => validateSettingsPatch({ backup: { enabled: 1 } })).toThrow('boolean')
    expect(() => validateSettingsPatch({ backup: { secrets: true } })).toThrow('Unknown setting')
    expect(() => validateSettingsPatch({ backup: true })).toThrow('must be an object')
  })

  it('sets a folder the dialog gave, absolute only', async () => {
    const store = await SettingsStore.load(dir)
    const folder = join(dir, 'picked')
    expect(store.setBackupFolder(folder).backup.folder).toBe(folder)
    expect(() => store.setBackupFolder('relative')).toThrow('absolute path')
    expect(() => store.setBackupFolder(`${folder}\0x`)).toThrow('NUL')
    await store.flush()
  })

  it('stays with this computer, never on a host a device changes', () => {
    const { host, client } = splitSettingsPatch({ backup: { keep: 3 } })
    expect(host).toBeNull()
    expect(client).toEqual({ backup: { keep: 3 } })
  })
})
