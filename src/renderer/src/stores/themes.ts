import { create } from 'zustand'
import { BUILTIN_THEME_ID, type Theme, type ThemesState } from '@shared/themes'
import { applyThemeStyle } from '@renderer/lib/theme-style'
import { useSettingsStore } from './settings'

interface ThemesStore {
  state: ThemesState
  /** The theme that shows: the chosen one, or null while the built-in one does. */
  shown: Theme | null
  /** Huli: the card whose colors this window shows for a moment in place of the shown theme. */
  preview: string | null
}

export const useThemesStore = create<ThemesStore>()(() => ({
  state: { installed: [], chosen: BUILTIN_THEME_ID, failed: null },
  shown: null,
  preview: null,
}))

/** Takes main's answer; the shown theme's colors are written before anyone is told. */
export function receiveThemes(state: ThemesState): void {
  const was = useThemesStore.getState().state.installed.find(({ id }) => id === state.chosen)
  // A plugin's theme leaves with its plugin, so the built-in theme takes its place for good,
  // as it does when the chosen theme is removed.
  if (was?.plugin && state.failed?.id === state.chosen) {
    useSettingsStore
      .getState()
      .update({ appearance: { colorTheme: BUILTIN_THEME_ID } })
      .catch((error: unknown) => console.error("Could not leave a plugin's theme", error))
  }
  const chosen = state.failed ? undefined : state.installed.find(({ id }) => id === state.chosen)
  const next = chosen?.theme ?? null
  const { shown, preview } = useThemesStore.getState()
  // Main's answers are new objects each time; a theme that stays the same keeps its own.
  const same = JSON.stringify(next) === JSON.stringify(shown)
  if (!same && preview === null) applyThemeStyle(next)
  useThemesStore.setState({ state, shown: same ? shown : next })
}

/**
 * Huli: shows a theme in this window alone until stopPreview, for a card that asks to change
 * the colors; null previews the built-in theme. Nothing is saved.
 */
export function startPreview(key: string, theme: Theme | null): void {
  useThemesStore.setState({ preview: key })
  applyThemeStyle(theme)
}

/** Huli: ends the card's preview, if it still holds one, and shows the chosen theme again. */
export function stopPreview(key: string): void {
  const { preview, shown } = useThemesStore.getState()
  if (preview !== key) return
  useThemesStore.setState({ preview: null })
  applyThemeStyle(shown)
}

/** Loads the themes and follows every change; the first render waits for it. */
export async function initThemes(): Promise<void> {
  window.kettu.themes.onChanged(receiveThemes)
  receiveThemes(await window.kettu.themes.get())
}

/**
 * Calls `listener` once the colors the tokens give may have changed: another color mode on
 * <html>, or another theme. For code that takes colors as values, such as xterm.js.
 */
export function onColorsChange(listener: () => void): () => void {
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const unsubscribe = useThemesStore.subscribe((state, previous) => {
    if (state.shown !== previous.shown) listener()
  })
  return () => {
    observer.disconnect()
    unsubscribe()
  }
}
