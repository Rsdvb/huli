import { describe, expect, it } from 'vitest'
import {
  COMPACT_SPECS,
  compactChanges,
  compactChoice,
  compactLabel,
  compactSpec,
  compactSteps,
  inCompactRange,
  parseCompactValue,
  trafficPreset,
  TRAFFIC_PRESETS,
} from './auto-compact'
import type { HarnessId } from './thread'

describe('auto-compact values', () => {
  it('reads tokens written with or without K and M, and whole percents', () => {
    expect(parseCompactValue('trigger', '272K')).toBe(272_000)
    expect(parseCompactValue('window', '272k')).toBe(272_000)
    expect(parseCompactValue('window', '272,000')).toBe(272_000)
    expect(parseCompactValue('window', '1.5M')).toBe(1_500_000)
    expect(parseCompactValue('reserve', '16000')).toBe(16_000)
    expect(parseCompactValue('percent', '85%')).toBe(85)
    expect(parseCompactValue('percent', ' 85 ')).toBe(85)
    expect(parseCompactValue('percent', '85.5')).toBeNull()
    expect(parseCompactValue('window', '272 tokens')).toBeNull()
    expect(parseCompactValue('window', '-1')).toBeNull()
  })

  it('writes values short, and offers 272K among the steps in range', () => {
    expect(compactLabel('window', 272_000)).toBe('272K')
    expect(compactLabel('window', 1_000_000)).toBe('1M')
    expect(compactLabel('percent', 55.5)).toBe('55.5%')
    expect(compactSteps(compactSpec('claude-code')!)).toContain(272_000)
    expect(compactSteps(compactSpec('kimi')!)).toEqual([50, 60, 70, 75, 80, 85, 90, 95])
    expect(compactSpec('cline')).toBeNull()
  })
})

describe('省流量', () => {
  it('compacts Claude Code within 256K, and Codex at 220K tokens', () => {
    expect(trafficPreset('claude-code')).toBe(256_000)
    expect(compactSpec('claude-code')!.unit).toBe('window')
    expect(trafficPreset('codex')).toBe(220_000)
    expect(compactSpec('codex')!.unit).toBe('trigger')
    expect(trafficPreset('codebuddy')).toBe(256_000)
  })

  it('takes a value in each harness’s range, and only where the setting is a size in tokens', () => {
    for (const [harness, value] of Object.entries(TRAFFIC_PRESETS)) {
      const spec = compactSpec(harness as HarnessId)!
      expect(inCompactRange(spec, value)).toBe(true)
      expect(['window', 'trigger']).toContain(spec.unit)
    }
    for (const harness of Object.keys(COMPACT_SPECS) as HarnessId[]) {
      const unit = compactSpec(harness)!.unit
      if (unit === 'percent' || unit === 'reserve') expect(trafficPreset(harness)).toBeNull()
    }
    expect(trafficPreset('cline')).toBeNull()
  })

  it('reads nothing set as the default, the preset alone as 省流量, and anything else as custom', () => {
    const none = { all: null, allOther: null, models: null }
    expect(compactChoice('codex', none)).toBe('default')
    expect(compactChoice('codex', { ...none, all: 220_000 })).toBe('traffic')
    expect(compactChoice('codex', { ...none, all: 272_000 })).toBe('custom')
    expect(compactChoice('gemini', { ...none, all: 70 })).toBe('custom')
    const rows = [
      { model: 'claude-opus-5-5', value: null, other: null },
      { model: 'claude-fable-5-2', value: 400_000, other: null },
    ]
    expect(compactChoice('claude-code', { all: 256_000, allOther: null, models: rows })).toBe(
      'custom',
    )
    expect(compactChoice('claude-code', { all: 256_000, allOther: null, models: [rows[0]!] })).toBe(
      'traffic',
    )
    expect(compactChoice('opencode', { all: null, allOther: '15%', models: null })).toBe('custom')
  })

  it('writes each model’s own value away, then the value for all of them', () => {
    const values = {
      all: 500_000,
      allOther: null,
      models: [
        { model: 'claude-opus-5-5', value: null, other: null },
        { model: 'claude-fable-5-2', value: 400_000, other: null },
      ],
    }
    expect(compactChanges('claude-code', values, 'traffic')).toEqual([
      { model: 'claude-fable-5-2', value: null },
      { model: null, value: 256_000 },
    ])
    expect(compactChanges('claude-code', values, 'default')).toEqual([
      { model: 'claude-fable-5-2', value: null },
      { model: null, value: null },
    ])
    // Nothing to write where the setting holds it already.
    expect(
      compactChanges('codex', { all: 220_000, allOther: null, models: null }, 'traffic'),
    ).toEqual([])
    expect(compactChanges('codex', { all: null, allOther: null, models: null }, 'default')).toEqual(
      [],
    )
    // A value the file holds as text goes too.
    expect(
      compactChanges('opencode', { all: null, allOther: '15%', models: null }, 'default'),
    ).toEqual([{ model: null, value: null }])
    expect(compactChanges('gemini', { all: 70, allOther: null, models: null }, 'traffic')).toEqual(
      [],
    )
  })
})
