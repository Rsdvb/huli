// The phone app's design tokens: one palette per scheme, and the shared radii, spacing and type
// scale. Screens and components take every color and size from here, never a literal.

import { useColorScheme } from 'react-native'
import { usePrefs } from '../prefs'

export interface Palette {
  /** The screen behind everything, and the glow at its top. */
  bg: string
  bgGlow: string
  /** Raised surfaces: cards, sheets, the composer. */
  surface: string
  surfaceRaised: string
  /** Translucent fills: pills, icon buttons, segmented controls, the tab bar. */
  fill: string
  fillStrong: string
  glass: string
  border: string
  borderStrong: string
  text: string
  textSecondary: string
  textTertiary: string
  /** Huli's orange: the send button, the brand, what needs the user. */
  accent: string
  onAccent: string
  /** Selection and progress: the active tab, rings, bars. */
  tint: string
  tintSoft: string
  success: string
  warning: string
  danger: string
  /** Diff rows. */
  added: string
  addedBg: string
  removed: string
  removedBg: string
  shadow: string
  /** Behind sheets and dialogs. */
  scrim: string
  /** A round avatar's disc, and the track under a ring or a bar. */
  avatar: string
  track: string
  /** Placeholder blocks while something loads. */
  skeleton: string
  /** Categorical series for charts, in a fixed order; color follows the entity, never its rank. */
  series: readonly string[]
}

const dark: Palette = {
  bg: '#050506',
  bgGlow: '#121722',
  surface: '#17181B',
  surfaceRaised: '#1F2024',
  fill: 'rgba(255,255,255,0.07)',
  fillStrong: 'rgba(255,255,255,0.12)',
  glass: 'rgba(30,31,35,0.86)',
  border: 'rgba(255,255,255,0.08)',
  borderStrong: 'rgba(255,255,255,0.14)',
  text: '#F2F2F5',
  textSecondary: '#9A9AA1',
  textTertiary: '#62626A',
  accent: '#EE7A3E',
  onAccent: '#FFFFFF',
  tint: '#5B93F5',
  tintSoft: 'rgba(91,147,245,0.18)',
  success: '#3DD27A',
  warning: '#F5B544',
  danger: '#FF6B5E',
  added: '#5BD08A',
  addedBg: 'rgba(61,210,122,0.12)',
  removed: '#FF7A6E',
  removedBg: 'rgba(255,107,94,0.12)',
  shadow: '#000000',
  scrim: 'rgba(0,0,0,0.55)',
  avatar: '#26272C',
  track: 'rgba(91,147,245,0.16)',
  skeleton: 'rgba(255,255,255,0.06)',
  series: ['#3987E5', '#D95926', '#199E70', '#C98500', '#D55181', '#0CA30C', '#9085E9', '#E66767'],
}

const light: Palette = {
  bg: '#F4F4F6',
  bgGlow: '#E6ECF7',
  surface: '#FFFFFF',
  surfaceRaised: '#FFFFFF',
  fill: 'rgba(0,0,0,0.05)',
  fillStrong: 'rgba(0,0,0,0.09)',
  glass: 'rgba(255,255,255,0.88)',
  border: 'rgba(0,0,0,0.07)',
  borderStrong: 'rgba(0,0,0,0.13)',
  text: '#16161A',
  textSecondary: '#6B6B73',
  textTertiary: '#A1A1A8',
  accent: '#E2611F',
  onAccent: '#FFFFFF',
  tint: '#2F6FE4',
  tintSoft: 'rgba(47,111,228,0.12)',
  success: '#22A35A',
  warning: '#C98500',
  danger: '#D93A2B',
  added: '#1E8E4E',
  addedBg: 'rgba(34,163,90,0.10)',
  removed: '#C9372A',
  removedBg: 'rgba(217,58,43,0.09)',
  shadow: '#000000',
  scrim: 'rgba(0,0,0,0.3)',
  avatar: '#E8E8ED',
  track: 'rgba(47,111,228,0.12)',
  skeleton: 'rgba(0,0,0,0.06)',
  series: ['#2A78D6', '#EB6834', '#1BAF7A', '#EDA100', '#E87BA4', '#008300', '#6250D6', '#E34948'],
}

