// Huli: an agent's theme colors. An agent names a canvas and an accent for light, dark or both,
// and the whole palette follows from Kettu's own tokens: surfaces stepped from the canvas as the
// built-in theme steps them, text and meaning colors at the built-in hues, each moved in OKLCH
// lightness until it reaches the ratio tools/lint/contrast.mjs asks on every surface it sits on.
// Only colors change; nothing of the layout is the agent's.

import contrastPairs from './contrast-pairs.json'
import {
  contrastIssues,
  contrastRatio,
  parseColor,
  THEME_FORMAT,
  THEME_MODES,
  toHex,
  type Rgba,
  type Theme,
  type ThemeColors,
  type ThemeMode,
  type ThemeToken,
} from './themes'

/** The installed theme an agent's colors are kept in. */
export const AGENT_THEME_ID = 'agent-colors'
export const MAX_AGENT_THEME_NAME = 40

/** One mode's two colors, as `#rrggbb`. */
export interface ModeColors {
  canvas: string
  accent: string
}

/** An agent's colors: a mode left out shows the built-in theme's. */
export type AgentColors = Partial<Record<ThemeMode, ModeColors>>

/** How light a canvas must be for light mode, and how dark for dark mode, in OKLCH lightness. */
export const LIGHT_CANVAS_MIN = 0.8
export const DARK_CANVAS_MAX = 0.34
/** A canvas is a quiet color: more chroma than this reads as a colored page. */
export const CANVAS_CHROMA_MAX = 0.12

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

interface Lch {
  l: number
  c: number
  h: number
}

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const encode = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

function toLch({ r, g, b }: Rgba): Lch {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)]
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  const l = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
  const c = Math.hypot(a, bb)
  const h = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360
  return { l, c, h }
}

/** The sRGB color of an OKLCH one, or null when it falls outside sRGB. */
function fromLchExact({ l, c, h }: Lch): Rgba | null {
  const rad = (h * Math.PI) / 180
  const a = c * Math.cos(rad)
  const b = c * Math.sin(rad)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const r = 4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_
  const g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_
  const bl = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_
  const eps = 1e-4
  if ([r, g, bl].some((v) => v < -eps || v > 1 + eps)) return null
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  return {
    r: clamp(encode(clamp(r))),
    g: clamp(encode(clamp(g))),
    b: clamp(encode(clamp(bl))),
    a: 1,
  }
}

/** An OKLCH color in sRGB, its chroma lowered until it fits, as CSS gamut mapping does. */
function fromLch(color: Lch): Rgba {
  const l = Math.min(1, Math.max(0, color.l))
  let lo = 0
  let hi = color.c
  const exact = fromLchExact({ ...color, l })
  if (exact) return exact
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (fromLchExact({ l, c: mid, h: color.h })) lo = mid
    else hi = mid
  }
  return fromLchExact({ l, c: lo, h: color.h }) ?? { r: l, g: l, b: l, a: 1 }
}

const hex = (color: Rgba) => toHex(color)

/** `#rrggbb` for a `#rgb` or `#rrggbb` text, or null for anything else. */
export function normalHex(value: unknown): string | null {
  if (typeof value !== 'string' || !HEX.test(value.trim())) return null
  return toHex(parseColor(value.trim())!)
}

/** Why a mode's colors cannot make a palette, or null when they can. */
export function modeColorsProblem(mode: ThemeMode, colors: ModeColors): string | null {
  const canvas = normalHex(colors.canvas)
  const accent = normalHex(colors.accent)
  if (!canvas) return `${mode}.canvas must be a hex color such as #fdf6e3`
  if (!accent) return `${mode}.accent must be a hex color such as #268bd2`
  const lch = toLch(parseColor(canvas)!)
  if (mode === 'light' && lch.l < LIGHT_CANVAS_MIN) {
    return `light.canvas ${canvas} is too dark for light mode; pick a lighter one`
  }
  if (mode === 'dark' && lch.l > DARK_CANVAS_MAX) {
    return `dark.canvas ${canvas} is too light for dark mode; pick a darker one`
  }
  if (lch.c > CANVAS_CHROMA_MAX) {
    return `${mode}.canvas ${canvas} is too colorful for a page; use the accent for color`
  }
  return null
}

