import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  agentColorsOf,
  agentTheme,
  agentThemeFile,
  generatePalette,
  modeColorsProblem,
  type ModeColors,
} from './theme-palette'
import { parseThemeFile, type ThemeMode } from './themes'

type Declarations = Map<string, string>
interface Checker {
  parseTokens(css: string): { light: Declarations; mediaDark: Declarations; dark: Declarations }
  checkContrast(blocks: {
    light: Declarations
    dark: Declarations
  }): { theme: string; fg: string; bg: string; ratio: number | null; ok: boolean }[]
}

// The repository's own checker, on tokens.css with a palette laid over it, as the app shows it.
async function failures(mode: ThemeMode, colors: ModeColors) {
  const url = new URL('../../tools/lint/contrast.mjs', import.meta.url).href
  const checker = (await import(/* @vite-ignore */ url)) as Checker
  const css = await readFile(new URL('../renderer/src/styles/tokens.css', import.meta.url), 'utf8')
  const blocks = checker.parseTokens(css)
  const palette = new Map(
    Object.entries(generatePalette(mode, colors)).map(([token, value]) => [`--${token}`, value]),
  )
  const light = mode === 'light' ? new Map([...blocks.light, ...palette]) : blocks.light
  const dark = mode === 'dark' ? new Map([...blocks.dark, ...palette]) : blocks.dark
  return checker
    .checkContrast({ light, dark })
    .filter((row) => row.theme === mode && !row.ok)
    .map((row) => `${row.fg} on ${row.bg}: ${row.ratio?.toFixed(2)}`)
}

const LIGHT: [string, ModeColors][] = [
  ['white and blue', { canvas: '#ffffff', accent: '#0060e2' }],
  ['solarized light', { canvas: '#fdf6e3', accent: '#268bd2' }],
  ['gruvbox light', { canvas: '#fbf1c7', accent: '#d65d0e' }],
  ['a yellow accent', { canvas: '#ffffff', accent: '#ffe600' }],
  ['a pale cyan accent', { canvas: '#f4f8fb', accent: '#7fffd4' }],
  ['an accent like the canvas', { canvas: '#eff1f5', accent: '#eff1f5' }],
  ['the darkest light canvas', { canvas: '#c4c4c4', accent: '#e01b24' }],
  ['a black accent', { canvas: '#ffffff', accent: '#000000' }],
]

const DARK: [string, ModeColors][] = [
  ['tokyo night', { canvas: '#1a1b26', accent: '#7aa2f7' }],
  ['solarized dark', { canvas: '#002b36', accent: '#b58900' }],
  ['nord', { canvas: '#2e3440', accent: '#88c0d0' }],
  ['dracula', { canvas: '#282a36', accent: '#ff79c6' }],
  ['black and white', { canvas: '#000000', accent: '#ffffff' }],
  ['a dark blue accent', { canvas: '#0d1117', accent: '#0a1a5c' }],
  ['the lightest dark canvas', { canvas: '#373737', accent: '#ff6a2b' }],
  ['an accent like the canvas', { canvas: '#1e1e2e', accent: '#1e1e2e' }],
]

describe('an agent theme’s palette', () => {
  it.each(LIGHT)('passes the contrast check in light mode: %s', async (_, colors) => {
    expect(await failures('light', colors)).toEqual([])
  })

  it.each(DARK)('passes the contrast check in dark mode: %s', async (_, colors) => {
    expect(await failures('dark', colors)).toEqual([])
  })

  it('keeps the canvas as the page and is a theme file the app reads', () => {
    const colors = { light: LIGHT[1]![1], dark: DARK[0]![1] }
    const parsed = parseThemeFile(agentThemeFile('Agent: Solarized', colors))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.ignored).toEqual([])
    expect(parsed.theme.light.colors['bg-app']).toBe('#fdf6e3')
    expect(parsed.theme.dark.colors['bg-app']).toBe('#1a1b26')
  })

  it('leaves a mode it was not given to the built-in theme', () => {
    const theme = agentTheme('Dark only', { dark: DARK[0]![1] })
    expect(theme.light.colors).toEqual({})
    expect(Object.keys(theme.dark.colors).length).toBeGreaterThan(40)
  })

  it('writes colors only: every value is a color the theme check takes', () => {
    const palette = generatePalette('light', LIGHT[0]![1])
    for (const value of Object.values(palette)) {
      expect(value).toMatch(/^(#[0-9a-f]{6}|rgb\(\d+ \d+ \d+ \/ \d+%\)|transparent)$/)
    }
  })
})

describe('an agent theme’s colors', () => {
  it.each([
    ['light', { canvas: '#1a1b26', accent: '#7aa2f7' }, /too dark/],
    ['dark', { canvas: '#fdf6e3', accent: '#268bd2' }, /too light/],
    ['light', { canvas: '#ff00ff', accent: '#268bd2' }, /too dark|too colorful/],
    ['light', { canvas: 'white', accent: '#268bd2' }, /hex color/],
    ['light', { canvas: '#fff', accent: 'var(--x)' }, /hex color/],
    ['dark', { canvas: '#000; color: red', accent: '#fff' }, /hex color/],
    ['light', { canvas: 'rgb(255 255 255)', accent: '#fff' }, /hex color/],
  ] as const)('refuses %s %j', (mode, colors, why) => {
    expect(modeColorsProblem(mode, colors)).toMatch(why)
    expect(() => generatePalette(mode, colors)).toThrow()
  })

  it('takes short hex and gives it back long', () => {
    expect(agentColorsOf({ light: { canvas: '#FFF', accent: '#06c' } })).toEqual({
      light: { canvas: '#ffffff', accent: '#0066cc' },
    })
  })

  it('reads nothing from a file whose colors are not valid', () => {
    expect(agentColorsOf({ light: { canvas: '#000', accent: '#fff' } })).toBeNull()
    expect(agentColorsOf({ dark: 'x' })).toBeNull()
    expect(agentColorsOf({})).toBeNull()
  })
})
