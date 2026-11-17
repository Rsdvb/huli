// The session screens' own additions to the design tokens: the surfaces of the conversation and
// the composer, soft tints for states, and the marks of file types. Kept beside the shared tokens
// so the shell's palette stays one file.

import { Platform } from 'react-native'
import { useTokens, type Palette } from '../tokens'

export const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' })

export interface SessionPalette {
  /** The user's bubble. */
  bubble: string
  /** Code blocks, tool output and inline code. */
  code: string
  codeBorder: string
  inlineCode: string
  /** The composer's outer tray and the card the input sits in. */
  dock: string
  dockCard: string
  accentSoft: string
  warningSoft: string
  dangerSoft: string
  successSoft: string
  /** A merged pull request, the desktop's merged color. */
  merged: string
  /** Under a picture viewer. */
  scrim: string
  /** Over an attachment while it uploads. */
  veil: string
  onScrim: string
  scrimFill: string
  /** A popover menu: its fill under the blur, its fill without one, and the chosen row's. */
  menu: string
  menuSolid: string
  menuActive: string
  /** The light dimming behind an open popover menu. */
  menuScrim: string
  /** The context bar's small fixed costs, after the four colored kinds, and the buffer. */
  contextGrays: readonly [string, string, string]
  contextBuffer: string
  /** The round stop button: a light disc in the dark, a dark one in the light. */
  stop: string
  onStop: string
  /** Code tints: a cheap highlighter's few classes. */
  syntax: Record<'keyword' | 'string' | 'comment' | 'number' | 'type', string>
  /** File type marks, by language. */
  lang: Record<
    'js' | 'ts' | 'py' | 'rs' | 'go' | 'web' | 'style' | 'data' | 'shell' | 'other',
    string
  >
}

const dark: SessionPalette = {
  bubble: 'rgba(255,255,255,0.09)',
  code: 'rgba(255,255,255,0.05)',
  codeBorder: 'rgba(255,255,255,0.07)',
  inlineCode: 'rgba(255,255,255,0.10)',
  dock: '#141518',
  dockCard: '#1E1F23',
  veil: 'rgba(30,31,35,0.7)',
  accentSoft: 'rgba(238,122,62,0.16)',
  warningSoft: 'rgba(245,181,68,0.14)',
  dangerSoft: 'rgba(255,107,94,0.13)',
  successSoft: 'rgba(61,210,122,0.13)',
  merged: '#B798D4',
  scrim: '#000000',
  onScrim: '#FFFFFF',
  scrimFill: 'rgba(255,255,255,0.16)',
  menu: 'rgba(36,37,42,0.62)',
  menuSolid: '#24252A',
  menuActive: 'rgba(255,255,255,0.09)',
  menuScrim: 'rgba(0,0,0,0.32)',
  contextGrays: ['#9A9AA1', '#7C7C84', '#62626A'],
  contextBuffer: 'rgba(255,255,255,0.22)',
  stop: '#F2F2F5',
  onStop: '#050506',
  syntax: {
    keyword: '#FF7AB2',
    string: '#FF8170',
    comment: '#7F8C98',
    number: '#D9C97C',
    type: '#6BDFFF',
  },
  lang: {
    js: '#E8C547',
    ts: '#5B9BF0',
    py: '#6FA8DC',
    rs: '#E0835B',
    go: '#4FC3D9',
    web: '#E77B4E',
    style: '#B38AF0',
    data: '#C9A46A',
    shell: '#9A9AA1',
    other: '#9A9AA1',
  },
}

const light: SessionPalette = {
  bubble: 'rgba(0,0,0,0.055)',
  code: 'rgba(0,0,0,0.035)',
  codeBorder: 'rgba(0,0,0,0.06)',
  inlineCode: 'rgba(0,0,0,0.06)',
  dock: '#EBEBEF',
  dockCard: '#FFFFFF',
  veil: 'rgba(255,255,255,0.7)',
  accentSoft: 'rgba(226,97,31,0.11)',
  warningSoft: 'rgba(201,133,0,0.11)',
  dangerSoft: 'rgba(217,58,43,0.09)',
  successSoft: 'rgba(34,163,90,0.10)',
  merged: '#6F4C8E',
  scrim: '#000000',
  onScrim: '#FFFFFF',
  scrimFill: 'rgba(255,255,255,0.16)',
  menu: 'rgba(250,250,252,0.72)',
  menuSolid: '#FAFAFC',
  menuActive: 'rgba(0,0,0,0.06)',
  menuScrim: 'rgba(0,0,0,0.12)',
  contextGrays: ['#8E8E96', '#A8A8AF', '#C2C2C8'],
  contextBuffer: 'rgba(0,0,0,0.18)',
  stop: '#16161A',
  onStop: '#FFFFFF',
  syntax: {
    keyword: '#AD3DA4',
    string: '#D12F1B',
    comment: '#707F8C',
    number: '#272AD8',
    type: '#0B4F79',
  },
  lang: {
    js: '#B08D00',
    ts: '#2F6FE4',
    py: '#3572A5',
    rs: '#C0582E',
    go: '#0B8FA8',
    web: '#D2551F',
    style: '#7E4FD0',
    data: '#8C6A2F',
    shell: '#6B6B73',
    other: '#6B6B73',
  },
}

export interface SessionTokens {
  scheme: 'light' | 'dark'
  c: Palette
  s: SessionPalette
}

export function useSessionTokens(): SessionTokens {
  const { scheme, c } = useTokens()
  return { scheme, c, s: scheme === 'dark' ? dark : light }
}
