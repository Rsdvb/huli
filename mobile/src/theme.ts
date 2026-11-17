import { useColorScheme } from 'react-native'

export interface Theme {
  bg: string
  card: string
  text: string
  muted: string
  line: string
  accent: string
  accentText: string
  warn: string
  danger: string
  ok: string
}

const light: Theme = {
  bg: '#F5F5F7',
  card: '#FFFFFF',
  text: '#1D1D1F',
  muted: '#6E6E73',
  line: '#E5E5EA',
  accent: '#E2611F',
  accentText: '#FFFFFF',
  warn: '#C77700',
  danger: '#C0392B',
  ok: '#2E8B57',
}

const dark: Theme = {
  bg: '#000000',
  card: '#1C1C1E',
  text: '#F5F5F7',
  muted: '#98989D',
  line: '#2C2C2E',
  accent: '#FF8A3D',
  accentText: '#1C1C1E',
  warn: '#FFB340',
  danger: '#FF6B5B',
  ok: '#4CD07D',
}

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light
}
