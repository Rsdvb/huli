// What an ACP agent asks of the user through `elicitation/create` in a session, and the answer it
// takes back. A form shows as a card of its fields and a page as one that opens it.

import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
} from '@agentclientprotocol/sdk/unstable'
import type { FormField, PendingElicitation } from '@shared/thread'
import type { PermissionAnswer } from '../connection'
import { formFields, isWebUrl } from '../elicitation'

/** A session's elicitation as Kettu shows it, or null for one it cannot show. */
export type SessionElicitation =
  | { kind: 'form'; message: string; fields: FormField[] }
  | { kind: 'url'; message: string; url: string; elicitationId: string }

type Json = Record<string, unknown>

/**
 * The elicitation a session-scoped request asks for: a form whose fields a card can show, or a
 * web page. Null for anything else, which is declined.
 */
export function sessionElicitation(params: CreateElicitationRequest): SessionElicitation | null {
  const raw = params as Json
  const message = typeof raw.message === 'string' ? raw.message : ''
  if (raw.mode === 'form') {
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
export function pendingElicitation(asked: SessionElicitation, server: string): PendingElicitation {
  return asked.kind === 'form'
    ? { kind: 'form', server, message: asked.message, fields: asked.fields }
    : { kind: 'url', server, message: asked.message, url: asked.url }
}

/** What a form's or a page's card answer sends back. */
export function formAnswer(answer: PermissionAnswer): CreateElicitationResponse {
  if (answer === 'cancelled' || 'answers' in answer) return { action: 'cancel' }
  if ('values' in answer) return { action: 'accept', content: answer.values }
  return { action: answer.optionId === 'accept' ? 'accept' : 'decline' }
}
