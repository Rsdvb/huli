import { describe, expect, it } from 'vitest'
import type { AgentOptions } from '@shared/agent-host'
import { configValueFor, type ConfigOption } from '@shared/thread'
import { AgentOptionsStore, parseAgentOptionsFile, type AgentOptionsFile } from './agent-options'
import type { JsonFile } from './storage'

function modelOption(value: string): ConfigOption {
  return {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    value,
    choices: [
      { value: 'default', name: 'Default (recommended)', shownAs: 'opus' },
      { value: 'opus', name: 'Opus 5.5' },
      { value: 'sonnet', name: 'Sonnet 5.5' },
      { value: 'haiku', name: 'Haiku 5.5' },
      { value: 'claude-fable-5-2', name: 'Fable 5.2' },
      { value: 'claude-opus-4-8', name: 'Opus 4.8' },
    ],
  }
}

function store(): { options: AgentOptionsStore; saved: AgentOptionsFile[] } {
  const saved: AgentOptionsFile[] = []
  const file = {
    load: async () => ({ version: 1, agents: {} }),
    save: (data: AgentOptionsFile) => saved.push(structuredClone(data)),
    flush: async () => {},
  } as unknown as JsonFile<AgentOptionsFile>
  const options = new AgentOptionsStore({ file, changed: () => {}, now: () => 1 })
  options.started('claude-code', [modelOption('default')])
  return { options, saved }
}

