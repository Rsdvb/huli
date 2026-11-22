// Huli: the secrets tool of Kettu's MCP service. An agent that needs an API key, a token or a
// password asks for it here instead of in the chat: the user types it into a card, and the value
// goes straight to where the agent asked, the session's environment or a dotenv file in its
// folder. The thread, the logs and the agent's result hold only the names; a value saved for
// reuse goes to the app's encrypted key store, keyed by the project.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { CONTROL_WAIT_MS } from '@shared/control'
import type { Platform } from '@shared/platform'
import {
  MAX_SECRET_FIELDS,
  MAX_SECRET_HINT,
  MAX_SECRET_LABEL,
  MAX_SECRET_PATH,
  MAX_SECRET_REASON,
  MAX_SECRET_TITLE,
  MAX_SECRET_URL,
  MAX_SECRET_VALUE,
  secretNameProblem,
  secretPageUrl,
  secretPath,
  secretValueProblem,
  type SecretField,
  type SecretTarget,
} from '@shared/secret-request'
import type { FromDevice } from '@shared/thread'
import type { Caller } from '../artifacts/tools'
import { HostError, invalidParams, notFound } from '../errors'
import { DeliveryError, writeDotenv, writeSessionEnv } from './deliver'

export const REQUEST_SECRETS = 'request_secrets'
export const SECRET_TOOL_NAMES = [REQUEST_SECRETS]
/** How long a card waits before it counts as declined. */
export const SECRET_WAIT_MS = 10 * 60_000

export const SECRET_TOOLS: Tool[] = [
  {
    name: REQUEST_SECRETS,
    title: 'Ask the user for secrets',
    description:
      'Asks the user for values only they have, such as an API key, a token or a password a ' +
      'tool needs, in a private card in this session, one field per value; never ask for one in ' +
      'the chat. The values never reach the conversation, the logs or you: you get only the ' +
      "variable names. Without `file` they go into this session's environment for your next " +
      'commands; with `file` they are written to that dotenv file inside the session’s folder, ' +
      'such as .env.local. The result says how your commands get them. Never print, echo, cat ' +
      'or log a value or the file that holds it. The card waits up to 10 minutes and this call ' +
      'returns within a minute: if it says the user has not answered yet, call it again with the ' +
      'same arguments, which shows no second card.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_SECRET_TITLE,
          description: "The card's title, such as 'OpenAI API key'.",
        },
        reason: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_SECRET_REASON,
          description: 'What the values are for and where the user gets them; a link goes in url.',
        },
        url: {
          type: 'string',
          maxLength: MAX_SECRET_URL,
          description: 'An http(s) page where the user gets the values, shown as a button.',
        },
        fields: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_SECRET_FIELDS,
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                pattern: '^[A-Za-z_][A-Za-z0-9_]{0,63}$',
                description: 'The environment variable it is delivered as, such as OPENAI_API_KEY.',
              },
              label: { type: 'string', minLength: 1, maxLength: MAX_SECRET_LABEL },
              hint: { type: 'string', maxLength: MAX_SECRET_HINT },
              plain: {
                type: 'boolean',
                description: 'true shows the typed value, as for a user name or an email.',
              },
              optional: { type: 'boolean', description: 'true lets the user leave it empty.' },
            },
            required: ['name', 'label'],
            additionalProperties: false,
          },
        },
        file: {
          type: 'string',
          maxLength: MAX_SECRET_PATH,
          description:
            "A dotenv file from the session's folder to write the values into, such as .env.local " +
            'or apps/web/.env; leave it out to put them in the session’s environment.',
        },
      },
      required: ['title', 'reason', 'fields'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
]

const NAMES = new Set(SECRET_TOOL_NAMES)

export function isSecretToolName(name: string): boolean {
  return NAMES.has(name)
}

/** What a card asks, as the host adds it to the thread. */
export interface SecretAsk {
  title: string
  reason: string
  url: string | null
  fields: SecretField[]
  target: SecretTarget
  saved: string[]
}

/** How a card ended: the values went, or the user declined, nobody answered, or the turn ended. */
export type SecretAnswer =
  | { decision: 'provided'; names: string[]; saved: boolean }
  | { decision: 'declined' | 'expired' | 'ended' }

/** A window's or a device's answer to a card, as `secrets.answer` takes it. */
export interface SecretAnswerParams {
  decision: 'provide' | 'decline'
  /** The typed values by field name; never logged, never kept but where they go. */
  values?: Record<string, string>
  /** Fields that take the value saved for the project instead of a typed one. */
  useSaved?: string[]
  /** Save the typed values for the project; false forgets the card's saved ones. */
  save?: boolean
}