export const radius = { xs: 6, sm: 10, md: 14, lg: 20, xl: 28, pill: 999 } as const

export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28, xxxl: 40 } as const

/** Sizes and weights by role; line heights keep Chinese text from crowding. */
export const type = {
  hero: { fontSize: 34, lineHeight: 40, fontWeight: '700' },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
  headline: { fontSize: 17, lineHeight: 23, fontWeight: '600' },
  body: { fontSize: 16, lineHeight: 24, fontWeight: '400' },
  callout: { fontSize: 15, lineHeight: 21, fontWeight: '400' },
  subhead: { fontSize: 14, lineHeight: 19, fontWeight: '500' },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500' },
  stat: { fontSize: 32, lineHeight: 38, fontWeight: '700' },
  /** The greeting and summary lines at the top of a tab. */
  lead: { fontSize: 22, lineHeight: 31, fontWeight: '400' },
  /** A list row's title. */
  rowTitle: { fontSize: 17, lineHeight: 23, fontWeight: '500' },
  /** The top bar's computer pill. */
  bar: { fontSize: 16, lineHeight: 21, fontWeight: '500' },
  section: { fontSize: 17, lineHeight: 23, fontWeight: '500' },
} as const

/**
 * How far text follows the system's text size (Dynamic Type), as a multiple of its size here:
 * body text up to `body`; dense controls (chips, pills, segmented controls, bars, headers) and
 * type that is large already up to `dense`. runtime/text.ts applies them to every Text.
 */
export const FONT_SCALE = { body: 1.6, dense: 1.3 } as const

/** Fixed sizes of the shell: hit targets, the top bar and the floating tab bar. */
export const size = {
  hit: 44,
  iconButton: 48,
  avatar: 40,
  avatarSmall: 28,
  /** A session row's agent avatar. */
  rowAvatar: 30,
  /** The top bar: the account avatar, the computer pill's height, the round search button. */
  barAvatar: 34,
  barPill: 34,
  barButton: 44,
  tabBar: 64,
  tabItem: 56,
  icon: 22,
  iconSmall: 16,
  gutter: 20,
} as const

/** The room above the bottom inset a scrolling tab leaves so the tab bar never covers its end. */
export const TAB_BAR_CLEARANCE = size.tabBar + space.xxxl

export const motion = { pressOpacity: 0.65, pressScale: 0.96, fast: 160, normal: 260 } as const

/**
 * Each agent harness's own colors, the only brand colors in the app. Kept apart from the scheme
 * palettes since a mark looks the same on either; the few that flip carry both.
 */
export const brand = {
  claude: '#D97757',
  codex: ['#B1A7FF', '#7A9DFF', '#3941FF'],
  opencodeFrame: { light: '#17181C', dark: '#FFFFFF' },
  opencodeFill: { light: '#E6E5E6', dark: '#5A5858' },
  piCoral: '#F09082',
  piBlue: '#4D9ABF',
  piYellow: '#F1BE58',
  gemini: ['#217BFE', '#078EFB', '#AC87EB', '#EE4D5D'],
  geminiTile: '#1E1E2E',
  deepseek: '#4D6BFE',
  qwen: '#082DFF',
  kimi: '#1783FF',
  dimcode: '#70C70E',
  antigravity: {
    blue: '#3186FF',
    green: '#00B95C',
    yellow: '#FFE432',
    amber: '#FBBC04',
    red: '#FC413D',
    violet: '#749BFF',
  },
  huli: '#E2611F',
  /** The app icon's fox: its orange ground, light to dark, and the face's tones. */
  fox: {
    groundLight: '#FDB46F',
    groundDark: '#DD4C1C',
    face: '#FFFFFF',
    faceShade: '#FFE6D5',
    cheek: '#FFC49C',
    ear: '#4A2B22',
    nose: '#3B201A',
  },
} as const

export interface Tokens {
  scheme: 'light' | 'dark'
  c: Palette
}

export function useTokens(): Tokens {
  const system = useColorScheme()
  const { theme } = usePrefs()
  const scheme = theme === 'system' ? (system === 'light' ? 'light' : 'dark') : theme
  return { scheme, c: scheme === 'dark' ? dark : light }
}