// The built-in theme's meaning and code colors, whose hue and chroma a palette keeps.
const HUES: Record<ThemeMode, Partial<Record<ThemeToken, string>>> = {
  light: {
    danger: '#ac3b2d',
    success: '#2e7550',
    merged: '#6f4c8e',
    info: '#48525f',
    warning: '#936600',
    'syntax-keyword': '#8250df',
    'syntax-string': '#1a7f4b',
    'syntax-number': '#b05800',
    'syntax-function': '#2463c7',
    'syntax-type': '#8a6100',
    'syntax-comment': '#8a929c',
    'code-success': '#1a7f4b',
    'code-danger': '#cf222e',
  },
  dark: {
    danger: '#ea8a7d',
    success: '#6fbf8f',
    merged: '#b798d4',
    info: '#aeb6c1',
    warning: '#d9b463',
    'syntax-keyword': '#c29bff',
    'syntax-string': '#5cc08e',
    'syntax-number': '#f0a35e',
    'syntax-function': '#79b0ff',
    'syntax-type': '#e3b341',
    'syntax-comment': '#7d8590',
    'code-success': '#5cc08e',
    'code-danger': '#ff7b72',
  },
}

// The surfaces' lightness from the canvas, as the built-in theme steps them in each mode.
const STEPS: Record<ThemeMode, Partial<Record<ThemeToken, number>>> = {
  light: {
    'bg-sidebar': -0.017,
    'bg-subtle': -0.03,
    'bg-code-block': -0.02,
    'queue-back': -0.045,
  },
  dark: {
    'bg-sidebar': -0.022,
    'bg-surface': 0.053,
    'bg-subtle': 0.088,
    'bg-raised': 0.088,
    'bg-code-block': 0.008,
    'queue-back': 0.013,
  },
}

// Translucent fills of the built-in theme, which lay over any canvas the same.
const FILLS: Record<ThemeMode, Partial<Record<ThemeToken, string>>> = {
  light: {
    'bg-hover': 'rgb(0 0 0 / 4%)',
    'bg-selected': 'rgb(0 0 0 / 6%)',
    'border-default': 'rgb(0 0 0 / 10%)',
    'border-subtle': 'rgb(0 0 0 / 6%)',
    'border-strong': 'rgb(0 0 0 / 16%)',
    'primary-ring': 'transparent',
    'primary-highlight': 'transparent',
  },
  dark: {
    'bg-hover': 'rgb(255 255 255 / 6%)',
    'bg-selected': 'rgb(255 255 255 / 8%)',
    'border-default': 'rgb(255 255 255 / 12%)',
    'border-subtle': 'rgb(255 255 255 / 8%)',
    'border-strong': 'rgb(255 255 255 / 18%)',
    'primary-ring': 'transparent',
    'primary-highlight': 'transparent',
  },
}

// The accent's translucent fills, by their alpha in each mode.
const ACCENT_ALPHA: Record<ThemeMode, Partial<Record<ThemeToken, number>>> = {
  light: {
    'bg-code-inline': 0.1,
    selection: 0.18,
    'edit-selection': 0.18,
    'primary-from': 0.09,
    'primary-to': 0.09,
    'primary-hover-from': 0.14,
    'primary-hover-to': 0.14,
  },
  dark: {
    'bg-code-inline': 0.14,
    selection: 0.24,
    'edit-selection': 0.24,
    'primary-from': 0.16,
    'primary-to': 0.16,
    'primary-hover-from': 0.23,
    'primary-hover-to': 0.23,
  },
}

// A tint of a meaning color: its lightness from the canvas, its chroma.
const TINTS: Record<ThemeMode, { l: number; c: number; border: number; hover: number }> = {
  light: { l: -0.012, c: 0.014, border: -0.07, hover: -0.03 },
  dark: { l: 0.06, c: 0.018, border: 0.13, hover: 0.08 },
}

const PAIRS: readonly { fg: string; on: readonly string[]; minRatio?: number }[] =
  contrastPairs.groups
const BASES: readonly ThemeToken[] = ['bg-app', 'bg-sidebar', 'bg-surface']
/** Above each pair's ratio, so a value written as hex still passes once rounded. */
const MARGIN = 0.15
const WHITE: Rgba = { r: 1, g: 1, b: 1, a: 1 }
/** The lightest a dark mode's sheet may be. */
const SURFACE_MAX = 0.37

function rgbaText(color: Rgba, alpha: number): string {
  const byte = (c: number) => Math.round(c * 255)
  return `rgb(${byte(color.r)} ${byte(color.g)} ${byte(color.b)} / ${Math.round(alpha * 100)}%)`
}

/**
 * The lightness nearest `start` at which `passes` holds, searched toward `toward` first, then the
 * other way; the start itself when it passes, and the best found when nothing does.
 */
