import { describe, expect, it } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { AGENT_THEME_ID, type AgentThemeInstalled, type ThemeSnapshot } from '@shared/theme-palette'
import { BUILTIN_THEME_ID } from '@shared/themes'
import type { ThemeChangeOutcome, ThemeState } from '@shared/thread'
import {
  parseThemeRequest,
  READ_THEME,
  SET_THEME_COLORS,
  StaleThemeUndo,
  ThemeTools,
  type ThemeAnswer,
} from './tools'

const CALLER = { sessionId: 's1', project: '/p' }
const SOLARIZED = { canvas: '#fdf6e3', accent: '#268bd2' }
const NIGHT = { canvas: '#1a1b26', accent: '#7aa2f7' }

function text(result: CallToolResult): string {
  return result.content.map((part) => ('text' in part ? part.text : '')).join('\n')
}

function harness(options: { fullAccess?: boolean } = {}) {
  let snapshot: ThemeSnapshot = {
    chosen: BUILTIN_THEME_ID,
    chosenName: 'Kettu',
    agent: null,
    colorMode: 'system',
  }
  const sets: { agent: AgentThemeInstalled | null; chosen: string }[] = []
  const asked: { from: ThemeState; to: ThemeState }[] = []
  const recorded: { from: ThemeState; to: ThemeState }[] = []
  const settled: ThemeChangeOutcome[] = []
  let answer: (given: ThemeAnswer) => void = () => {}
  const tools = new ThemeTools({
    read: async () => snapshot,
    set: async (agent, chosen) => {
      sets.push({ agent, chosen })
      snapshot = {
        ...snapshot,
        agent,
        chosen,
        chosenName: chosen === BUILTIN_THEME_ID ? 'Kettu' : (agent?.name ?? chosen),
      }
      return snapshot
    },
    fullAccess: () => options.fullAccess === true,
    ask: (_, change) => {
      asked.push(change)
      return { entryId: 'e1', answer: new Promise((resolve) => (answer = resolve)) }
    },
    recorded: (_, change) => {
      recorded.push(change)
      return 'e2'
    },
    settle: (_, __, outcome) => settled.push(outcome),
  })
  return {
    tools,
    sets,
    asked,
    recorded,
    settled,
    answer: (given: ThemeAnswer) => answer(given),
    snapshot: () => snapshot,
    edit: (next: Partial<ThemeSnapshot>) => (snapshot = { ...snapshot, ...next }),
  }
}

describe('set_theme_colors', () => {
  it('changes the colors at once in Full access and records a line to undo', async () => {
    const h = harness({ fullAccess: true })
    const result = await h.tools.call(CALLER, SET_THEME_COLORS, {
      name: 'Solarized',
      light: SOLARIZED,
    })
    expect(result.isError).toBeUndefined()
    expect(h.sets).toEqual([
      { agent: { name: 'Solarized', colors: { light: SOLARIZED } }, chosen: AGENT_THEME_ID },
    ])
    expect(h.recorded).toHaveLength(1)
    expect(h.recorded[0]!.from).toEqual({ theme: BUILTIN_THEME_ID, name: 'Kettu', agent: null })
    await h.tools.undo(h.recorded[0]!)
    expect(h.sets.at(-1)).toEqual({ agent: null, chosen: BUILTIN_THEME_ID })
  })

  it('asks in a card otherwise, and changes nothing until the user applies', async () => {
    const h = harness()
    const call = h.tools.call(CALLER, SET_THEME_COLORS, { dark: NIGHT })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.asked).toHaveLength(1)
    expect(h.sets).toEqual([])
    h.answer({ decision: 'apply' })
    expect(text(await call)).toContain('The user pressed Apply')
    expect(h.sets).toHaveLength(1)
    expect(h.settled).toEqual([{ kind: 'changed' }])
  })

  it('changes nothing when the user keeps the theme', async () => {
    const h = harness()
    const call = h.tools.call(CALLER, SET_THEME_COLORS, { dark: NIGHT })
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.answer({ decision: 'keep' })
    expect(text(await call)).toContain("Don't change")
    expect(h.sets).toEqual([])
  })

  it('keeps the other mode of the agent theme that shows', async () => {
    const h = harness({ fullAccess: true })
    await h.tools.call(CALLER, SET_THEME_COLORS, { name: 'Mine', light: SOLARIZED })
    await h.tools.call(CALLER, SET_THEME_COLORS, { dark: NIGHT })
    expect(h.sets.at(-1)).toEqual({
      agent: { name: 'Mine', colors: { light: SOLARIZED, dark: NIGHT } },
      chosen: AGENT_THEME_ID,
    })
  })

  it('refuses an undo once the theme changed again since', async () => {
    const h = harness({ fullAccess: true })
    await h.tools.call(CALLER, SET_THEME_COLORS, { light: SOLARIZED })
    h.edit({ chosen: 'nord', chosenName: 'Nord' })
    await expect(h.tools.undo(h.recorded[0]!)).rejects.toBeInstanceOf(StaleThemeUndo)
  })

  it('goes back to the built-in theme with reset', async () => {
    const h = harness({ fullAccess: true })
    await h.tools.call(CALLER, SET_THEME_COLORS, { light: SOLARIZED })
    await h.tools.call(CALLER, SET_THEME_COLORS, { reset: true })
    expect(h.sets.at(-1)!.chosen).toBe(BUILTIN_THEME_ID)
    const again = await h.tools.call(CALLER, SET_THEME_COLORS, { reset: true })
    expect(text(again)).toContain('nothing changed')
  })

  it('reads the theme that shows', async () => {
    const h = harness({ fullAccess: true })
    await h.tools.call(CALLER, SET_THEME_COLORS, { name: 'Night', dark: NIGHT })
    const result = await h.tools.call(CALLER, READ_THEME, {})
    expect(text(result)).toContain('#1a1b26')
    expect(result.structuredContent).toMatchObject({ chosen: AGENT_THEME_ID })
  })
})

describe('the colors a call may give', () => {
  it.each([
    ['custom CSS', { css: 'body { display: none }', light: SOLARIZED }],
    ['a layout token', { light: { ...SOLARIZED, radius: '0px' } }],
    ['no colors', {}],
    ['colors with reset', { reset: true, light: SOLARIZED }],
    ['a color that is no hex', { light: { canvas: 'white', accent: '#268bd2' } }],
    ['CSS in a color', { light: { canvas: '#fff;}*{display:none', accent: '#268bd2' } }],
    ['a dark canvas for light', { light: NIGHT }],
    ['a light canvas for dark', { dark: SOLARIZED }],
    ['a loud canvas', { light: { canvas: '#ffff00', accent: '#268bd2' } }],
    ['the built-in name', { name: 'Kettu', light: SOLARIZED }],
    ['a name too long', { name: 'x'.repeat(41), light: SOLARIZED }],
  ])('refuses %s', (_, input) => {
    expect(() => parseThemeRequest(input)).toThrow()
  })

  it('takes short hex and the reset alone', () => {
    expect(parseThemeRequest({ light: { canvas: '#FFF', accent: '#06c' } })).toEqual({
      reset: false,
      name: null,
      colors: { light: { canvas: '#ffffff', accent: '#0066cc' } },
    })
    expect(parseThemeRequest({ reset: true })).toEqual({ reset: true })
  })

  it('answers a refusal as a tool error that says why', async () => {
    const h = harness({ fullAccess: true })
    const result = await h.tools.call(CALLER, SET_THEME_COLORS, { css: 'x' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('Only colors change')
    expect(h.sets).toEqual([])
  })
})
