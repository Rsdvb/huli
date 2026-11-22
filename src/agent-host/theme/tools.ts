// Huli: the theme tools of Kettu's MCP service. An agent reads which theme shows and sets its
// colors, never its layout: a canvas and an accent for light, dark or both, from which the whole
// palette follows (see @shared/theme-palette). Full access changes them at once and leaves a line
// in the thread that undoes it; any other mode waits for the user's answer in a card, which can
// preview the colors first. Each change keeps what it replaced, so its Undo puts that back.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { CONTROL_WAIT_MS } from '@shared/control'
import {
  AGENT_THEME_ID,
  agentThemeFile,
  MAX_AGENT_THEME_NAME,
  modeColorsProblem,
  normalHex,
  type AgentColors,
  type AgentThemeInstalled,
  type ThemeSnapshot,
} from '@shared/theme-palette'
import { BUILTIN_THEME_ID, THEME_MODES } from '@shared/themes'
import type { ThemeChangeOutcome, ThemeState } from '@shared/thread'
import type { Caller } from '../artifacts/tools'

export const READ_THEME = 'read_theme'
export const SET_THEME_COLORS = 'set_theme_colors'
export const THEME_TOOL_NAMES = [READ_THEME, SET_THEME_COLORS]
/** How long a card waits before nothing changes. */
export const THEME_WAIT_MS = 10 * 60_000
const DEFAULT_NAME = 'Agent colors'

const MODE_SCHEMA = {
  type: 'object',
  properties: {
    canvas: {
      type: 'string',
      pattern: '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$',
      description: 'The page color, as #rrggbb: light for light mode, dark for dark mode.',
    },
    accent: {
      type: 'string',
      pattern: '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$',
      description: 'The color of buttons, links, switches and the send button, as #rrggbb.',
    },
  },
  required: ['canvas', 'accent'],
  additionalProperties: false,
} as const

export const THEME_TOOLS: Tool[] = [
  {
    name: READ_THEME,
    title: "Read Kettu's theme colors",
    description:
      "Reads which theme Kettu shows on this computer, the color mode, and the canvas and accent of the agent theme when one is set, with the built-in theme's for reference.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: SET_THEME_COLORS,
    title: "Change Kettu's theme colors",
    description:
      "Changes Kettu's colors, only when the user asks: a canvas (the page color) and an accent for light mode, dark mode or both, from which Kettu makes the whole palette with readable text everywhere. Colors only: Kettu's layout, spacing and fonts never change, and there is no custom CSS. A mode left out keeps the agent theme's colors when it shows, else the built-in theme's; reset goes back to the built-in theme. In Full access it changes at once and the thread shows a line the user can undo; in any other mode the user answers a card in this session, which can preview the colors and waits up to 10 minutes. This call returns within a minute: if it says the user has not answered yet, call it again with the same arguments, which shows no second card. To switch light and dark mode, use change_settings.",
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_AGENT_THEME_NAME,
          description: "The theme's name in Settings › Appearance, such as 'Solarized'.",
        },
        light: MODE_SCHEMA,
        dark: MODE_SCHEMA,
        reset: { type: 'boolean', description: 'true goes back to the built-in theme.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
]

const NAMES = new Set(THEME_TOOL_NAMES)

export function isThemeToolName(name: string): boolean {
  return NAMES.has(name)
}

/** The user's answer to a card, or how it ended without one. */
export type ThemeAnswer = { decision: 'apply' } | { decision: 'keep' | 'expired' | 'ended' }

export interface ThemeToolsDeps {
  /** Reads or sets the themes through main; throws the owner's reason when refused. */
  read(): Promise<ThemeSnapshot>
  set(agent: AgentThemeInstalled | null, chosen: string): Promise<ThemeSnapshot>
  /** The session's mode is Full access now, and it is a session of the user's own. */
  fullAccess(sessionId: string): boolean
  /** Adds the card to the thread; null for a session Kettu holds no thread for. */
  ask(
    sessionId: string,
    change: { from: ThemeState; to: ThemeState },
  ): { entryId: string; answer: Promise<ThemeAnswer> } | null
  /** Adds the line of a change made without asking; null for a session without a thread. */
  recorded(sessionId: string, change: { from: ThemeState; to: ThemeState }): string | null
  settle(sessionId: string, entryId: string, outcome: ThemeChangeOutcome): void
}

/** A card a call opened, which the agent's next call with the same arguments picks up. */
interface CardJob {
  key: string
  confirmed: boolean
  result: Promise<CallToolResult>
}

class Refusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Refusal'
  }
}

/** An undo refused because the theme changed again since: its line no longer offers it. */
export class StaleThemeUndo extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StaleThemeUndo'
  }
}

function reply(text: string, data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: { message: text, ...data } }
}