function fit(start: Lch, toward: 'darker' | 'lighter', passes: (color: Rgba) => number): Rgba {
  const at = (l: number) => fromLch({ ...start, l })
  let best = { color: at(start.l), score: passes(at(start.l)) }
  if (best.score >= 0) return best.color
  for (const direction of toward === 'darker' ? [-1, 1] : [1, -1]) {
    for (let step = 1; step <= 400; step++) {
      const l = start.l + direction * step * 0.0025
      if (l < 0 || l > 1) break
      const color = at(l)
      const score = passes(color)
      if (score >= 0) return color
      if (score > best.score) best = { color, score }
    }
  }
  return best.color
}

/**
 * The full palette of one mode from its canvas and accent, every pair of contrast-pairs.json at
 * its ratio. Tokens it leaves out, such as the terminal's colors, keep the built-in theme's.
 */
export function generatePalette(mode: ThemeMode, colors: ModeColors): ThemeColors {
  const problem = modeColorsProblem(mode, colors)
  if (problem) throw new Error(problem)
  const dark = mode === 'dark'
  const toward = dark ? 'lighter' : 'darker'
  const canvasRgba = parseColor(normalHex(colors.canvas)!)!
  const accentRgba = parseColor(normalHex(colors.accent)!)!
  const canvas = toLch(canvasRgba)
  const accent = toLch(accentRgba)
  const out: ThemeColors = {}
  const solid = new Map<string, Rgba>()
  const set = (token: ThemeToken, value: string) => {
    out[token] = value
    const parsed = parseColor(value)
    if (parsed) solid.set(token, parsed)
  }
  const step = (dl: number, chroma = canvas.c) =>
    hex(fromLch({ l: canvas.l + dl, c: chroma, h: canvas.h }))

  // Surfaces from the canvas.
  set('bg-app', hex(canvasRgba))
  set('bg-surface', hex(canvasRgba))
  set('bg-raised', hex(canvasRgba))
  for (const [token, dl] of Object.entries(STEPS[mode]) as [ThemeToken, number][]) {
    // A dark sheet stays dark enough for the send button's fill to stand out from it with white
    // on it, which a lighter one would not leave room for.
    set(
      token,
      dark && token === 'bg-surface' ? step(Math.min(dl, SURFACE_MAX - canvas.l)) : step(dl),
    )
  }
  set('track', step(dark ? 0.16 : -0.13, canvas.c * 0.6))
  for (const [token, value] of Object.entries(FILLS[mode]) as [ThemeToken, string][]) {
    set(token, value)
  }
  for (const [token, alpha] of Object.entries(ACCENT_ALPHA[mode]) as [ThemeToken, number][]) {
    set(token, rgbaText(accentRgba, alpha))
  }
  const tint = TINTS[mode]
  const hueOf = (token: ThemeToken) => toLch(parseColor(HUES[mode][token]!)!).h
  const tintOf = (token: ThemeToken, dl: number, chroma = tint.c) =>
    hex(fromLch({ l: canvas.l + dl, c: chroma, h: hueOf(token) }))
  set('danger-tint', tintOf('danger', tint.l))
  set('danger-border', tintOf('danger', tint.border, tint.c * 2))
  set('success-tint', tintOf('success', tint.l))
  set('warning-tint', tintOf('warning', tint.l))
  set('info-tint', tintOf('info', tint.l, tint.c / 2))
  set('info-tint-hover', tintOf('info', tint.hover, tint.c / 2))

  // The opaque colors a token shows as: itself, or laid over each base when translucent.
  const unders = (token: string): Rgba[] => {
    const color = solid.get(token)
    if (!color || color.a === 0) return []
    if (color.a === 1) return [color]
    return BASES.flatMap((base) => {
      const under = solid.get(base)
      if (!under) return []
      const mix = (top: number, bottom: number) => top * color.a + bottom * (1 - color.a)
      return [
        { r: mix(color.r, under.r), g: mix(color.g, under.g), b: mix(color.b, under.b), a: 1 },
      ]
    })
  }
  const pairsOf = (fg: ThemeToken) => PAIRS.find((group) => group.fg === `--${fg}`)
  // How far a color stands above the ratio its pairs ask, negative while it falls short.
  const score = (fg: ThemeToken, extra?: (color: Rgba) => number) => (color: Rgba) => {
    const group = pairsOf(fg)
    const min = (group?.minRatio ?? contrastPairs.minRatio) + MARGIN
    const ratios = (group?.on ?? []).flatMap((bg) =>
      unders(bg.slice(2)).map((under) => contrastRatio(color, under)),
    )
    const own = ratios.length === 0 ? Infinity : Math.min(...ratios) - min
    return Math.min(own, extra ? extra(color) : Infinity)
  }
  const fitted = (fg: ThemeToken, start: Lch, extra?: (color: Rgba) => number) => {
    const color = fit(start, toward, score(fg, extra))
    set(fg, hex(color))
    return color
  }

  // Text, on every surface and tint it sits on.
  const ink = { c: Math.min(canvas.c, 0.015), h: canvas.h }
  fitted('text-primary', { l: dark ? 0.93 : 0.23, ...ink })
  const secondary = fitted('text-secondary', { l: dark ? 0.77 : 0.45, ...ink })
  set('icon-default', hex(secondary))
  fitted('text-tertiary', { l: dark ? 0.71 : 0.5, ...ink })
  fitted('text-placeholder', { l: dark ? 0.71 : 0.5, ...ink })
  set('text-disabled', hex(fromLch({ l: dark ? 0.5 : 0.68, ...ink })))

  // The accent: text in it reaches 4.5:1, a control's fill 3:1, and white on the send button 3:1.
  fitted('attention', accent)
  fitted('link', accent)
  set('link-hover', out.link!)
  const control = fitted('control-on', accent)
  set('switch-on', hex(control))
  set('focus', hex(control))
  const onFill = (color: Rgba) => contrastRatio(WHITE, color) - (3 + MARGIN)
  const send = fit(accent, 'darker', score('send', onFill))
  set('send', hex(send))
  set('edit-ring', hex(send))
  set('attention-dot', hex(send))
  fitted('primary-foreground', accent)
  fitted('code-inline', accent)

  // Meaning and code colors at the built-in hues.
  for (const token of Object.keys(HUES[mode]) as ThemeToken[]) {
    const start = toLch(parseColor(HUES[mode][token]!)!)
    if (token === 'syntax-comment') {
      set(
        token,
        hex(fit(start, toward, (color) => contrastRatio(color, solid.get('bg-code-block')!) - 3)),
      )
      continue
    }
    fitted(token, start)
  }
  return out
}

