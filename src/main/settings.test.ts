import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hostSettingsPart, splitSettingsPatch, withHostSettings } from '@shared/remote/host-admin'
import { DEFAULT_FEATURES, FEATURE_IDS } from '@shared/features'
import { RELAY_URL } from '@shared/remote/relay'
import { APP_ICONS, CODE_SIZES, CONVERSATION_WIDTHS, DEFAULT_SETTINGS } from '@shared/settings'
import { DEFAULT_PORT_BASE } from '@shared/worktree-ports'
import { SettingsStore } from './settings'
import {
  effectiveDirect,
  hostSettings,
  mergeSettings,
  terminalSettings,
  validateSettingsPatch,
  withOwnRelay,
} from './settings-schema'

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
      { outputStyle: null },
      { outputStyle: 'Explanatory' },
      { outputStyle: 'My team style' },
      { outputStyle: '讲解' },
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
      { 'claude-code': { ...run, outputStyle: 42 } },
      { 'claude-code': { ...run, outputStyle: '' } },
      { 'claude-code': { ...run, outputStyle: ' Explanatory' } },
      { 'claude-code': { ...run, outputStyle: 'a\nb' } },
      { 'claude-code': { ...run, outputStyle: 'x'.repeat(101) } },
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

// Huli: other agents' suggestions cost a request of the plan each turn, so they wait to be asked for.
describe("other agents' suggestions", () => {
  it('are off for a file from before them, and an on reaches the host', async () => {
    await save({ version: 1, general: { promptSuggestions: true } })
    const settings = (await SettingsStore.load(dir)).get()
    expect(settings.general.otherAgentSuggestions).toBe(false)
    expect(hostSettings(settings, 'en').otherAgentSuggestions).toBe(false)
    const on = mergeSettings(settings, { general: { otherAgentSuggestions: true } })
    expect(on.general.promptSuggestions).toBe(true)
    expect(hostSettings(on, 'en').otherAgentSuggestions).toBe(true)
  })

  it('keep a stored on and drop a value that is no boolean', async () => {
    await save({ version: 1, general: { otherAgentSuggestions: true } })
    expect((await SettingsStore.load(dir)).get().general.otherAgentSuggestions).toBe(true)
    await save({ version: 1, general: { otherAgentSuggestions: 'yes' } })
    expect((await SettingsStore.load(dir)).get().general.otherAgentSuggestions).toBe(false)
  })

  it('take only a boolean, kept by the host for a paired device', () => {
    expect(() => validateSettingsPatch({ general: { otherAgentSuggestions: true } })).not.toThrow()
    for (const value of ['true', 1, null, {}]) {
      expect(() => validateSettingsPatch({ general: { otherAgentSuggestions: value } })).toThrow()
    }
    const split = splitSettingsPatch({ general: { otherAgentSuggestions: true, sendKey: 'enter' } })
    expect(split.host).toEqual({ general: { otherAgentSuggestions: true } })
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

// Huli: what the notch island shows beside the notch.
describe('the island beside the notch', () => {
  it('avoids the menu bar for a file from before it, keeps a choice and drops the rest', async () => {
    await save({ version: 1, notifications: { island: true } })
    expect((await SettingsStore.load(dir)).get().notifications.islandSides).toBe('auto')
    await save({ version: 1, notifications: { islandSides: 'notch' } })
    expect((await SettingsStore.load(dir)).get().notifications.islandSides).toBe('notch')
    for (const islandSides of ['off', 'left', true, null, 'NOTCH']) {
      await save({ version: 1, notifications: { islandSides } })
      expect((await SettingsStore.load(dir)).get().notifications.islandSides).toBe('auto')
    }
  })

  it('takes only its two choices in a change', () => {
    for (const islandSides of ['auto', 'notch']) {
      expect(() => validateSettingsPatch({ notifications: { islandSides } })).not.toThrow()
    }
    for (const islandSides of ['off', ' notch', 1, null, false]) {
      expect(() => validateSettingsPatch({ notifications: { islandSides } })).toThrow()
    }
  })
})

// Huli: who may drive apps run as administrator.
describe('administrator use of computer use', () => {
  it('is off for a file from before it, and the old switch turns nothing on', async () => {
    await save({ version: 1, computerUse: { enabled: true, allowElevated: true } })
    const settings = (await SettingsStore.load(dir)).get()
    expect(settings.computerUse.elevated).toBe('off')
    expect(settings.computerUse).not.toHaveProperty('allowElevated')
    expect(hostSettings(settings, 'en').computerUse.elevated).toBe('off')
  })

  it('keeps a stored choice and drops one it does not know', async () => {
    await save({ version: 1, computerUse: { elevated: 'always' } })
    expect((await SettingsStore.load(dir)).get().computerUse.elevated).toBe('always')
    // `sandbox` was a choice of an unreleased build only.
    for (const elevated of ['sandbox', 'on', true, 'ALWAYS', null]) {
      await save({ version: 1, computerUse: { elevated } })
      expect((await SettingsStore.load(dir)).get().computerUse.elevated).toBe('off')
    }
  })

  it('takes only its two choices, and never from a paired device', () => {
    for (const elevated of ['off', 'always']) {
      expect(() => validateSettingsPatch({ computerUse: { elevated } })).not.toThrow()
    }
    for (const elevated of ['sandbox', 'on', true, 1, null, 'Always', ' always']) {
      expect(() => validateSettingsPatch({ computerUse: { elevated } })).toThrow()
    }
    expect(() => validateSettingsPatch({ computerUse: { allowElevated: true } })).toThrow(
      'Unknown setting',
    )
    // The computer's own setting: a device's change of it is refused as a client key.
    expect(splitSettingsPatch({ computerUse: { elevated: 'always' } })).toEqual({
      host: null,
      client: { computerUse: { elevated: 'always' } },
    })
  })
})

// Huli: the sandbox default and its approvals rule.
describe('the sandbox settings', () => {
  it('start off, keep known values and drop the rest', async () => {
    await save({ version: 1, general: { language: 'en' } })
    const settings = (await SettingsStore.load(dir)).get()
    expect(settings.sandbox).toEqual({
      tier: 'off',
      network: 'none',
      autoApproveEdits: false,
      gitWritable: false,
    })
    expect(hostSettings(settings, 'en').sandbox).toEqual(settings.sandbox)
    await save({
      version: 1,
      sandbox: { tier: 'container', network: 'model', autoApproveEdits: true, gitWritable: true },
    })
    expect((await SettingsStore.load(dir)).get().sandbox).toEqual({
      tier: 'container',
      network: 'model',
      autoApproveEdits: true,
      gitWritable: true,
    })
    await save({
      version: 1,
      sandbox: { tier: 'vm', network: 'everything', autoApproveEdits: 'yes' },
    })
    expect((await SettingsStore.load(dir)).get().sandbox).toEqual({
      tier: 'off',
      network: 'none',
      autoApproveEdits: false,
      gitWritable: false,
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
      { gitWritable: 1 },
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

  it('adds every harness whose own program was found, npm packages included', async () => {
    const store = await SettingsStore.load(dir)
    const next = store.firstStart(['deepseek', 'gemini', 'opencode'])
    expect(next.agents.deepseek).toEqual({ enabled: true })
    expect(next.agents.gemini).toEqual({ enabled: true })
    expect(next.agents.opencode).toEqual({ enabled: true })
    expect(next.general.defaultAgent).toBe('opencode')
    await store.flush()
  })

  it('never adds the development agent, which needs no adding', async () => {
    const store = await SettingsStore.load(dir)
    expect(store.firstStart(['fake-agent']).agents['fake-agent']).toBeUndefined()
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
    antigravity: 'dangerously-skip-permissions',
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

describe('letting agents type passwords', () => {
  it('is off until the user turns it on', () => {
    expect(DEFAULT_SETTINGS.general.agentPasswords).toBe(false)
    expect(hostSettings(DEFAULT_SETTINGS, 'en').agentPasswords).toBe(false)
  })

  it('is kept by the host, so a client never turns it on for its own computer instead', () => {
    expect(splitSettingsPatch({ general: { agentPasswords: true } })).toEqual({
      host: { general: { agentPasswords: true } },
      client: null,
    })
    const settings = mergeSettings(DEFAULT_SETTINGS, { general: { agentPasswords: true } })
    expect(hostSettings(settings, 'en').agentPasswords).toBe(true)
  })
})

describe('continuing after a plan limit resets', () => {
  it('is kept by the host, so a client changes the value its sessions follow', () => {
    expect(splitSettingsPatch({ general: { continueAfterLimit: false } })).toEqual({
      host: { general: { continueAfterLimit: false } },
      client: null,
    })
    const host = mergeSettings(DEFAULT_SETTINGS, { general: { continueAfterLimit: false } })
    expect(hostSettingsPart(host).general.continueAfterLimit).toBe(false)
    const shown = withHostSettings(structuredClone(DEFAULT_SETTINGS), hostSettingsPart(host))
    expect(shown.general.continueAfterLimit).toBe(false)
    expect(hostSettings(host, 'en').continueAfterLimit).toBe(false)
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

describe("a plugin's items in a patch", () => {
  const skill = {
    id: 'plugin:p0123456789ab:review',
    name: 'review',
    description: 'Reviews a change.',
    source: 'plugin',
    origin: 'review-kit',
    version: '1.0.0',
    agents: 'all',
    on: true,
  }
  const server = {
    id: 'plugin:p0123456789ab:tracker',
    name: 'tracker',
    title: 'tracker',
    source: 'plugin',
    version: null,
    spec: { type: 'stdio', command: '/data/plugins/bin/server', args: [], env: [] },
    agents: 'all',
    on: true,
  }

  it('keeps a skill and a server by the plugin that brought them', () => {
    expect(validateSettingsPatch({ marketplace: { skillsEdit: { put: [skill] } } })).toEqual({
      marketplace: { skillsEdit: { put: [skill] } },
    })
    expect(validateSettingsPatch({ marketplace: { mcpEdit: { put: [server] } } })).toEqual({
      marketplace: { mcpEdit: { put: [server] } },
    })
  })

  it('refuses an id that names no plugin, and an origin that is no plugin name', () => {
    for (const id of ['plugin:review', 'plugin:p01:review', 'plugin:p0123456789ab:../x', 'x']) {
      expect(() => validateSettingsPatch({ marketplace: { skills: [{ ...skill, id }] } })).toThrow()
      expect(() => validateSettingsPatch({ marketplace: { mcp: [{ ...server, id }] } })).toThrow()
    }
    expect(() =>
      validateSettingsPatch({ marketplace: { skills: [{ ...skill, origin: '/etc/passwd' }] } }),
    ).toThrow()
    expect(() =>
      validateSettingsPatch({ marketplace: { skills: [{ ...skill, source: 'kettu' }] } }),
    ).toThrow()
  })
})

describe("a server's tools and projects in a patch", () => {
  const server = {
    id: 'manual:0b6e4f2c-6b7a-4f5e-9d2a-3c1b2a4d5e6f',
    name: 'files',
    title: 'Files',
    source: 'manual',
    version: null,
    spec: { type: 'stdio', command: 'files-mcp', args: [], env: [] },
    agents: 'all',
    on: true,
  }
  const put = (extra: Record<string, unknown>) =>
    validateSettingsPatch({ marketplace: { mcpEdit: { put: [{ ...server, ...extra }] } } })

  it('keeps the tools turned off, each once, and the projects it goes to', () => {
    const projects = { mode: 'only', paths: [resolve('/work/app')] }
    expect(put({ toolsOff: ['erase', 'erase', 'move'], projects })).toEqual({
      marketplace: { mcpEdit: { put: [{ ...server, toolsOff: ['erase', 'move'], projects }] } },
    })
  })

  it('refuses a tool name that is no name, a relative project and an unknown mode', () => {
    expect(() => put({ toolsOff: [''] })).toThrow()
    expect(() => put({ toolsOff: 'erase' })).toThrow()
    expect(() => put({ projects: { mode: 'only', paths: ['work/app'] } })).toThrow()
    expect(() => put({ projects: { mode: 'some', paths: [] } })).toThrow()
  })
})

describe('removing what a plugin brought', () => {
  const skill = {
    id: 'plugin:p0123456789ab:review',
    name: 'review',
    description: 'Reviews a change.',
    source: 'plugin' as const,
    origin: 'review-kit',
    version: '1.0.0',
    agents: 'all' as const,
    on: true,
  }
  const other = {
    ...skill,
    id: 'github:owner/repo',
    name: 'other',
    source: 'github' as const,
    origin: 'https://github.com/owner/repo',
  }
  const base = mergeSettings(
    DEFAULT_SETTINGS,
    {
      marketplace: { skills: [skill, other] as never },
    },
    { plugins: true },
  )

  it('refuses a remove, or a list without it, from anyone but the plugin service', () => {
    const remove = validateSettingsPatch({ marketplace: { skillsEdit: { remove: [skill.id] } } })
    expect(() => mergeSettings(base, remove)).toThrow(/review/)
    const whole = validateSettingsPatch({ marketplace: { skills: [other] } })
    expect(() => mergeSettings(base, whole)).toThrow(/review/)
  })

  it('lets the plugin service remove it', () => {
    const remove = validateSettingsPatch({ marketplace: { skillsEdit: { remove: [skill.id] } } })
    const next = mergeSettings(base, remove, { plugins: true })
    expect(next.marketplace.skills.map((item) => item.id)).toEqual([other.id])
  })

  it('still lets anyone turn it off and remove other skills', () => {
    const off = validateSettingsPatch({
      marketplace: { skillsEdit: { put: [{ ...skill, on: false }], remove: [other.id] } },
    })
    const next = mergeSettings(base, off)
    expect(next.marketplace.skills).toEqual([{ ...skill, on: false }])
  })

  it('lets anyone choose its agents, in an edit and in a whole list', () => {
    const edit = validateSettingsPatch({
      marketplace: { skillsEdit: { put: [{ ...skill, agents: ['codex'] }] } },
    })
    expect(mergeSettings(base, edit).marketplace.skills[0]).toEqual({
      ...skill,
      agents: ['codex'],
    })
    const whole = validateSettingsPatch({
      marketplace: { skills: [{ ...skill, on: false, agents: ['codex'] }, other] },
    })
    expect(mergeSettings(base, whole).marketplace.skills[0]).toEqual({
      ...skill,
      on: false,
      agents: ['codex'],
    })
  })

  it('takes nothing else of it from anyone but the plugin service', () => {
    const edit = validateSettingsPatch({
      marketplace: {
        skillsEdit: { put: [{ ...skill, description: 'Other.', version: '9.9.9', on: false }] },
      },
    })
    expect(mergeSettings(base, edit).marketplace.skills[0]).toEqual({ ...skill, on: false })
    expect(mergeSettings(base, edit, { plugins: true }).marketplace.skills[0]).toMatchObject({
      description: 'Other.',
      version: '9.9.9',
    })
  })

  it('refuses to add one, but for the plugin service', () => {
    const added = { ...skill, id: 'plugin:p0123456789ab:audit', name: 'audit' }
    const add = validateSettingsPatch({ marketplace: { skillsEdit: { put: [added] } } })
    expect(() => mergeSettings(base, add)).toThrow(/audit/)
    expect(
      mergeSettings(base, add, { plugins: true }).marketplace.skills.map((i) => i.id),
    ).toContain(added.id)
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

  it('keeps how a server runs, and refuses a mode or a time it does not know', () => {
    const run = { mode: 'folder', idleMinutes: 30, startSeconds: 60 }
    expect(validateSettingsPatch({ marketplace: { mcp: [{ ...server, run }] } })).toEqual({
      marketplace: { mcp: [{ ...server, run }] },
    })
    const bad = (value: unknown) => () =>
      validateSettingsPatch({ marketplace: { mcp: [{ ...server, run: value }] } })
    expect(bad({ mode: 'shared' })).toThrow()
    expect(bad({ idleMinutes: 0 })).toThrow()
    expect(bad({ idleMinutes: 2.5 })).toThrow()
    expect(bad({ startSeconds: 601 })).toThrow()
    expect(bad({ mode: 'session', extra: true })).toThrow()
  })

  it('reads how a server runs from the file, dropping a key it does not know', async () => {
    const run = { mode: 'agent', idleMinutes: 5, later: 1 }
    await save({ version: 1, marketplace: { mcp: [{ ...server, run }], skills: [] } })
    const store = await SettingsStore.load(dir)
    expect(store.get().marketplace.mcp[0]?.run).toEqual({ mode: 'agent', idleMinutes: 5 })
  })

  it('stores no run settings for a server that keeps every default', async () => {
    await save({ version: 1, marketplace: { mcp: [{ ...server, run: {} }], skills: [] } })
    const store = await SettingsStore.load(dir)
    expect(store.get().marketplace.mcp[0]).not.toHaveProperty('run')
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

describe('edits to the servers and skills Kettu keeps', () => {
  const server = (id: string, name = id, over: Record<string, unknown> = {}) => ({
    id: `kettu:${id.padEnd(10, 'x')}`,
    name,
    title: name,
    source: 'kettu',
    version: '1.0.0',
    spec: { type: 'stdio', command: 'npx', args: ['-y', `${name}@1.0.0`], env: [] },
    agents: 'all',
    on: true,
    ...over,
  })
  const skill = (id: string, name = id) => ({
    id: `kettu:${id.padEnd(10, 'x')}`,
    name,
    description: 'A skill.',
    source: 'kettu',
    origin: `@amigoer/${name}`,
    version: '1.0.0',
    agents: 'all',
    on: true,
  })
  const names = (list: { name: string }[]) => list.map((item) => item.name)

  it('adds each server to the list the host holds, not the one its sender read', async () => {
    const store = await SettingsStore.load(dir)
    store.update({ marketplace: { mcp: [server('first')] } })
    // Two installs that began from a list holding only the first server.
    store.update({ marketplace: { mcpEdit: { put: [server('second')] } } })
    store.update({ marketplace: { mcpEdit: { put: [server('third')] } } })
    expect(names(store.get().marketplace.mcp)).toEqual(['first', 'second', 'third'])
  })

  it('adds each skill to the list the host holds', async () => {
    const store = await SettingsStore.load(dir)
    store.update({ marketplace: { skillsEdit: { put: [skill('one')] } } })
    store.update({ marketplace: { skillsEdit: { put: [skill('two')] } } })
    expect(names(store.get().marketplace.skills)).toEqual(['one', 'two'])
  })

  it('replaces an entry in place by its id and removes by id', async () => {
    const store = await SettingsStore.load(dir)
    store.update({
      marketplace: { mcp: [server('first'), server('second'), server('third')] },
    })
    store.update({
      marketplace: { mcpEdit: { put: [server('second', 'second', { on: false })] } },
    })
    expect(store.get().marketplace.mcp.map((s) => [s.name, s.on])).toEqual([
      ['first', true],
      ['second', false],
      ['third', true],
    ])
    store.update({ marketplace: { mcpEdit: { remove: [server('first').id, 'kettu:gone'] } } })
    expect(names(store.get().marketplace.mcp)).toEqual(['second', 'third'])
  })

  it('refuses an edit that repeats another entry’s name and changes nothing', async () => {
    const store = await SettingsStore.load(dir)
    store.update({ marketplace: { mcp: [server('first', 'notes')] } })
    expect(() =>
      store.update({ marketplace: { mcpEdit: { put: [server('second', 'notes')] } } }),
    ).toThrow(/repeats/)
    expect(names(store.get().marketplace.mcp)).toEqual(['notes'])
    store.update({ marketplace: { skillsEdit: { put: [skill('one', 'greeter')] } } })
    expect(() =>
      store.update({ marketplace: { skillsEdit: { put: [skill('two', 'greeter')] } } }),
    ).toThrow(/repeats/)
    expect(names(store.get().marketplace.skills)).toEqual(['greeter'])
  })

  it('still takes a whole list from a client that sends one', async () => {
    const store = await SettingsStore.load(dir)
    store.update({ marketplace: { mcp: [server('first'), server('second')] } })
    store.update({ marketplace: { mcp: [server('third')] } })
    expect(names(store.get().marketplace.mcp)).toEqual(['third'])
  })

  it('checks the entries and ids an edit carries', () => {
    expect(() =>
      validateSettingsPatch({ marketplace: { mcpEdit: { put: [{ ...server('a'), id: 'x' }] } } }),
    ).toThrow()
    expect(() =>
      validateSettingsPatch({ marketplace: { mcpEdit: { put: [server('a'), server('a')] } } }),
    ).toThrow(/repeats/)
    expect(() => validateSettingsPatch({ marketplace: { mcpEdit: { remove: [3] } } })).toThrow()
    expect(() => validateSettingsPatch({ marketplace: { mcpEdit: { drop: [] } } })).toThrow()
    expect(() => validateSettingsPatch({ marketplace: { skillsEdit: 'all' } })).toThrow()
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
      idleAgentMinutes: 10,
    })
    for (const bad of ['', ' padded ', 'A", evil', "A'; x", 'A\nB', 'a{b}', 7, 'x'.repeat(101)]) {
      await save({ version: 1, terminal: { fontSize: 14, fontFamily: bad } })
      expect((await SettingsStore.load(dir)).get().terminal).toEqual({
        fontSize: 14,
        idleAgentMinutes: 10,
      })
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

// Huli: Settings › Terminal › Close idle agent terminals.
describe('closing idle agent terminals', () => {
  it('is on at ten minutes until the file says otherwise, and keeps a stored choice', async () => {
    expect((await SettingsStore.load(dir)).get().terminal.idleAgentMinutes).toBe(10)
    await save({ version: 1, terminal: { fontSize: 13, idleAgentMinutes: 0 } })
    expect((await SettingsStore.load(dir)).get().terminal.idleAgentMinutes).toBe(0)
    for (const bad of [7, '10', -5, null, 10.5]) {
      await save({ version: 1, terminal: { fontSize: 13, idleAgentMinutes: bad } })
      expect((await SettingsStore.load(dir)).get().terminal.idleAgentMinutes).toBe(10)
    }
  })

  it('takes only the offered choices in a change', () => {
    for (const minutes of [0, 5, 10, 30]) {
      expect(validateSettingsPatch({ terminal: { idleAgentMinutes: minutes } })).toEqual({
        terminal: { idleAgentMinutes: minutes },
      })
    }
    for (const bad of [1, 60, '5', null, true, -10]) {
      expect(() => validateSettingsPatch({ terminal: { idleAgentMinutes: bad } })).toThrow()
    }
  })

  it("is the host's, which its terminal host receives", () => {
    const next = mergeSettings(DEFAULT_SETTINGS, { terminal: { idleAgentMinutes: 30 } })
    expect(next.terminal.idleAgentMinutes).toBe(30)
    expect(terminalSettings(next).idleAgentMinutes).toBe(30)
    const { host, client } = splitSettingsPatch({
      terminal: { idleAgentMinutes: 5, fontFamily: 'Menlo' },
    })
    expect(host).toEqual({ terminal: { idleAgentMinutes: 5 } })
    expect(client).toEqual({ terminal: { fontFamily: 'Menlo' } })
  })
})

// Huli: Kite's own plan limit alerts' switch became Kettu's `planLimits`.
describe('the plan limit alerts switch', () => {
  it('keeps the choice a file made under the old name', async () => {
    await save({ version: 1, notifications: { limits: false } })
    const store = await SettingsStore.load(dir)
    expect(store.get().notifications.planLimits).toBe(false)
    expect('limits' in store.get().notifications).toBe(false)
  })

  it('lets the new name win when a file has both', async () => {
    await save({ version: 1, notifications: { limits: false, planLimits: true } })
    expect((await SettingsStore.load(dir)).get().notifications.planLimits).toBe(true)
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

describe('manager mode settings', () => {
  const writer = {
    id: 'w-0a1b2c3d',
    name: '写手',
    role: 'implement',
    agentId: 'codex',
    model: null,
    effort: null,
    profileId: null,
    mode: null,
    worktree: false,
    persona: '',
  }
  const manager = { ...DEFAULT_SETTINGS.manager, workers: [writer], approvals: 'low' }

  it('takes a valid roster whole and sends it to the host', () => {
    const patch = validateSettingsPatch({ manager })
    const next = mergeSettings(DEFAULT_SETTINGS, patch)
    expect(next.manager).toEqual(manager)
    expect(hostSettings(next, 'en').manager).toEqual(manager)
  })

  it('refuses a roster with problems, changing nothing', () => {
    expect(() =>
      validateSettingsPatch({ manager: { ...manager, workers: [writer, writer] } }),
    ).toThrow(/repeats/)
    expect(() =>
      validateSettingsPatch({ manager: { ...manager, limits: { concurrent: 3 } } }),
    ).toThrow()
    expect(() => validateSettingsPatch({ manager: { workers: [] } })).toThrow(/needs/)
  })

  it('reads a stored roster, dropping entries that do not validate', async () => {
    await save({ version: 1, manager: { ...manager, workers: [writer, { name: 'x' }] } })
    expect((await SettingsStore.load(dir)).get().manager.workers).toEqual([writer])
  })
})

describe('the feature switches', () => {
  // Every feature on, but those that download a program and so wait for the user's yes.
  const allOn = { ...DEFAULT_FEATURES }

  it('are on for a file from before them, but those that start off, and reach the host', async () => {
    expect(Object.keys(allOn).sort()).toEqual([...FEATURE_IDS].sort())
    expect(Object.entries(allOn).filter(([, on]) => !on)).toEqual([['webReader', false]])
    await save({ version: 1, general: { language: 'en' } })
    const settings = (await SettingsStore.load(dir)).get()
    expect(settings.features).toEqual(allOn)
    expect(hostSettings(settings, 'en').features).toEqual(allOn)
  })

  it('keep a stored off and drop unknown features and values that are no boolean', async () => {
    await save({ version: 1, features: { board: false, routines: 'off', gone: false } })
    const settings = (await SettingsStore.load(dir)).get()
    expect(settings.features).toEqual({ ...allOn, board: false })
    expect('gone' in settings.features).toBe(false)
  })

  it('take only known features and booleans in a change, merged key by key', () => {
    const off = mergeSettings(
      DEFAULT_SETTINGS,
      validateSettingsPatch({ features: { manager: false, devices: false } }),
    )
    const back = mergeSettings(off, validateSettingsPatch({ features: { devices: true } }))
    expect(back.features).toEqual({ ...allOn, manager: false })
    expect(hostSettings(back, 'en').features).toEqual({ ...allOn, manager: false })
    for (const features of [{ nope: false }, { board: 'false' }, { board: null }, []]) {
      expect(() => validateSettingsPatch({ features })).toThrow()
    }
  })

  it('stay with this computer, never changed by a paired device', () => {
    const { host, client } = splitSettingsPatch({ features: { board: false } })
    expect(host).toBeNull()
    expect(client).toEqual({ features: { board: false } })
  })

  it('refuse to hide the sandbox while new sessions start in one', () => {
    const contained = mergeSettings(DEFAULT_SETTINGS, { sandbox: { tier: 'container' } })
    expect(() => mergeSettings(contained, { features: { sandbox: false } })).toThrow(
      'features.sandbox',
    )
    const hidden = mergeSettings(DEFAULT_SETTINGS, { features: { sandbox: false } })
    expect(hidden.features.sandbox).toBe(false)
    expect(() => mergeSettings(hidden, { sandbox: { tier: 'native' } })).toThrow('features.sandbox')
    expect(mergeSettings(hidden, { sandbox: { network: 'open' } }).sandbox.network).toBe('open')
    expect(
      mergeSettings(contained, { features: { sandbox: false }, sandbox: { tier: 'off' } }).features
        .sandbox,
    ).toBe(false)
  })
})

describe('the fonts the user picks', () => {
  it('keeps the theme’s faces until one is named', async () => {
    const store = await SettingsStore.load(dir)
    expect(store.get().appearance.fonts).toEqual({})
  })

  it('keeps stored faces and drops a set that could break out of a font stack on load', async () => {
    const fonts = {
      ui: 'Segoe UI',
      uiCjk: 'PingFang SC',
      prose: 'Source Serif 4',
      proseCjk: '思源宋体 CN',
      code: 'Maple Mono NF CN',
      codeCjk: 'LXGW WenKai',
    }
    await save({ version: 1, appearance: { fonts } })
    expect((await SettingsStore.load(dir)).get().appearance.fonts).toEqual(fonts)
    for (const bad of [
      { code: 'A", evil' },
      { ui: '' },
      { uiCjk: '' },
      { prose: "A'; x" },
      { proseCjk: 'A", evil' },
      { code: 7 },
      { codeCjk: 7 },
      { heading: 'Inter' },
      { headingCjk: 'PingFang SC' },
      ['Inter'],
      'Inter',
      null,
    ]) {
      await save({ version: 1, appearance: { fonts: bad } })
      expect((await SettingsStore.load(dir)).get().appearance.fonts).toEqual({})
    }
  })

  it('takes a set of face names in a change and refuses the rest', () => {
    expect(
      validateSettingsPatch({
        appearance: { fonts: { code: 'Maple Mono NF CN', codeCjk: 'LXGW WenKai' } },
      }),
    ).toEqual({
      appearance: { fonts: { code: 'Maple Mono NF CN', codeCjk: 'LXGW WenKai' } },
    })
    expect(validateSettingsPatch({ appearance: { fonts: { uiCjk: 'PingFang SC' } } })).toEqual({
      appearance: { fonts: { uiCjk: 'PingFang SC' } },
    })
    expect(validateSettingsPatch({ appearance: { fonts: {} } })).toEqual({
      appearance: { fonts: {} },
    })
    for (const bad of [
      { code: 'A, B' },
      { codeCjk: 'A, B' },
      { ui: 'url(x)' },
      { uiCjk: 'url(x)' },
      { prose: null },
      { proseCjk: null },
      { mono: 'Menlo' },
      { monoCjk: 'PingFang SC' },
      null,
      'Menlo',
    ]) {
      expect(() => validateSettingsPatch({ appearance: { fonts: bad } })).toThrow()
    }
  })

  it('replaces the whole set in a change and clears optional Chinese fonts independently', () => {
    const both = mergeSettings(DEFAULT_SETTINGS, {
      appearance: { fonts: { ui: 'Segoe UI', uiCjk: 'PingFang SC', code: 'Menlo' } },
    })
    expect(both.appearance.fonts).toEqual({ ui: 'Segoe UI', uiCjk: 'PingFang SC', code: 'Menlo' })
    const clearedCjk = mergeSettings(both, {
      appearance: { fonts: { ui: 'Segoe UI', code: 'Menlo' } },
    })
    expect(clearedCjk.appearance.fonts).toEqual({ ui: 'Segoe UI', code: 'Menlo' })
    const one = mergeSettings(clearedCjk, { appearance: { fonts: { code: 'Menlo' } } })
    expect(one.appearance.fonts).toEqual({ code: 'Menlo' })
  })

  it('stays with the window that draws them, never on the host', () => {
    const { host, client } = splitSettingsPatch({
      appearance: { fonts: { code: 'Menlo', codeCjk: 'LXGW WenKai' } },
    })
    expect(host).toBeNull()
    expect(client).toEqual({ appearance: { fonts: { code: 'Menlo', codeCjk: 'LXGW WenKai' } } })
  })
})

describe('the pages the sidebar lists', () => {
  const ALL = ['overview', 'artifacts', 'routines', 'marketplace', 'usage']

  it('shows every page in its default order until the user changes them', async () => {
    const { appearance } = (await SettingsStore.load(dir)).get()
    expect(appearance.sidebarOrder).toEqual(ALL)
    expect(appearance.sidebarHidden).toEqual([])
  })

  it('keeps a stored order and hidden pages on load', async () => {
    const order = ['usage', 'marketplace', 'overview', 'routines', 'artifacts']
    await save({ version: 1, appearance: { sidebarOrder: order, sidebarHidden: ['usage'] } })
    const { appearance } = (await SettingsStore.load(dir)).get()
    expect(appearance.sidebarOrder).toEqual(order)
    expect(appearance.sidebarHidden).toEqual(['usage'])
  })

  it('drops unknown and repeated pages and puts a missing one at its default place', async () => {
    await save({
      version: 1,
      appearance: {
        sidebarOrder: ['usage', 'later-page', 'overview', 'usage', 7, 'routines', 'marketplace'],
        sidebarHidden: ['routines', 'later-page', 'routines', null],
      },
    })
    const { appearance } = (await SettingsStore.load(dir)).get()
    expect(appearance.sidebarOrder).toEqual([
      'usage',
      'overview',
      'artifacts',
      'routines',
      'marketplace',
    ])
    expect(appearance.sidebarHidden).toEqual(['routines'])
  })

  it('places pages missing before every kept one at the start', async () => {
    await save({ version: 1, appearance: { sidebarOrder: ['marketplace', 'usage'] } })
    expect((await SettingsStore.load(dir)).get().appearance.sidebarOrder).toEqual(ALL)
  })

  it('goes back to the defaults for a value that is not a list', async () => {
    for (const bad of ['usage', { usage: true }, null, 3]) {
      await save({ version: 1, appearance: { sidebarOrder: bad, sidebarHidden: bad } })
      const { appearance } = (await SettingsStore.load(dir)).get()
      expect(appearance.sidebarOrder).toEqual(ALL)
      expect(appearance.sidebarHidden).toEqual([])
    }
  })

  it('takes an order of every page once and hidden pages in a change', () => {
    const order = ['routines', 'overview', 'usage', 'artifacts', 'marketplace']
    expect(
      validateSettingsPatch({ appearance: { sidebarOrder: order, sidebarHidden: ['overview'] } }),
    ).toEqual({ appearance: { sidebarOrder: order, sidebarHidden: ['overview'] } })
    expect(validateSettingsPatch({ appearance: { sidebarHidden: ALL } })).toEqual({
      appearance: { sidebarHidden: ALL },
    })
    expect(validateSettingsPatch({ appearance: { sidebarHidden: [] } })).toEqual({
      appearance: { sidebarHidden: [] },
    })
  })

  it('refuses an order that leaves out, repeats or adds a page', () => {
    for (const bad of [
      ['overview', 'artifacts', 'routines', 'marketplace'],
      ['overview', 'artifacts', 'routines', 'marketplace', 'usage', 'usage'],
      ['overview', 'artifacts', 'routines', 'marketplace', 'newSession'],
      ['overview', 'artifacts', 'routines', 'marketplace', 'usage', 'later-page'],
      'overview',
      null,
    ]) {
      expect(() => validateSettingsPatch({ appearance: { sidebarOrder: bad } })).toThrow()
    }
  })

  it('refuses hidden pages that repeat or name what the sidebar cannot hide', () => {
    for (const bad of [['usage', 'usage'], ['newSession'], ['later-page'], [3], 'usage', null]) {
      expect(() => validateSettingsPatch({ appearance: { sidebarHidden: bad } })).toThrow()
    }
  })

  it('replaces each list whole in a change', () => {
    const hidden = mergeSettings(DEFAULT_SETTINGS, {
      appearance: { sidebarHidden: ['usage', 'overview'] },
    })
    expect(hidden.appearance.sidebarHidden).toEqual(['usage', 'overview'])
    const shown = mergeSettings(hidden, { appearance: { sidebarHidden: ['overview'] } })
    expect(shown.appearance.sidebarHidden).toEqual(['overview'])
    expect(shown.appearance.sidebarOrder).toEqual(ALL)
  })
})

describe("Huli: the keyboard's settings from the renderer", () => {
  it('takes rebound shortcuts and a global screenshot hotkey', () => {
    const patch = {
      keyboard: { shortcuts: { searchSessions: 'Mod+Shift+K' }, screenshot: 'Mod+Shift+S' },
    }
    expect(validateSettingsPatch(patch)).toEqual(patch)
    expect(validateSettingsPatch({ keyboard: { screenshot: null } })).toEqual({
      keyboard: { screenshot: null },
    })
  })

  it.each([
    ['an unknown shortcut', { shortcuts: { deleteEverything: 'Mod+Shift+D' } }],
    ['keys another shortcut has', { shortcuts: { searchSessions: 'Mod+N' } }],
    ['two rebound to the same keys', { shortcuts: { addFiles: 'Mod+I', addMenu: 'Mod+I' } }],
    ['keys the app keeps', { shortcuts: { searchSessions: 'Mod+C' } }],
    ['a key without a modifier', { shortcuts: { searchSessions: 'K' } }],
    ['keys that are no keys', { shortcuts: { searchSessions: 'Mod+Banana' } }],
    ['keys that are no text', { shortcuts: { searchSessions: 7 } }],
    ['a screenshot hotkey with one modifier', { screenshot: 'Mod+S' }],
    ['a screenshot hotkey that is no text', { screenshot: true }],
  ])('refuses %s', (_, keyboard) => {
    expect(() => validateSettingsPatch({ keyboard })).toThrow()
  })
})

describe('the relay a host uses', () => {
  const own = { url: 'https://relay.example.com', pin: null }

  it('reads a file from before the own relay, whose relay is a switch', async () => {
    await save({ version: 1, remote: { relay: true } })
    expect((await SettingsStore.load(dir)).get().remote.relay).toBe('kettu')
    await save({ version: 1, remote: { relay: false } })
    expect((await SettingsStore.load(dir)).get().remote.relay).toBe('off')
  })

  it('keeps the own relay with its address, and goes without a relay without one', async () => {
    await save({ version: 1, remote: { relay: 'own', ownRelay: own } })
    expect((await SettingsStore.load(dir)).get().remote).toMatchObject({
      relay: 'own',
      ownRelay: own,
    })
    await save({ version: 1, remote: { relay: 'own' } })
    expect((await SettingsStore.load(dir)).get().remote.relay).toBe('off')
    // Kettu's (Huli Cloud's) address or plain http to another computer is never kept as the
    // owner's relay.
    for (const url of [RELAY_URL, 'http://203.0.113.7:8080']) {
      await save({ version: 1, remote: { relay: 'own', ownRelay: { url, pin: null } } })
      expect((await SettingsStore.load(dir)).get().remote).toMatchObject({
        relay: 'off',
        ownRelay: null,
      })
    }
  })

  it('takes the switch of older clients and the choice in a change', () => {
    const before = structuredClone(DEFAULT_SETTINGS)
    expect(
      mergeSettings(before, validateSettingsPatch({ remote: { relay: false } })).remote.relay,
    ).toBe('off')
    expect(
      mergeSettings(before, validateSettingsPatch({ remote: { relay: true } })).remote.relay,
    ).toBe('kettu')
    expect(() => validateSettingsPatch({ remote: { relay: 'elsewhere' } })).toThrow()
    // The own relay is chosen only once its check passed, which gives it its address.
    expect(() =>
      mergeSettings(before, validateSettingsPatch({ remote: { relay: 'own' } })),
    ).toThrow()
    expect(() => validateSettingsPatch({ remote: { ownRelay: own } })).toThrow()
    const checked = withOwnRelay(before, own)
    expect(checked.remote).toMatchObject({ relay: 'own', ownRelay: own })
    expect(
      mergeSettings(checked, validateSettingsPatch({ remote: { relay: 'kettu' } })).remote,
    ).toMatchObject({ relay: 'kettu', ownRelay: own })
    expect(() => withOwnRelay(before, { url: RELAY_URL, pin: null })).toThrow()
  })

  it('holds direct connections on with no relay, and frees them on the own relay', () => {
    const on = structuredClone(DEFAULT_SETTINGS)
    on.remote.enabled = true
    on.remote.direct.enabled = false
    expect(effectiveDirect({ ...on, remote: { ...on.remote, relay: 'off' } }, true).enabled).toBe(
      true,
    )
    expect(
      effectiveDirect({ ...on, remote: { ...on.remote, relay: 'kettu' } }, false).enabled,
    ).toBe(true)
    expect(
      effectiveDirect({ ...on, remote: { ...on.remote, relay: 'own', ownRelay: own } }, false)
        .enabled,
    ).toBe(false)
  })

  it('tells older clients a switch and newer ones the choice', () => {
    const file = withOwnRelay(structuredClone(DEFAULT_SETTINGS), own)
    const part = hostSettingsPart(file)
    expect(part.remote).toMatchObject({ relay: false, relayChoice: 'own', ownRelay: own })
    expect(withHostSettings(structuredClone(DEFAULT_SETTINGS), part).remote).toMatchObject({
      relay: 'own',
      ownRelay: own,
    })
    // A host from before sends its switch alone.
    const older = { ...part, remote: { ...part.remote, relay: true } }
    delete (older.remote as { relayChoice?: unknown }).relayChoice
    delete (older.remote as { ownRelay?: unknown }).ownRelay
    expect(withHostSettings(structuredClone(DEFAULT_SETTINGS), older).remote).toMatchObject({
      relay: 'kettu',
      ownRelay: null,
    })
  })
})

describe('sending while a turn is running', () => {
  it('queues by default and keeps a valid choice on load', async () => {
    expect((await SettingsStore.load(dir)).get().general.runningSend).toBe('queue')
    for (const choice of ['queue', 'steer'] as const) {
      await save({ version: 1, general: { runningSend: choice } })
      expect((await SettingsStore.load(dir)).get().general.runningSend).toBe(choice)
    }
    for (const bad of ['now', '', true, null, 1]) {
      await save({ version: 1, general: { runningSend: bad } })
      expect((await SettingsStore.load(dir)).get().general.runningSend).toBe('queue')
    }
  })

  it('accepts queue or steer in a change, refuses the rest, and keeps it on the client', () => {
    const patch = validateSettingsPatch({ general: { runningSend: 'steer' } })
    expect(patch).toEqual({ general: { runningSend: 'steer' } })
    const next = mergeSettings(DEFAULT_SETTINGS, patch)
    expect(next.general.runningSend).toBe('steer')
    expect(splitSettingsPatch(patch)).toEqual({ host: null, client: patch })
    expect(withHostSettings(next, hostSettingsPart(DEFAULT_SETTINGS)).general.runningSend).toBe(
      'steer',
    )
    for (const bad of ['now', '', false, null, 0]) {
      expect(() => validateSettingsPatch({ general: { runningSend: bad } })).toThrow()
    }
  })
})

describe('closing the side panel with its last tab', () => {
  it('defaults to false and keeps a stored boolean on load', async () => {
    expect((await SettingsStore.load(dir)).get().appearance.closeSidePanelWithLastTab).toBe(false)
    await save({ version: 1, appearance: { closeSidePanelWithLastTab: true } })
    expect((await SettingsStore.load(dir)).get().appearance.closeSidePanelWithLastTab).toBe(true)
    await save({ version: 1, appearance: { closeSidePanelWithLastTab: false } })
    expect((await SettingsStore.load(dir)).get().appearance.closeSidePanelWithLastTab).toBe(false)
    for (const bad of ['yes', 1, null, {}]) {
      await save({ version: 1, appearance: { closeSidePanelWithLastTab: bad } })
      expect((await SettingsStore.load(dir)).get().appearance.closeSidePanelWithLastTab).toBe(false)
    }
  })

  it('validates, merges, persists and keeps the setting on the client', async () => {
    const patch = validateSettingsPatch({ appearance: { closeSidePanelWithLastTab: true } })
    expect(patch).toEqual({ appearance: { closeSidePanelWithLastTab: true } })
    const next = mergeSettings(DEFAULT_SETTINGS, patch)
    expect(next.appearance.closeSidePanelWithLastTab).toBe(true)
    expect(splitSettingsPatch(patch)).toEqual({ host: null, client: patch })
    expect(
      withHostSettings(next, hostSettingsPart(DEFAULT_SETTINGS)).appearance
        .closeSidePanelWithLastTab,
    ).toBe(true)

    const store = await SettingsStore.load(dir)
    store.update(patch)
    await store.flush()
    expect((await SettingsStore.load(dir)).get().appearance.closeSidePanelWithLastTab).toBe(true)

    for (const bad of ['true', 1, null, []]) {
      expect(() =>
        validateSettingsPatch({ appearance: { closeSidePanelWithLastTab: bad } }),
      ).toThrow()
    }
  })
})

describe('selectable desktop app icon', () => {
  it('defaults to kettu, accepts all six icons and legacy default alias, and falls back on invalid values', async () => {
    expect((await SettingsStore.load(dir)).get().appearance.appIcon).toBe('kettu')
    for (const icon of APP_ICONS) {
      await save({ version: 1, appearance: { appIcon: icon } })
      expect((await SettingsStore.load(dir)).get().appearance.appIcon).toBe(icon)
    }
    await save({ version: 1, appearance: { appIcon: 'default' } })
    expect((await SettingsStore.load(dir)).get().appearance.appIcon).toBe('kettu')
    for (const bad of ['unknown', '', 42, null, {}]) {
      await save({ version: 1, appearance: { appIcon: bad } })
      expect((await SettingsStore.load(dir)).get().appearance.appIcon).toBe('kettu')
    }
  })

  it('validates, normalizes, merges, persists and keeps the app icon on the client', async () => {
    const patch = validateSettingsPatch({ appearance: { appIcon: 'ink-sheets' } })
    expect(patch).toEqual({ appearance: { appIcon: 'ink-sheets' } })
    const next = mergeSettings(DEFAULT_SETTINGS, patch)
    expect(next.appearance.appIcon).toBe('ink-sheets')
    expect(splitSettingsPatch(patch)).toEqual({ host: null, client: patch })
    expect(withHostSettings(next, hostSettingsPart(DEFAULT_SETTINGS)).appearance.appIcon).toBe(
      'ink-sheets',
    )

    const legacyPatch = validateSettingsPatch({ appearance: { appIcon: 'default' } })
    expect(mergeSettings(next, legacyPatch).appearance.appIcon).toBe('kettu')

    const store = await SettingsStore.load(dir)
    store.update(patch)
    await store.flush()
    expect((await SettingsStore.load(dir)).get().appearance.appIcon).toBe('ink-sheets')

    for (const bad of ['blue', '', 0, null, []]) {
      expect(() => validateSettingsPatch({ appearance: { appIcon: bad } })).toThrow()
    }
  })
})

describe('prompt cache drop notice setting', () => {
  it('defaults to false, loads stored booleans, and falls back to false on invalid values', async () => {
    expect((await SettingsStore.load(dir)).get().thread.promptCacheDropNotice).toBe(false)
    await save({ version: 1, thread: { promptCacheDropNotice: true } })
    expect((await SettingsStore.load(dir)).get().thread.promptCacheDropNotice).toBe(true)
    await save({ version: 1, thread: { promptCacheDropNotice: false } })
    expect((await SettingsStore.load(dir)).get().thread.promptCacheDropNotice).toBe(false)
    for (const bad of ['yes', 1, null, {}]) {
      await save({ version: 1, thread: { promptCacheDropNotice: bad } })
      expect((await SettingsStore.load(dir)).get().thread.promptCacheDropNotice).toBe(false)
    }
  })

  it('validates, merges, persists and keeps the setting on the client', async () => {
    const patch = validateSettingsPatch({ thread: { promptCacheDropNotice: true } })
    expect(patch).toEqual({ thread: { promptCacheDropNotice: true } })
    const next = mergeSettings(DEFAULT_SETTINGS, patch)
    expect(next.thread.promptCacheDropNotice).toBe(true)
    expect(splitSettingsPatch(patch)).toEqual({ host: null, client: patch })
    expect(
      withHostSettings(next, hostSettingsPart(DEFAULT_SETTINGS)).thread.promptCacheDropNotice,
    ).toBe(true)

    const store = await SettingsStore.load(dir)
    store.update(patch)
    await store.flush()
    expect((await SettingsStore.load(dir)).get().thread.promptCacheDropNotice).toBe(true)

    for (const bad of ['true', 1, null, []]) {
      expect(() => validateSettingsPatch({ thread: { promptCacheDropNotice: bad } })).toThrow()
    }
  })
})

describe('conversation width preset', () => {
  it('defaults to standard for fresh and legacy files, accepts valid presets, and sanitizes invalid values', async () => {
    expect((await SettingsStore.load(dir)).get().appearance.conversationWidth).toBe('standard')
    await save({ version: 1, appearance: { textSize: 'large' } })
    expect((await SettingsStore.load(dir)).get().appearance.conversationWidth).toBe('standard')

    for (const preset of CONVERSATION_WIDTHS) {
      await save({ version: 1, appearance: { conversationWidth: preset } })
      expect((await SettingsStore.load(dir)).get().appearance.conversationWidth).toBe(preset)
    }
    for (const bad of ['full', 'narrow', '', 1200, null, {}]) {
      await save({ version: 1, appearance: { conversationWidth: bad } })
      expect((await SettingsStore.load(dir)).get().appearance.conversationWidth).toBe('standard')
    }
  })

  it('validates, merges, persists and keeps the preset on the client', async () => {
    const patch = validateSettingsPatch({ appearance: { conversationWidth: 'wide' } })
    expect(patch).toEqual({ appearance: { conversationWidth: 'wide' } })
    const next = mergeSettings(DEFAULT_SETTINGS, patch)
    expect(next.appearance.conversationWidth).toBe('wide')
    expect(splitSettingsPatch(patch)).toEqual({ host: null, client: patch })
    expect(
      withHostSettings(next, hostSettingsPart(DEFAULT_SETTINGS)).appearance.conversationWidth,
    ).toBe('wide')

    const store = await SettingsStore.load(dir)
    store.update(patch)
    await store.flush()
    expect((await SettingsStore.load(dir)).get().appearance.conversationWidth).toBe('wide')

    for (const bad of ['full', 'compact', '', 1088, null, []]) {
      expect(() => validateSettingsPatch({ appearance: { conversationWidth: bad } })).toThrow()
    }
  })
})

describe('code font size setting', () => {
  it('defaults to default for fresh and legacy files, accepts valid presets, and sanitizes invalid values', async () => {
    expect((await SettingsStore.load(dir)).get().appearance.codeSize).toBe('default')
    await save({ version: 1, appearance: { textSize: 'large' } })
    const legacy = (await SettingsStore.load(dir)).get()
    expect(legacy.appearance.textSize).toBe('large')
    expect(legacy.appearance.codeSize).toBe('default')

    for (const preset of CODE_SIZES) {
      await save({ version: 1, appearance: { codeSize: preset } })
      expect((await SettingsStore.load(dir)).get().appearance.codeSize).toBe(preset)
    }
    for (const bad of ['medium', 'xlarge', '', 13, null, {}]) {
      await save({ version: 1, appearance: { codeSize: bad } })
      expect((await SettingsStore.load(dir)).get().appearance.codeSize).toBe('default')
    }
  })

  it('validates, merges, persists and keeps the code size preset on the client', async () => {
    const patch = validateSettingsPatch({ appearance: { codeSize: 'large' } })
    expect(patch).toEqual({ appearance: { codeSize: 'large' } })
    const next = mergeSettings(DEFAULT_SETTINGS, patch)
    expect(next.appearance.codeSize).toBe('large')
    expect(next.appearance.textSize).toBe('default')
    expect(splitSettingsPatch(patch)).toEqual({ host: null, client: patch })
    expect(withHostSettings(next, hostSettingsPart(DEFAULT_SETTINGS)).appearance.codeSize).toBe(
      'large',
    )

    const store = await SettingsStore.load(dir)
    store.update(patch)
    await store.flush()
    expect((await SettingsStore.load(dir)).get().appearance.codeSize).toBe('large')

    for (const bad of ['medium', 'tiny', '', 14, null, []]) {
      expect(() => validateSettingsPatch({ appearance: { codeSize: bad } })).toThrow()
    }
  })
})