describe('the models an agent keeps for its model menu', () => {
  it('keeps pins in the order they were pinned and refuses a fifth', () => {
    const { options } = store()
    options.pin('claude-code', 'sonnet', true)
    options.pin('claude-code', 'opus', true)
    options.pin('claude-code', 'sonnet', true)
    expect(options.get('claude-code')?.pinned).toEqual(['sonnet', 'opus'])
    options.pin('claude-code', 'haiku', true)
    options.pin('claude-code', 'claude-fable-5-2', true)
    expect(() => options.pin('claude-code', 'claude-opus-4-8', true)).toThrow(
      expect.objectContaining({ code: 'conflict' }),
    )
    options.pin('claude-code', 'opus', false)
    expect(options.get('claude-code')?.pinned).toEqual(['sonnet', 'haiku', 'claude-fable-5-2'])
  })

  it('drops the pins once none is left, and pins nothing for an agent it has not seen', () => {
    const { options } = store()
    options.pin('claude-code', 'opus', true)
    options.pin('claude-code', 'opus', false)
    expect(options.get('claude-code')).not.toHaveProperty('pinned')
    expect(() => options.pin('codex', 'gpt-6.2-sol', true)).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    )
  })

  it('sets the pins as one ordered list, replacing the ones before, and clears them', () => {
    const { options, saved } = store()
    options.pin('claude-code', 'haiku', true)
    options.setPinned('claude-code', ['sonnet', 'opus', 'claude-fable-5-2'])
    expect(options.get('claude-code')?.pinned).toEqual(['sonnet', 'opus', 'claude-fable-5-2'])
    expect(saved.at(-1)?.agents['claude-code']?.pinned).toEqual([
      'sonnet',
      'opus',
      'claude-fable-5-2',
    ])
    options.setPinned('claude-code', ['claude-fable-5-2', 'sonnet', 'opus'])
    expect(options.get('claude-code')?.pinned).toEqual(['claude-fable-5-2', 'sonnet', 'opus'])
    options.setPinned('claude-code', [])
    expect(options.get('claude-code')).not.toHaveProperty('pinned')
  })

  it('refuses more pins than the menu takes, and pins for an agent it has not seen', () => {
    const { options } = store()
    expect(() =>
      options.setPinned('claude-code', ['opus', 'sonnet', 'haiku', 'claude-fable-5-2', 'x']),
    ).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(options.get('claude-code')).not.toHaveProperty('pinned')
    expect(() => options.setPinned('codex', ['gpt-6.2-sol'])).toThrow(
      expect.objectContaining({ code: 'not_found' }),
    )
  })

  it('keeps the pins in their order across a reload and a fresh list of models', async () => {
    const { options, saved } = store()
    options.setPinned('claude-code', ['haiku', 'opus'])
    options.opened('claude-code', [modelOption('sonnet')])
    options.started('claude-code', [modelOption('default')], '/repo')
    const file = {
      load: async () => saved.at(-1)!,
      save: () => {},
      flush: async () => {},
    } as unknown as JsonFile<AgentOptionsFile>
    const reloaded = new AgentOptionsStore({ file, changed: () => {} })
    await reloaded.load()
    expect(reloaded.get('claude-code')?.pinned).toEqual(['haiku', 'opus'])
  })

  it('puts the model a session is used on first, once, keeping eight', () => {
    const { options } = store()
    for (const model of ['sonnet', 'haiku', 'opus', 'sonnet']) {
      options.used('claude-code', [modelOption(model)])
    }
    expect(options.get('claude-code')?.recent).toEqual(['sonnet', 'opus', 'haiku'])
    for (let i = 0; i < 10; i++) options.used('claude-code', [modelOption(`m${i}`)])
    expect(options.get('claude-code')?.recent).toEqual([
      'm9',
      'm8',
      'm7',
      'm6',
      'm5',
      'm4',
      'm3',
      'm2',
    ])
  })

  it('counts a choice shown as another as that model, and a switch of model as a use', () => {
    const { options } = store()
    options.used('claude-code', [modelOption('default')])
    expect(options.get('claude-code')?.recent).toEqual(['opus'])
    const option = modelOption('haiku')
    options.chose('claude-code', option, 'haiku', [option])
    expect(options.get('claude-code')?.recent).toEqual(['haiku', 'opus'])
  })

  it('writes nothing when the model used is already the latest', () => {
    const { options, saved } = store()
    options.used('claude-code', [modelOption('sonnet')])
    const writes = saved.length
    options.used('claude-code', [modelOption('sonnet')])
    expect(saved).toHaveLength(writes)
  })

  it("keeps a value an agent set as seen levels only, never as the user's choice", () => {
    const { options } = store()
    const option = modelOption('opus')
    options.chose('claude-code', option, 'opus', [option])
    const haiku = modelOption('haiku')
    const level: ConfigOption = {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      value: 'low',
      choices: [{ value: 'low', name: 'Low' }],
    }
    options.seen('claude-code', [haiku, level])
    expect(options.rememberedOf('claude-code')).toEqual({ model: 'opus' })
    expect(options.get('claude-code')?.recent).toEqual(['opus'])
    expect(options.get('claude-code')?.levels.haiku).toEqual(level)
  })

  it('keeps pins and recent models when a new session reports the agent’s options again', () => {
    const { options } = store()
    options.pin('claude-code', 'sonnet', true)
    options.used('claude-code', [modelOption('haiku')])
    options.started('claude-code', [modelOption('default')], '/repo')
    expect(options.get('claude-code')).toMatchObject({ pinned: ['sonnet'], recent: ['haiku'] })
  })
})

// Claude Code's list as a new session gives it, and as a session it resumed on Fable 5.2 does: the
// row of the model the session runs is listed under the full id it runs it by, in the alias's place.
function claudeModels(value: string, fable: 'fable' | 'claude-fable-5-2'): ConfigOption {
  return {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    value,
    choices: [
      {
        value: 'default',
        name: 'Default (recommended)',
        modelId: 'claude-opus-5-5',
        shownAs: 'opus',
      },
      { value: 'opus', name: 'Opus 5.5', modelId: 'claude-opus-5-5' },
      { value: fable, name: 'Fable 5.2', modelId: 'claude-fable-5-2' },
      { value: 'claude-fable-5-1', name: 'Fable 5.1', modelId: 'claude-fable-5-1' },
    ],
  }
}