/** Both modes' palettes; a mode left out is empty, which shows the built-in theme's. */
export function agentTheme(name: string, colors: AgentColors): Theme {
  const variant = (mode: ThemeMode) => {
    const own = colors[mode]
    return { colors: own ? generatePalette(mode, own) : {} }
  }
  return { name, light: variant('light'), dark: variant('dark') }
}

/**
 * The installed theme's file for an agent's colors, with the colors it came from beside the
 * palette, so a later read gives them back.
 */
export function agentThemeFile(name: string, colors: AgentColors): string {
  const theme = agentTheme(name, colors)
  const issues = contrastIssues({
    light: theme.light.colors as Record<string, string>,
    dark: theme.dark.colors as Record<string, string>,
  })
  if (issues.length > 0) {
    const first = issues[0]!
    throw new Error(`The palette misses contrast: ${first.mode} ${first.fg} on ${first.bg}`)
  }
  return `${JSON.stringify(
    {
      kettuTheme: THEME_FORMAT,
      name,
      agentColors: colors,
      light: theme.light,
      dark: theme.dark,
    },
    null,
    2,
  )}\n`
}

/** The agent colors a theme file keeps beside its palette, checked; null for none. */
export function agentColorsOf(raw: unknown): AgentColors | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const out: AgentColors = {}
  for (const mode of THEME_MODES) {
    const value = (raw as Record<string, unknown>)[mode]
    if (value === undefined) continue
    if (typeof value !== 'object' || value === null) return null
    const { canvas, accent } = value as Record<string, unknown>
    const pair = { canvas: normalHex(canvas) ?? '', accent: normalHex(accent) ?? '' }
    if (modeColorsProblem(mode, pair) !== null) return null
    out[mode] = pair
  }
  return out.light || out.dark ? out : null
}

/** The agent theme as installed: its name and the colors it was made from. */
export interface AgentThemeInstalled {
  name: string
  colors: AgentColors
}

/** Which theme shows and what the agent theme holds, as the owner of the themes reads them. */
export interface ThemeSnapshot {
  /** The setting: an installed theme's id, or the built-in theme's. */
  chosen: string
  chosenName: string
  agent: AgentThemeInstalled | null
  colorMode: 'system' | 'light' | 'dark'
}

/**
 * An agent's theme tools reach the themes through the desktop app's main: a read, or a state to
 * put in place, which writes the agent theme (or removes it, for null) and then chooses `chosen`.
 */
export type ThemeCall =
  { kind: 'read' } | { kind: 'set'; agent: AgentThemeInstalled | null; chosen: string }

/** The snapshot after the call, or why the owner refused it, which changed nothing. */
export type ThemeCallAnswer = { result: ThemeSnapshot } | { error: string }