function failed(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** What a set_theme_colors call asks for, checked in full: colors by mode, or the reset. */
export function parseThemeRequest(
  input: unknown,
): { reset: true } | { reset: false; name: string | null; colors: AgentColors } {
  if (input !== undefined && !isRecord(input)) throw new Refusal('The arguments must be an object.')
  const o = (input ?? {}) as Record<string, unknown>
  const unknown = Object.keys(o).find((key) => !['name', 'light', 'dark', 'reset'].includes(key))
  if (unknown !== undefined) {
    throw new Refusal(
      `Unknown argument ${unknown}. Only colors change: a canvas and an accent for light and dark.`,
    )
  }
  if (o.reset !== undefined && typeof o.reset !== 'boolean') {
    throw new Refusal('reset must be true or false.')
  }
  if (o.reset === true) {
    if (o.light !== undefined || o.dark !== undefined || o.name !== undefined) {
      throw new Refusal('reset takes no colors or name.')
    }
    return { reset: true }
  }
  let name: string | null = null
  if (o.name !== undefined) {
    const text = typeof o.name === 'string' ? o.name.trim() : ''
    // eslint-disable-next-line no-control-regex
    if (text.length === 0 || text.length > MAX_AGENT_THEME_NAME || /[\u0000-\u001f]/.test(text)) {
      throw new Refusal(`name must be a text of 1 to ${MAX_AGENT_THEME_NAME} characters.`)
    }
    if (text.toLowerCase() === 'kettu' || text.toLowerCase() === 'kite') {
      throw new Refusal("name must not be the built-in theme's.")
    }
    name = text
  }
  const colors: AgentColors = {}
  for (const mode of THEME_MODES) {
    const value = o[mode]
    if (value === undefined) continue
    if (!isRecord(value)) throw new Refusal(`${mode} must be an object with canvas and accent.`)
    const extra = Object.keys(value).find((key) => key !== 'canvas' && key !== 'accent')
    if (extra !== undefined) throw new Refusal(`${mode}.${extra} is not a color the theme takes.`)
    const pair = {
      canvas: normalHex(value.canvas) ?? String(value.canvas),
      accent: normalHex(value.accent) ?? String(value.accent),
    }
    const problem = modeColorsProblem(mode, pair)
    if (problem) throw new Refusal(`${problem}.`)
    colors[mode] = pair
  }
  if (!colors.light && !colors.dark) {
    throw new Refusal('Give colors for light, dark or both, or reset: true.')
  }
  return { reset: false, name, colors }
}

const sameColors = (a: AgentColors | null | undefined, b: AgentColors | null | undefined) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function stateOf(snapshot: ThemeSnapshot): ThemeState {
  return { theme: snapshot.chosen, name: snapshot.chosenName, agent: snapshot.agent }
}

/** Whether the themes stand as a change left them, so its undo may put back what it replaced. */
function standsAs(snapshot: ThemeSnapshot, state: ThemeState): boolean {
  if (snapshot.chosen !== state.theme) return false
  if (state.theme !== AGENT_THEME_ID) return true
  return sameColors(snapshot.agent?.colors, state.agent?.colors)
}

function describe(colors: AgentColors): string {
  return THEME_MODES.flatMap((mode) => {
    const own = colors[mode]
    return own ? [`${mode}: canvas ${own.canvas}, accent ${own.accent}`] : []
  }).join('; ')
}

export class ThemeTools {
  private readonly jobs = new Map<string, CardJob[]>()

  constructor(private readonly deps: ThemeToolsDeps) {}

  /** The session's turn ended: a later turn's call with the same arguments asks again. */
  turnEnded(sessionId: string): void {
    this.jobs.delete(sessionId)
  }

  async call(caller: Caller, name: string, input: unknown): Promise<CallToolResult> {
    const deadline = Date.now() + CONTROL_WAIT_MS
    try {
      switch (name) {
        case READ_THEME:
          return await this.readTheme(input)
        case SET_THEME_COLORS:
          return await this.setColors(caller, input, deadline)
        default:
          throw new Error(`Unknown tool ${name}`)
      }
    } catch (error) {
      if (error instanceof Refusal) return failed(error.message)
      throw error
    }
  }

  /** Puts back what a change replaced, unless the theme changed again since. */
  async undo(change: { from: ThemeState; to: ThemeState }): Promise<void> {
    const now = await this.deps.read()
    if (!standsAs(now, change.to)) {
      throw new StaleThemeUndo('The theme changed again since, so this change cannot be undone.')
    }
    await this.deps.set(change.from.agent, change.from.theme)
  }

  private async readTheme(input: unknown): Promise<CallToolResult> {
    if (input !== undefined && (!isRecord(input) || Object.keys(input).length > 0)) {
      throw new Refusal('read_theme takes no arguments.')
    }
    const snapshot = await this.read()
    const agent = snapshot.agent
    const lines = [
      `Kettu shows ${snapshot.chosen === BUILTIN_THEME_ID ? 'its built-in theme' : `the theme "${snapshot.chosenName}"`} (color mode: ${snapshot.colorMode}).`,
      agent
        ? `The agent theme "${agent.name}" ${snapshot.chosen === AGENT_THEME_ID ? 'shows' : 'is installed but does not show'}: ${describe(agent.colors)}.`
        : 'No agent theme is set.',
      'The built-in theme: light canvas #ffffff, dark canvas #141416, accent #0060e2 for controls and #f2581b for the send button.',
    ]
    return reply(lines.join('\n'), {
      chosen: snapshot.chosen,
      chosenName: snapshot.chosenName,
      colorMode: snapshot.colorMode,
      agent,
    })
  }

  private async read(): Promise<ThemeSnapshot> {
    try {
      return await this.deps.read()
    } catch (error) {
      throw new Refusal(`Kettu could not read its themes: ${(error as Error).message}`)
    }
  }

  private async setColors(
    caller: Caller,
    input: unknown,
    deadline: number,
  ): Promise<CallToolResult> {
    const request = parseThemeRequest(input)
    const key = JSON.stringify(request)
    const waiting = this.jobs.get(caller.sessionId)?.find((job) => job.key === key)
    if (waiting) return this.follow(caller.sessionId, waiting, deadline)

    const before = await this.read()
    const from = stateOf(before)
    let to: ThemeState
    if (request.reset) {
      if (before.chosen === BUILTIN_THEME_ID) {
        return reply('Kettu already shows its built-in theme; nothing changed.', { changed: false })
      }
      to = { theme: BUILTIN_THEME_ID, name: 'Kettu', agent: before.agent }
    } else {
      // A mode left out keeps the agent theme's colors while it shows.
      const kept = before.chosen === AGENT_THEME_ID ? (before.agent?.colors ?? {}) : {}
      const colors: AgentColors = { ...kept, ...request.colors }
      const name = request.name ?? before.agent?.name ?? DEFAULT_NAME
      try {
        // Checks the palette in full before anyone is asked.
        agentThemeFile(name, colors)
      } catch (error) {
        throw new Refusal(`${(error as Error).message}. Try another accent.`)
      }
      to = { theme: AGENT_THEME_ID, name, agent: { name, colors } }
      if (standsAs(before, to) && before.agent?.name === name) {
        return reply('Kettu already shows these colors; nothing changed.', { changed: false })
      }
    }
    const change = { from, to }
    if (this.deps.fullAccess(caller.sessionId)) {
      await this.apply(to)
      this.deps.recorded(caller.sessionId, change)
      return changedResult(change, false)
    }
    const card = this.deps.ask(caller.sessionId, change)
    if (!card) throw new Refusal('This session is not open, so it shows no card.')
    const job: CardJob = { key, confirmed: false, result: null! }
    job.result = card.answer.then(async (answer) => {
      job.confirmed = answer.decision === 'apply'
      if (answer.decision !== 'apply') {
        const text =
          answer.decision === 'keep'
            ? "The user chose Don't change. The theme stays as it was; do not change it again unless they ask."
            : answer.decision === 'expired'
              ? 'The user did not answer within 10 minutes, so nothing changed.'
              : 'The turn ended before the user answered, so nothing changed.'
        return reply(text, { changed: false })
      }
      try {
        await this.apply(to)
      } catch (error) {
        const message = (error as Error).message
        this.deps.settle(caller.sessionId, card.entryId, { kind: 'failed', message })
        throw new Refusal(`The user pressed Apply, but Kettu could not apply it: ${message}`)
      }
      this.deps.settle(caller.sessionId, card.entryId, { kind: 'changed' })
      return changedResult(change, true)
    })
    job.result.catch(() => {})
    this.jobs.set(caller.sessionId, [...(this.jobs.get(caller.sessionId) ?? []), job])
    return this.follow(caller.sessionId, job, deadline)
  }

  private async apply(to: ThemeState): Promise<void> {
    try {
      await this.deps.set(to.agent, to.theme)
    } catch (error) {
      throw new Refusal(`Nothing changed: ${(error as Error).message}`)
    }
  }

  private async follow(sessionId: string, job: CardJob, deadline: number): Promise<CallToolResult> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))
    })
    try {
      const result = await Promise.race([job.result, late])
      if (result === null) {
        const text = job.confirmed
          ? 'The user pressed Apply and Kettu is applying it. Call set_theme_colors again with the same arguments for the outcome.'
          : 'The user has not answered the card to change the theme colors yet, and nothing changed. Call set_theme_colors again with the same arguments to keep waiting on the same card; it shows no second one.'
        return reply(text, { waiting: true, confirmed: job.confirmed })
      }
      this.done(sessionId, job)
      return result
    } catch (error) {
      this.done(sessionId, job)
      if (error instanceof Refusal) return failed(error.message)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private done(sessionId: string, job: CardJob): void {
    const left = (this.jobs.get(sessionId) ?? []).filter((other) => other !== job)
    if (left.length > 0) this.jobs.set(sessionId, left)
    else this.jobs.delete(sessionId)
  }
}

function changedResult(
  change: { from: ThemeState; to: ThemeState },
  asked: boolean,
): CallToolResult {
  const { to } = change
  const what =
    to.theme === BUILTIN_THEME_ID
      ? 'Kettu shows its built-in theme again'
      : `Kettu shows "${to.name}": ${describe(to.agent!.colors)}`
  const text = `${asked ? 'The user pressed Apply. ' : ''}${what}. It shows at once; the thread shows a line the user can undo.`
  return reply(text, { changed: true, theme: to.theme })
}
