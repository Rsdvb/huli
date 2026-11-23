// Huli: the network mocking rules of `browser_route`, by session. A tab of the session pauses the
// requests the rules' patterns may match through the DevTools protocol's Fetch domain, only while
// the session has a rule; each paused request is answered by the first rule that matches it, or
// goes on to the network unchanged. The rules end with the session's browser.

import {
  MAX_ROUTES,
  ROUTE_ABORTS,
  routeMatches,
  routePattern,
  type RouteRuleSpec,
} from '@shared/browser-args'

export interface RouteRule extends RouteRuleSpec {
  id: string
  used: number
}

/** What a paused request gets, once its rule's delay has passed. */
export type RouteAnswer =
  | { kind: 'continue'; rule: RouteRule | null }
  | {
      kind: 'fulfill'
      rule: RouteRule
      status: number
      headers: { name: string; value: string }[]
      body: string
    }
  | { kind: 'fail'; rule: RouteRule; reason: string }

/** A paused request, as `Fetch.requestPaused` reports it. */
export interface PausedRequest {
  url: string
  method: string
  headers: Record<string, string>
  resourceType: string
}

function header(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value
  }
  return undefined
}

/**
 * The answer a request gets from `rules`. A cross-origin request a rule answers gets CORS headers
 * that let its page read the answer, unless the rule gives its own; the preflight of one is
 * answered too, since it would otherwise go to a server that may not be there.
 */
export function answerFor(rules: readonly RouteRule[], request: PausedRequest): RouteAnswer {
  const origin = header(request.headers, 'origin')
  const preflight =
    request.method.toUpperCase() === 'OPTIONS' &&
    header(request.headers, 'access-control-request-method') !== undefined
  if (preflight) {
    const asked = header(request.headers, 'access-control-request-method')!
    const rule = rules.find((r) => routeMatches(r, request.url, asked))
    if (rule && rule.response.kind === 'fulfill') {
      return {
        kind: 'fulfill',
        rule,
        status: 204,
        headers: [
          { name: 'Access-Control-Allow-Origin', value: origin ?? '*' },
          { name: 'Access-Control-Allow-Methods', value: asked },
          {
            name: 'Access-Control-Allow-Headers',
            value: header(request.headers, 'access-control-request-headers') ?? '*',
          },
          { name: 'Access-Control-Allow-Credentials', value: 'true' },
          { name: 'Access-Control-Max-Age', value: '600' },
        ],
        body: '',
      }
    }
  }
  const rule = rules.find((r) => routeMatches(r, request.url, request.method))
  if (!rule) return { kind: 'continue', rule: null }
  const response = rule.response
  if (response.kind === 'continue') return { kind: 'continue', rule }
  if (response.kind === 'abort')
    return { kind: 'fail', rule, reason: ROUTE_ABORTS[response.reason] }
  const headers = response.headers.map(([name, value]) => ({ name, value }))
  const has = (name: string): boolean => headers.some((h) => h.name.toLowerCase() === name)
  if (origin && !has('access-control-allow-origin')) {
    headers.push({ name: 'Access-Control-Allow-Origin', value: origin })
    if (!has('access-control-allow-credentials')) {
      headers.push({ name: 'Access-Control-Allow-Credentials', value: 'true' })
    }
  }
  return { kind: 'fulfill', rule, status: response.status, headers, body: response.body }
}

/** What a rule does, in words, as the list shows it. */
export function ruleText(rule: RouteRuleSpec): string {
  const delay = rule.delayMs > 0 ? `after ${rule.delayMs} ms ` : ''
  const times = rule.times === null ? '' : `, ${rule.times} time${rule.times === 1 ? '' : 's'}`
  switch (rule.response.kind) {
    case 'continue':
      return `delays ${rule.delayMs} ms, then the network answers${times}`
    case 'abort':
      return `fails ${delay}with ${ROUTE_ABORTS[rule.response.reason]}${times}`
    case 'fulfill': {
      const size = new TextEncoder().encode(rule.response.body).length
      return `answers ${delay}HTTP ${rule.response.status}, ${size} bytes${times}`
    }
  }
}

/** The label a request a rule answered carries in the request list. */
export function mockedLabel(answer: RouteAnswer): string | null {
  if (!answer.rule) return null
  const delayed = answer.rule.delayMs > 0 ? ` after ${answer.rule.delayMs} ms` : ''
  switch (answer.kind) {
    case 'continue':
      return `delayed ${answer.rule.delayMs} ms by ${answer.rule.id}`
    case 'fail':
      return `failed by ${answer.rule.id}${delayed}`
    case 'fulfill':
      return `mocked by ${answer.rule.id}: HTTP ${answer.status}${delayed}`
  }
}

export class RouteBook {
  private readonly bySession = new Map<string, RouteRule[]>()
  private nextId = 1

  rules(sessionId: string): readonly RouteRule[] {
    return this.bySession.get(sessionId) ?? []
  }

  add(sessionId: string, spec: RouteRuleSpec): RouteRule {
    const rules = this.bySession.get(sessionId) ?? []
    if (rules.length >= MAX_ROUTES) {
      throw new Error(`A session holds at most ${MAX_ROUTES} rules. Remove or clear some first.`)
    }
    const rule: RouteRule = { ...spec, id: `r${this.nextId++}`, used: 0 }
    this.bySession.set(sessionId, [...rules, rule])
    return rule
  }

  remove(sessionId: string, id: string): boolean {
    const rules = this.bySession.get(sessionId) ?? []
    const left = rules.filter((rule) => rule.id !== id)
    if (left.length === rules.length) return false
    if (left.length === 0) this.bySession.delete(sessionId)
    else this.bySession.set(sessionId, left)
    return true
  }

  clear(sessionId: string): number {
    const count = this.rules(sessionId).length
    this.bySession.delete(sessionId)
    return count
  }

  /** A rule answered a request; one with a count goes once it is used up. True when it went. */
  used(sessionId: string, rule: RouteRule): boolean {
    rule.used += 1
    if (rule.times === null || rule.used < rule.times) return false
    return this.remove(sessionId, rule.id)
  }

  /** The Fetch patterns a tab of the session pauses requests by, each once; empty for none. */
  patterns(sessionId: string): string[] {
    return [...new Set(this.rules(sessionId).map((rule) => routePattern(rule.pattern).fetch))]
  }
}