const EFFORT: ConfigOption = {
  id: 'effort',
  name: 'Effort',
  category: 'thought_level',
  type: 'select',
  value: 'medium',
  choices: ['low', 'medium', 'high', 'xhigh'].map((value) => ({ value, name: value })),
}

const modelOf = (options: AgentOptionsStore): ConfigOption =>
  options.get('claude-code')!.config.find((o) => o.id === 'model')!

function claudeStore(): AgentOptionsStore {
  const file = {
    load: async () => ({ version: 1, agents: {} }),
    save: () => {},
    flush: async () => {},
  } as unknown as JsonFile<AgentOptionsFile>
  return new AgentOptionsStore({ file, changed: () => {}, now: () => 1 })
}

describe('a model the agent lists under its alias or its full id', () => {
  it('keeps a model chosen under its full id listed when the next list names it by its alias', () => {
    const options = claudeStore()
    options.started('claude-code', [claudeModels('default', 'claude-fable-5-2'), EFFORT], '/repo')
    const chosen = claudeModels('claude-fable-5-2', 'claude-fable-5-2')
    const after = [chosen, { ...EFFORT, value: 'xhigh' }]
    options.chose('claude-code', chosen, 'claude-fable-5-2', after)
    options.chose('claude-code', EFFORT, 'xhigh', after)

    options.started('claude-code', [claudeModels('default', 'fable'), EFFORT], '/repo')
    const model = modelOf(options)
    expect(options.rememberedOf('claude-code')).toEqual({
      model: 'claude-fable-5-2',
      effort: 'xhigh',
    })
    expect(configValueFor(model, 'claude-fable-5-2')).toBe('claude-fable-5-2')
    expect(model.choices?.filter((c) => !c.shownAs && c.name === 'Fable 5.2')).toHaveLength(1)
    expect(model.choices?.find((c) => c.value === 'claude-fable-5-2')?.shownAs).toBe('fable')
  })

  it('lists a remembered full id that no list named, as the alias the agent lists now', () => {
    const options = claudeStore()
    options.started('claude-code', [claudeModels('default', 'fable')], '/repo')
    const chosen = claudeModels('claude-fable-5-2', 'claude-fable-5-2')
    options.chose('claude-code', chosen, 'claude-fable-5-2', [chosen])
    // As the owner's file had it: the alias listed, the full id remembered.
    options.started('claude-code', [claudeModels('default', 'fable')], '/repo')
    const listed = modelOf(options).choices?.find((c) => c.value === 'claude-fable-5-2')
    expect(listed).toMatchObject({ name: 'Fable 5.2', shownAs: 'fable' })
  })

  it('keeps both names when a resumed session lists the model by its full id', () => {
    const options = claudeStore()
    options.started('claude-code', [claudeModels('default', 'fable')], '/repo')
    options.opened('claude-code', [claudeModels('claude-fable-5-2', 'claude-fable-5-2')])
    const values = modelOf(options).choices?.map((c) => [c.value, c.shownAs])
    expect(values).toContainEqual(['fable', 'claude-fable-5-2'])
    expect(values).toContainEqual(['claude-fable-5-2', undefined])
    options.started('claude-code', [claudeModels('default', 'fable')], '/repo')
    const again = modelOf(options).choices?.map((c) => [c.value, c.shownAs])
    expect(again).toContainEqual(['fable', undefined])
    expect(again).toContainEqual(['claude-fable-5-2', 'fable'])
  })

  it('counts a model used under either name as one recent model', () => {
    const options = claudeStore()
    options.started('claude-code', [claudeModels('default', 'fable')], '/repo')
    options.used('claude-code', [claudeModels('fable', 'fable')])
    options.used('claude-code', [claudeModels('opus', 'fable')])
    options.used('claude-code', [claudeModels('claude-fable-5-2', 'claude-fable-5-2')])
    expect(options.get('claude-code')?.recent).toEqual(['claude-fable-5-2', 'opus'])
  })

  it('takes no change of the folder default for a model listed under its other name', () => {
    const options = claudeStore()
    options.started('claude-code', [claudeModels('claude-fable-5-2', 'claude-fable-5-2')], '/repo')
    const chosen = claudeModels('opus', 'fable')
    options.chose('claude-code', chosen, 'opus', [chosen])
    const replaced = options.started('claude-code', [claudeModels('fable', 'fable')], '/repo')
    expect(replaced).toEqual([])
    expect(options.rememberedOf('claude-code')).toEqual({ model: 'opus' })
  })
})

