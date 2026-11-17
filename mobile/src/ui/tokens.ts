// The phone app's design tokens: one palette per scheme, and the shared radii, spacing and type
// scale. Screens and components take every color and size from here, never a literal.

import { useColorScheme } from 'react-native'

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
} as const

export interface Tokens {
  scheme: 'light' | 'dark'
  c: Palette
}

export function useTokens(): Tokens {
  const scheme = useColorScheme() === 'light' ? 'light' : 'dark'
  return { scheme, c: scheme === 'dark' ? dark : light }
}