export interface SecretToolsDeps {
  platform: Platform
  /** The data folder's folder of the sessions' files of exports. */
  envDir: string
  /** The values saved for a project, by name; only the host holds them. */
  saved(project: string): ReadonlyMap<string, string>
  /** Saves values for a project in the encrypted store; null forgets one. */
  save(project: string, values: Record<string, string | null>): void
  /** The session's agent loads its file of exports before each command by itself. */
  loadsEnv(sessionId: string): boolean
  /** Adds the card to the thread; null for a session Kettu holds no thread for. */
  ask(sessionId: string, ask: SecretAsk): { entryId: string; answer: Promise<SecretAnswer> } | null
  /** Settles the card with the user's answer; throws when it was answered already. */
  answer(sessionId: string, entryId: string, answer: SecretAnswer, device?: FromDevice): void
  /** Throws the host's own refusal for a card that waits for no answer, as one answered already. */
  check(sessionId: string, entryId: string): void
  /** Whether git ignores a file of the folder; null when the folder is no repository. */
  ignored?(folder: string, relative: string): Promise<boolean | null>
}

/** A card waiting for the user, with what its answer needs and what became of it. */
interface Card {
  sessionId: string
  entryId: string
  project: string
  folder: string
  fields: SecretField[]
  target: SecretTarget
  saved: Set<string>
  busy: boolean
  /** Where the values went, for the result. */
  delivered: Delivered | null
}

type Delivered =
  | { kind: 'env'; sh: string; ps1: string | null; loads: boolean }
  | { kind: 'file'; path: string; ignored: boolean | null }

/** A card a call opened, which the agent's next call with the same arguments picks up. */
interface Job {
  key: string
  title: string
  result: Promise<CallToolResult>
}

class Refusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Refusal'
  }
}

/** A result whose words go in its structured content too, for an agent that reads only that. */
function reply(text: string, data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: { message: text, ...data } }
}

function failed(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fields(input: unknown, allowed: readonly string[], what: string): Record<string, unknown> {
  if (!isRecord(input)) throw new Refusal(`${what} must be an object.`)
  const unknown = Object.keys(input).find((key) => !allowed.includes(key))
  if (unknown !== undefined) throw new Refusal(`${what} has an unknown argument ${unknown}.`)
  return input
}

function text(value: unknown, what: string, max: number, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > max) {
    throw new Refusal(`${what} must be a text of 1 to ${max} characters.`)
  }
  return value.trim()
}

function flag(value: unknown, what: string): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new Refusal(`${what} must be true or false.`)
  return value
}

/** The request as the card shows it, checked in full; the first problem refuses all of it. */
export function parseSecretRequest(input: unknown): Omit<SecretAsk, 'saved'> {
  const o = fields(input, ['title', 'reason', 'url', 'fields', 'file'], 'The arguments')
  const title = text(o.title, 'title', MAX_SECRET_TITLE, true)!
  const reason = text(o.reason, 'reason', MAX_SECRET_REASON, true)!
  let url: string | null = null
  if (o.url !== undefined && o.url !== '') {
    url = typeof o.url === 'string' ? secretPageUrl(o.url) : null
    if (url === null) throw new Refusal('url must be an http(s) address.')
  }
  const list = o.fields
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_SECRET_FIELDS) {
    throw new Refusal(`fields must list from 1 to ${MAX_SECRET_FIELDS} values.`)
  }
  const seen = new Set<string>()
  const parsed = list.map((raw, i): SecretField => {
    const f = fields(raw, ['name', 'label', 'hint', 'plain', 'optional'], `fields[${i}]`)
    if (typeof f.name !== 'string') throw new Refusal(`fields[${i}].name must be a text.`)
    const name = f.name.trim()
    const problem = secretNameProblem(name)
    if (problem) throw new Refusal(`fields[${i}].name ${problem}.`)
    if (seen.has(name)) throw new Refusal(`fields[${i}].name ${name} is named twice.`)
    seen.add(name)
    const label = text(f.label, `fields[${i}].label`, MAX_SECRET_LABEL, true)!
    const hint =
      f.hint === '' ? undefined : text(f.hint, `fields[${i}].hint`, MAX_SECRET_HINT, false)
    return {
      name,
      label,
      ...(hint ? { hint } : {}),
      ...(flag(f.plain, `fields[${i}].plain`) ? { plain: true as const } : {}),
      ...(flag(f.optional, `fields[${i}].optional`) ? { optional: true as const } : {}),
    }
  })
  if (parsed.every((field) => field.optional)) {
    throw new Refusal('At least one field must be required.')
  }
  let target: SecretTarget = { kind: 'env' }
  if (o.file !== undefined && o.file !== '') {
    if (typeof o.file !== 'string') throw new Refusal('file must be a path text.')
    const checked = secretPath(o.file)
    if ('problem' in checked) throw new Refusal(`file ${checked.problem}.`)
    target = { kind: 'file', path: checked.path }
  }
  return { title, reason, url, fields: parsed, target }
}

