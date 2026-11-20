// What an ACP agent asks of the user through `elicitation/create` in a session, and the answer it
// takes back. A form shows as a card of its fields and a page as one that opens it. agy 1.5.12
// asks its `ask_question` tool's questions as a form whose fields are `q<n>`, one choice or several
// by the choices' numbers, and `q<n>_other`, the user's own words; those show as the questions card
// Claude Code's AskUserQuestion uses.

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
} from '@agentclientprotocol/sdk/unstable'
import type { FormField, PendingElicitation, PendingQuestion } from '@shared/thread'
import type { PermissionAnswer } from '../connection'
import { formFields, isWebUrl } from '../elicitation'

/** One of agy's questions: its field, its choices' values in order, and its own-words field. */
export interface AskedField {
  key: string
  multiSelect: boolean
  values: string[]
  /** The field for the user's own words, when the question takes them. */
  textKey: string | null
}

/** A session's elicitation as Kettu shows it, or null for one it cannot show. */
export type SessionElicitation =
  | { kind: 'questions'; questions: PendingQuestion[]; fields: AskedField[] }
  | { kind: 'form'; message: string; fields: FormField[] }
  | { kind: 'url'; message: string; url: string; elicitationId: string }

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const QUESTION_KEY = /^q([1-9]\d{0,2})$/
const OWN_WORDS = '_other'

/** `{ const, title }` choices, or plain `enum` values; null for any other shape. */
function choiceList(list: unknown, plain: unknown): { value: string; label: string }[] | null {
  if (Array.isArray(list) && list.length > 0) {
    const choices = list.map((item) =>
      isObject(item) && typeof item.const === 'string'
        ? {
            value: item.const,
            label: typeof item.title === 'string' && item.title.trim() ? item.title : item.const,
          }
        : null,
    )
    return choices.every((choice) => choice !== null) ? choices : null
  }
  if (Array.isArray(plain) && plain.length > 0 && plain.every((v) => typeof v === 'string')) {
    return plain.map((value: string) => ({ value, label: value }))
  }
  return null
}

/**
 * agy's questions, when a form has exactly its shape: every field a `q<n>` question with its
 * choices or the `q<n>_other` text beside one, and at least one question. Null for any other form.
 */
export function agyQuestions(
  schema: unknown,
): { questions: PendingQuestion[]; fields: AskedField[] } | null {
  if (!isObject(schema) || !isObject(schema.properties)) return null
  const properties = schema.properties
  const keys = Object.keys(properties)
  const questions: PendingQuestion[] = []
  const fields: AskedField[] = []
  for (const key of keys) {
    const prop = properties[key]
    if (!isObject(prop)) return null
    if (key.endsWith(OWN_WORDS)) {
      const of = key.slice(0, -OWN_WORDS.length)
      if (!QUESTION_KEY.test(of) || !isObject(properties[of]) || prop.type !== 'string') return null
      continue
    }
    if (!QUESTION_KEY.test(key)) return null
    const question = typeof prop.title === 'string' ? prop.title.trim() : ''
    if (!question) return null
    let multiSelect: boolean
    let choices: { value: string; label: string }[] | null
    if (prop.type === 'string') {
      multiSelect = false
      choices = choiceList(prop.oneOf, prop.enum)
    } else if (prop.type === 'array' && isObject(prop.items)) {
      multiSelect = true
      choices = choiceList(prop.items.anyOf, prop.items.enum)
    } else return null
    if (!choices || new Set(choices.map((c) => c.value)).size !== choices.length) return null
    const own = properties[`${key}${OWN_WORDS}`]
    const textKey = isObject(own) && own.type === 'string' ? `${key}${OWN_WORDS}` : null
    questions.push({
      header: '',
      question,
      multiSelect,
      options: choices.map((choice) => ({ label: choice.label })),
      allowsText: textKey !== null,
      secret: false,
    })
    fields.push({ key, multiSelect, values: choices.map((c) => c.value), textKey })
  }
  return questions.length > 0 ? { questions, fields } : null
}

/**
 * The elicitation a session-scoped request asks for: agy's questions (only from agy), a form whose
 * fields a card can show, or a web page. Null for anything else, which is declined.
 */
export function sessionElicitation(
  params: CreateElicitationRequest,
  fromAgy: boolean,
): SessionElicitation | null {
  const raw = params as Json
  const message = typeof raw.message === 'string' ? raw.message : ''
  if (raw.mode === 'form') {
    const asked = fromAgy ? agyQuestions(raw.requestedSchema) : null
    if (asked) return { kind: 'questions', ...asked }
    const fields = formFields(raw.requestedSchema ?? {})
    return fields ? { kind: 'form', message, fields } : null
  }
  if (raw.mode === 'url') {
    // Only a web page is offered; anything else could open a program on the user's computer.
    if (typeof raw.url !== 'string' || !isWebUrl(raw.url)) return null
    if (typeof raw.elicitationId !== 'string' || raw.elicitationId === '') return null
    return { kind: 'url', message, url: raw.url, elicitationId: raw.elicitationId }
  }
  return null
}

/** The request's form or page as the card holds it, for the agent named `server`. */
export function pendingElicitation(
  asked: Exclude<SessionElicitation, { kind: 'questions' }>,
  server: string,
): PendingElicitation {
  return asked.kind === 'form'
    ? { kind: 'form', server, message: asked.message, fields: asked.fields }
    : { kind: 'url', server, message: asked.message, url: asked.url }
}

/** The option ids a questions card offers a client that cannot show its questions. */
export const answerOption = (index: number): string => `answer:${index}`
export const OTHER_ANSWER = 'other'

/**
 * What agy takes for its questions: each answered question's choice values and its own words,
 * by field. An option alone answers the first question with that choice, Something else declines,
 * and no question answered declines too, so agy goes on without the answers.
 */
export function agyAnswer(
  fields: readonly AskedField[],
  answer: PermissionAnswer,
): CreateElicitationResponse {
  if (answer === 'cancelled' || 'values' in answer) return { action: 'cancel' }
  const content: Record<string, ElicitationContentValue> = {}
  if ('optionId' in answer) {
    const index = /^answer:(\d+)$/.exec(answer.optionId)
    const first = fields[0]
    const value = index && first ? first.values[Number(index[1])] : undefined
    if (!first || value === undefined) return { action: 'decline' }
    content[first.key] = first.multiSelect ? [value] : value
    return { action: 'accept', content }
  }
  for (const given of answer.answers) {
    const field = fields[given.question]
    if (!field) continue
    const values = [...given.choices]
      .sort((a, b) => a - b)
      .map((index) => field.values[index])
      .filter((value): value is string => value !== undefined)
    if (values.length > 0) content[field.key] = field.multiSelect ? values : values[0]!
    const text = given.text?.trim()
    if (text && field.textKey) content[field.textKey] = text
  }
  return Object.keys(content).length > 0 ? { action: 'accept', content } : { action: 'decline' }
}

/** What a form's or a page's card answer sends back. */
export function formAnswer(answer: PermissionAnswer): CreateElicitationResponse {
  if (answer === 'cancelled' || 'answers' in answer) return { action: 'cancel' }
  if ('values' in answer) return { action: 'accept', content: answer.values }
  return { action: answer.optionId === 'accept' ? 'accept' : 'decline' }
}
