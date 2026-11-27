import { describe, expect, it } from 'vitest'
import { buildConfig, rememberAliases, restoreAliases, type SessionChoices } from './config'
import type { ModelInfo } from './sdk'

const MODELS: ModelInfo[] = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Default (recommended)',
    description: 'Opus 5.5 · Best for everyday, complex tasks',
  },
  {
    value: 'opus',
    resolvedModel: 'claude-opus-5-5',
    displayName: 'Opus 5.5',
    description: 'For complex work and everyday tasks',
  },
  {
    value: 'fable',
    resolvedModel: 'claude-fable-5-2',
    displayName: 'Fable 5.2',
    description: 'For your toughest challenges',
  },
  { value: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'Most capable' },
]

const choices = (model: string): SessionChoices => ({
  mode: 'default',
  model,
  effort: 'default',
  fast: false,
  ultracode: 'default',
})

function modelChoices(models: readonly ModelInfo[], model: string) {
  const option = buildConfig(models, choices(model), ['default']).find((o) => o.id === 'model')
  return option?.choices ?? []
}

describe('the model choices of a Claude Code session', () => {
  it('shows a full model id an alias resolves to as that alias', () => {
    const listed = modelChoices(
      [
        ...MODELS,
        {
          value: 'claude-fable-5-2',
          resolvedModel: 'claude-fable-5-2',
          displayName: 'Fable 5.2',
          description: 'For your toughest challenges',
        },
      ],
      'claude-fable-5-2',
    )
    const rows = listed.filter((c) => !c.shownAs)
    expect(rows.filter((c) => c.name === 'Fable 5.2').map((c) => c.value)).toEqual(['fable'])
    expect(listed.find((c) => c.value === 'claude-fable-5-2')?.shownAs).toBe('fable')
  })

  it('shows a settings model left out of the list as the alias that resolves to it', () => {
    const listed = modelChoices(MODELS, 'claude-fable-5-2')
    expect(listed.find((c) => c.value === 'claude-fable-5-2')?.shownAs).toBe('fable')
  })

  it('keeps a full model id no alias resolves to as a row of its own', () => {
    const listed = modelChoices(MODELS, 'claude-fable-5-1')
    expect(listed.find((c) => c.value === 'claude-fable-5-1')?.shownAs).toBeUndefined()
  })

  it('still shows Default as the alias of the same model', () => {
    const listed = modelChoices(MODELS, 'default')
    expect(listed.find((c) => c.value === 'default')?.shownAs).toBe('opus')
    expect(listed.find((c) => c.value === 'opus')?.shownAs).toBeUndefined()
  })
})

// As Claude Code lists them in a session it resumed on Fable 5.2: the alias's row under the full id.
const RESUMED: ModelInfo[] = MODELS.map((model) =>
  model.value === 'fable'
    ? {
        ...model,
        value: 'claude-fable-5-2',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      }
    : model,
)

describe('a model Claude Code lists under the full id its session runs it by', () => {
  const known = (): Map<string, ModelInfo> => {
    const aliases = new Map<string, ModelInfo>()
    rememberAliases(MODELS, aliases)
    return aliases
  }

  it('lists it as the alias an earlier list named it by, with its full id shown as that', () => {
    const models = restoreAliases(RESUMED, known())
    const listed = modelChoices(models, 'claude-fable-5-2')
    expect(listed.filter((c) => !c.shownAs).map((c) => c.value)).toEqual([
      'opus',
      'fable',
      'claude-fable-5-1',
    ])
    expect(listed.find((c) => c.value === 'claude-fable-5-2')).toMatchObject({
      name: 'Fable 5.2',
      shownAs: 'fable',
    })
  })

  it('keeps the levels of the model under either name', () => {
    const models = restoreAliases(RESUMED, known())
    for (const model of ['fable', 'claude-fable-5-2']) {
      const config = buildConfig(models, { ...choices(model), effort: 'xhigh' }, ['default'])
      expect(config.find((o) => o.id === 'effort')?.value).toBe('xhigh')
    }
  })

  it('never names an alias the list leaves out by its bare value', () => {
    const listed = modelChoices(RESUMED, 'fable')
    const fable = listed.find((c) => c.value === 'fable')
    expect(fable?.name).toBe('Fable 5.2')
    expect(fable?.shownAs).toBe('claude-fable-5-2')
    expect(listed.filter((c) => !c.shownAs && c.name === 'Fable 5.2')).toHaveLength(1)
  })

  it('leaves a list alone that names no alias it once had', () => {
    expect(restoreAliases(MODELS, known())).toEqual(MODELS)
    expect(restoreAliases(RESUMED, new Map())).toEqual(RESUMED)
  })
})