/** Keys in a fixed order, so two equal objects read the same. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** The values an answer gives, by field: typed, or saved for the project; checked in full. */
function answerValues(card: Card, params: SecretAnswerParams, saved: ReadonlyMap<string, string>) {
  const typed = params.values ?? {}
  const useSaved = new Set(params.useSaved ?? [])
  const known = new Set(card.fields.map((field) => field.name))
  for (const name of [...Object.keys(typed), ...useSaved]) {
    if (!known.has(name)) throw invalidParams(`The card asks for no ${name}`)
  }
  const values = new Map<string, string>()
  const fresh = new Map<string, string>()
  for (const field of card.fields) {
    const raw = typed[field.name]
    if (raw !== undefined && raw.trim() !== '') {
      const problem = secretValueProblem(raw)
      if (problem === 'long') {
        throw invalidParams(`${field.label} is longer than ${MAX_SECRET_VALUE} characters`)
      }
      if (problem === 'line') throw invalidParams(`${field.label} must be one line`)
      values.set(field.name, raw.trim())
      fresh.set(field.name, raw.trim())
      continue
    }
    const kept = useSaved.has(field.name) ? saved.get(field.name) : undefined
    if (kept !== undefined) {
      values.set(field.name, kept)
      continue
    }
    if (!field.optional) throw invalidParams(`${field.label} is empty`)
  }
  return { values, fresh }
}

export class SecretTools {
  /** The cards calls opened, by session. */
  private readonly jobs = new Map<string, Job[]>()
  /** The cards waiting for an answer, by entry id. */
  private readonly cards = new Map<string, Card>()

  constructor(private readonly deps: SecretToolsDeps) {}

  /** The session's turn ended: a later turn's call asks again. */
  turnEnded(sessionId: string): void {
    this.jobs.delete(sessionId)
  }

  /** Serves a call; a refusal becomes a tool error whose text says why. */
  async call(caller: Caller, name: string, input: unknown): Promise<CallToolResult> {
    const deadline = Date.now() + CONTROL_WAIT_MS
    try {
      if (name !== REQUEST_SECRETS) throw new Error(`Unknown tool ${name}`)
      return await this.request(caller, input, deadline)
    } catch (error) {
      if (error instanceof Refusal) return failed(error.message)
      throw error
    }
  }

  private async request(caller: Caller, input: unknown, deadline: number): Promise<CallToolResult> {
    if (caller.subagent) {
      throw new Refusal(
        'A subagent cannot ask the user for secrets; ask from the session that runs it.',
      )
    }
    const ask = parseSecretRequest(input)
    const key = stable(ask)
    const waiting = this.jobs.get(caller.sessionId)?.find((job) => job.key === key)
    if (waiting) return this.follow(caller.sessionId, waiting, deadline)

    const saved = this.deps.saved(caller.project)
    const card: Card = {
      sessionId: caller.sessionId,
      entryId: '',
      project: caller.project,
      folder: caller.folder ?? caller.project,
      fields: ask.fields,
      target: ask.target,
      saved: new Set(ask.fields.filter((f) => saved.has(f.name)).map((f) => f.name)),
      busy: false,
      delivered: null,
    }
    const opened = this.deps.ask(caller.sessionId, { ...ask, saved: [...card.saved] })
    if (!opened) throw new Refusal('This session is not open, so it shows no card.')
    card.entryId = opened.entryId
    this.cards.set(opened.entryId, card)
    const job: Job = { key, title: ask.title, result: null! }
    job.result = opened.answer.then((answer) => {
      this.cards.delete(opened.entryId)
      return this.result(card, answer)
    })
    job.result.catch(() => {})
    this.jobs.set(caller.sessionId, [...(this.jobs.get(caller.sessionId) ?? []), job])
    return this.follow(caller.sessionId, job, deadline)
  }

