// Huli: an agent's theme tools reach the themes through the desktop app's main, which keeps the
// themes folder and the setting that chooses one: a read, or a state to put in place. Every call
// comes from the agent host, so each is checked in full before anything is written.

import {
  AGENT_THEME_ID,
  agentColorsOf,
  agentThemeFile,
  MAX_AGENT_THEME_NAME,
  type AgentThemeInstalled,
  type ThemeCallAnswer,
  type ThemeSnapshot,
} from '@shared/theme-palette'
import { BUILTIN_THEME_ID, THEME_ID } from '@shared/themes'
import type { SettingsStore } from './settings'
import type { ThemeStore } from './themes'

export interface ThemeOwner {
  themes: Pick<ThemeStore, 'putOwn' | 'ownText' | 'nameOf'>
  settings: Pick<SettingsStore, 'get' | 'update'>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The agent theme a call names, checked; undefined when the call's is not one. */
function agentOf(raw: unknown): AgentThemeInstalled | null | undefined {
  if (raw === null) return null
  if (!isRecord(raw) || typeof raw.name !== 'string') return undefined
  const name = raw.name.trim()
  if (name.length === 0 || name.length > MAX_AGENT_THEME_NAME) return undefined
  const colors = agentColorsOf(raw.colors)
  return colors ? { name, colors } : undefined
}

async function snapshot(owner: ThemeOwner): Promise<ThemeSnapshot> {
  const appearance = owner.settings.get().appearance
  let agent: AgentThemeInstalled | null = null
  const text = await owner.themes.ownText(AGENT_THEME_ID)
  if (text !== null) {
    try {
      const raw = JSON.parse(text) as Record<string, unknown>
      const colors = agentColorsOf(raw.agentColors)
      if (colors && typeof raw.name === 'string') agent = { name: raw.name, colors }
    } catch {
      // A file changed by hand reads as no agent theme.
    }
  }
  const chosen = appearance.colorTheme
  return {
    chosen,
    chosenName: chosen === BUILTIN_THEME_ID ? 'Kettu' : (owner.themes.nameOf(chosen) ?? chosen),
    agent,
    colorMode: appearance.theme,
  }
}

export async function answerThemeCall(call: unknown, owner: ThemeOwner): Promise<ThemeCallAnswer> {
  if (!isRecord(call) || (call.kind !== 'read' && call.kind !== 'set')) {
    return { error: 'Not a theme call.' }
  }
  try {
    if (call.kind === 'set') {
      const agent = agentOf(call.agent)
      const chosen = call.chosen
      if (agent === undefined) return { error: 'The agent theme is not valid.' }
      if (typeof chosen !== 'string' || (chosen !== BUILTIN_THEME_ID && !THEME_ID.test(chosen))) {
        return { error: 'The chosen theme is not a theme id.' }
      }
      await owner.themes.putOwn(
        AGENT_THEME_ID,
        agent ? agentThemeFile(agent.name, agent.colors) : null,
      )
      // A theme that is gone since leaves the built-in one showing.
      const shown =
        chosen === BUILTIN_THEME_ID || owner.themes.nameOf(chosen) !== null
          ? chosen
          : BUILTIN_THEME_ID
      if (owner.settings.get().appearance.colorTheme !== shown) {
        owner.settings.update({ appearance: { colorTheme: shown } })
      }
    }
    return { result: await snapshot(owner) }
  } catch (error) {
    return { error: (error as Error).message }
  }
}
