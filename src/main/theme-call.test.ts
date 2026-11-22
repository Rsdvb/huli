import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_THEME_ID } from '@shared/theme-palette'
import { BUILTIN_THEME_ID, parseThemeFile } from '@shared/themes'
import { answerThemeCall, type ThemeOwner } from './theme-call'
import { readThemeFolder, readThemeSources, ThemeStore } from './themes'

let dir: string
let owner: ThemeOwner
let chosen: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kite-theme-call-'))
  chosen = BUILTIN_THEME_ID
  const themes = new ThemeStore(
    await readThemeFolder(join(dir, 'themes')),
    await readThemeSources(join(dir, 'theme-sources.json')),
    BUILTIN_THEME_ID,
    {
      dir: join(dir, 'themes'),
      sourcesFile: join(dir, 'theme-sources.json'),
      catalog: {} as never,
      select: () => {},
      changed: () => {},
    },
  )
  owner = {
    themes,
    settings: {
      get: () => ({ appearance: { theme: 'dark', colorTheme: chosen } }) as never,
      update: (patch: { appearance?: { colorTheme?: string } }) => {
        chosen = patch.appearance?.colorTheme ?? chosen
        themes.choose(chosen)
        return {} as never
      },
    } as ThemeOwner['settings'],
  }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const agent = { name: 'Night', colors: { dark: { canvas: '#1a1b26', accent: '#7aa2f7' } } }

describe('an agent’s theme call', () => {
  it('writes the agent theme as a theme file and shows it', async () => {
    const answer = await answerThemeCall({ kind: 'set', agent, chosen: AGENT_THEME_ID }, owner)
    expect(answer).toEqual({
      result: { chosen: AGENT_THEME_ID, chosenName: 'Night', agent, colorMode: 'dark' },
    })
    const text = await readFile(join(dir, 'themes', `${AGENT_THEME_ID}.json`), 'utf8')
    expect(parseThemeFile(text).ok).toBe(true)
  })

  it('removes the agent theme and shows the built-in one again', async () => {
    await answerThemeCall({ kind: 'set', agent, chosen: AGENT_THEME_ID }, owner)
    const answer = await answerThemeCall(
      { kind: 'set', agent: null, chosen: BUILTIN_THEME_ID },
      owner,
    )
    expect(answer).toMatchObject({ result: { chosen: BUILTIN_THEME_ID, agent: null } })
  })

  it('falls back to the built-in theme for one that is not installed', async () => {
    const answer = await answerThemeCall({ kind: 'set', agent: null, chosen: 'nord' }, owner)
    expect(answer).toMatchObject({ result: { chosen: BUILTIN_THEME_ID } })
  })

  it.each([
    ['no call', null],
    ['another kind', { kind: 'css', css: 'body{}' }],
    [
      'colors that are no hex',
      {
        kind: 'set',
        agent: { name: 'x', colors: { dark: { canvas: 'red', accent: '#fff' } } },
        chosen: AGENT_THEME_ID,
      },
    ],
    [
      'a canvas for the other mode',
      {
        kind: 'set',
        agent: { name: 'x', colors: { light: { canvas: '#000000', accent: '#ffffff' } } },
        chosen: AGENT_THEME_ID,
      },
    ],
    ['a chosen theme that is a path', { kind: 'set', agent: null, chosen: '../settings' }],
    [
      'a name too long',
      { kind: 'set', agent: { ...agent, name: 'x'.repeat(41) }, chosen: AGENT_THEME_ID },
    ],
  ])('refuses %s and writes nothing', async (_, call) => {
    const answer = await answerThemeCall(call, owner)
    expect(answer).toHaveProperty('error')
    await expect(readFile(join(dir, 'themes', `${AGENT_THEME_ID}.json`))).rejects.toThrow()
  })
})