  /**
   * `secrets.answer`: a window's or a device's answer. Provide checks every value, delivers them
   * and only then settles the card, so a delivery that fails leaves it waiting with the reason.
   */
  async answer(
    sessionId: string,
    entryId: string,
    params: SecretAnswerParams,
    device?: FromDevice,
  ): Promise<void> {
    this.deps.check(sessionId, entryId)
    const card = this.cards.get(entryId)
    if (!card || card.sessionId !== sessionId) throw notFound(`No secret card ${entryId}`)
    if (card.busy) throw new HostError('conflict', 'The card is being answered')
    if (params.decision === 'decline') {
      this.deps.answer(sessionId, entryId, { decision: 'declined' }, device)
      return
    }
    const saved = this.deps.saved(card.project)
    const { values, fresh } = answerValues(card, params, saved)
    card.busy = true
    try {
      card.delivered = await this.deliver(card, values)
    } catch (error) {
      const message =
        error instanceof DeliveryError
          ? error.message
          : `Kettu could not write the values: ${(error as NodeJS.ErrnoException).code ?? 'error'}`
      throw new HostError('unavailable', message)
    } finally {
      card.busy = false
    }
    const keep = params.save === true
    if (keep && fresh.size > 0) this.deps.save(card.project, Object.fromEntries(fresh))
    if (!keep && card.saved.size > 0) {
      this.deps.save(card.project, Object.fromEntries([...card.saved].map((name) => [name, null])))
    }
    this.deps.answer(
      sessionId,
      entryId,
      { decision: 'provided', names: [...values.keys()], saved: keep },
      device,
    )
  }

  private async deliver(card: Card, values: ReadonlyMap<string, string>): Promise<Delivered> {
    const { platform } = this.deps
    if (card.target.kind === 'env') {
      const files = await writeSessionEnv(this.deps.envDir, card.sessionId, values, platform)
      return { kind: 'env', ...files, loads: this.deps.loadsEnv(card.sessionId) }
    }
    const relative = card.target.path
    await writeDotenv(card.folder, relative, values, platform)
    const ignored = (await this.deps.ignored?.(card.folder, relative).catch(() => null)) ?? null
    return { kind: 'file', path: relative, ignored }
  }

  /** What the agent reads once the card ended: the names and how to use them, never a value. */
  private result(card: Card, answer: SecretAnswer): CallToolResult {
    if (answer.decision !== 'provided') {
      const text = {
        declined:
          'The user declined. Do not ask for these values in the chat or another way; say what is blocked and go on without them.',
        expired:
          'The user did not answer within 10 minutes. Do not ask in the chat; call request_secrets again only if the values are still needed.',
        ended: 'The turn ended before the user answered, so no value was given.',
      }[answer.decision]
      return reply(text, { status: answer.decision })
    }
    const names = answer.names
    const list = names.join(', ')
    const refs = names.map((name) => `$${name}`).join(', ')
    const delivered = card.delivered
    const never = 'Never print, echo, cat or log a value or the file that holds it.'
    if (!delivered) return reply(`The user provided ${list}.`, { status: 'provided', names })
    if (delivered.kind === 'env' && delivered.loads) {
      return reply(
        `The user provided ${list}. Your next shell commands in this session have ${names.length === 1 ? 'it' : 'them'} set in the environment: use ${refs}. ${never}`,
        { status: 'provided', names, target: 'env' },
      )
    }
    if (delivered.kind === 'env') {
      // Git Bash takes a Windows path with forward slashes, as PowerShell does.
      const sh = delivered.sh.replace(/\\/g, '/')
      const powershell = delivered.ps1
        ? `; in PowerShell, \`. '${delivered.ps1}'; <command>\` with ${names.map((name) => `$env:${name}`).join(', ')}`
        : ''
      return reply(
        `The user provided ${list}. They are in a private file of this session, outside the project. Load it in the same command that needs them: in bash or zsh, \`. '${sh}' && <command>\` with ${refs}${powershell}. ${never}`,
        {
          status: 'provided',
          names,
          target: 'env',
          file: sh,
          ...(delivered.ps1 ? { powershellFile: delivered.ps1 } : {}),
        },
      )
    }
    const ignoredNote =
      delivered.ignored === false
        ? ` ${delivered.path} is not ignored by git: add it to .gitignore before anything is committed.`
        : ''
    return reply(
      `The user provided ${list}. They are written to ${delivered.path} in the session's folder, which the project's tools read as a dotenv file.${ignoredNote} ${never}`,
      { status: 'provided', names, target: 'file', file: delivered.path },
    )
  }

  /** The card's outcome once it has one, or by the deadline that the user has not answered yet. */
  private async follow(sessionId: string, job: Job, deadline: number): Promise<CallToolResult> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))
    })
    try {
      const result = await Promise.race([job.result, late])
      if (result === null) {
        return reply(
          `The user has not answered the card for ${job.title} yet. Call request_secrets again with the same arguments to keep waiting on the same card; it shows no second one.`,
          { status: 'waiting' },
        )
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

  private done(sessionId: string, job: Job): void {
    const left = (this.jobs.get(sessionId) ?? []).filter((other) => other !== job)
    if (left.length > 0) this.jobs.set(sessionId, left)
    else this.jobs.delete(sessionId)
  }
}