describe('the values a session with an API provider profile starts with', () => {
  const kimi: ConfigOption = {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    value: 'kimi-k2',
    choices: [{ value: 'kimi-k2', name: 'kimi-k2' }],
  }

  it("neither replaces nor drops the agent's own remembered model, and keeps its own", () => {
    const { options } = store()
    options.chose('claude-code', modelOption('default'), 'sonnet', [modelOption('sonnet')])
    options.started('claude-code', [modelOption('default')], '/repo')
    expect(options.started('claude-code', [kimi], '/repo', 'kimi')).toEqual([])
    options.chose('claude-code', kimi, 'kimi-k2', [kimi], 'kimi')
    expect(options.rememberedOf('claude-code')).toEqual({ model: 'sonnet' })
    expect(options.rememberedOf('claude-code', 'kimi')).toEqual({ model: 'kimi-k2' })
    expect(modelOf(options).choices).toEqual(modelOption('default').choices)
    // The agent's own next session finds the folder as its own last one left it.
    expect(options.started('claude-code', [modelOption('default')], '/repo')).toEqual([])
    expect(options.rememberedOf('claude-code')).toEqual({ model: 'sonnet' })
  })

  it('keeps the profile values across a reload', async () => {
    const { options, saved } = store()
    options.started('claude-code', [kimi], '/repo', 'kimi')
    options.chose('claude-code', kimi, 'kimi-k2', [kimi], 'kimi')
    const file = {
      load: async () => saved.at(-1)!,
      save: () => {},
      flush: async () => {},
    } as unknown as JsonFile<AgentOptionsFile>
    const reloaded = new AgentOptionsStore({ file, changed: () => {} })
    await reloaded.load()
    expect(reloaded.rememberedOf('claude-code', 'kimi')).toEqual({ model: 'kimi-k2' })
  })
})

describe('parseAgentOptionsFile', () => {
  const entry = (extra: Partial<Record<keyof AgentOptions, unknown>>) => ({
    version: 1,
    agents: {
      codex: {
        config: [modelOption('opus')],
        levels: {},
        remembered: {},
        observedAt: 1,
        ...extra,
      },
    },
  })

  it('keeps the pinned and recent models, each once and within their limits', () => {
    const parsed = parseAgentOptionsFile(
      entry({
        pinned: ['a', 'b', 'a', 7, '', 'c', 'd', 'e'],
        recent: ['x', 'y', 'x', ...Array.from({ length: 12 }, (_, i) => `r${i}`)],
      }),
    )
    if (typeof parsed === 'string') throw new Error(parsed)
    expect(parsed.agents.codex?.pinned).toEqual(['a', 'b', 'c', 'd'])
    expect(parsed.agents.codex?.recent).toEqual(['x', 'y', 'r0', 'r1', 'r2', 'r3', 'r4', 'r5'])
  })

  it('leaves out lists that are not lists or hold no model', () => {
    const parsed = parseAgentOptionsFile(entry({ pinned: 'opus', recent: [null, 3] }))
    if (typeof parsed === 'string') throw new Error(parsed)
    expect(parsed.agents.codex).not.toHaveProperty('pinned')
    expect(parsed.agents.codex).not.toHaveProperty('recent')
  })
})
