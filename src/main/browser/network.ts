// What the network tools return of a page's requests: the list, filtered, and one request's
// headers, timing and text body. Sign-ins and secrets stay out of what an agent reads: the values
// of credential headers and of secret-looking fields in a body are replaced.

/** The longest body text, request or response, a request's details show. */
export const MAX_BODY_CHARS = 32_000
/** The most of a request's own body kept as the page sends it. */
export const MAX_POST_DATA = 32 * 1024
/** A body longer than this is not parsed to redact its fields, only named. */
const MAX_PARSED_BODY = 4 * 1024 * 1024

export const REDACTED = '[redacted]'

/** Resource types the list leaves out unless asked, when they loaded. */
const STATIC_TYPES = new Set([
  'Image',
  'Font',
  'Stylesheet',
  'Script',
  'Media',
  'Manifest',
  'TextTrack',
])

// Headers that carry a sign-in or a secret; their values never reach an agent.
const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-amz-security-token',
])

// A body field is secret when its name, in lower case and letters and digits only, holds one of
// these, ends in "token" (not "max_tokens"), or is one of the short ones.
const SECRET_PARTS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'apikey',
  'accesskey',
  'privatekey',
  'credential',
  'cookie',
  'authorization',
  'sessionid',
  'cardnumber',
  'creditcard',
  'securitycode',
]
const SECRET_NAMES = new Set(['pwd', 'pass', 'pin', 'otp', 'ssn', 'cvv', 'cvc', 'auth', 'sid'])

export function isSecretField(name: string): boolean {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '')
  return (
    SECRET_NAMES.has(key) ||
    key.endsWith('token') ||
    SECRET_PARTS.some((part) => key.includes(part))
  )
}

/** Whether the list leaves a request out unless asked for static resources: one that loaded. */
export function isStaticResource(request: {
  type: string
  status: number | null
  error: string | null
}): boolean {
  if (!STATIC_TYPES.has(request.type) || request.error !== null) return false
  return request.status === null || request.status < 400
}

/**
 * Headers with credential values replaced. A scheme such as `Bearer` stays, and cookies keep their
 * names and attributes, which say what was sent without what it was.
 */
export function redactHeaders(headers: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, raw] of Object.entries(headers)) {
    const value = String(raw)
    const key = name.toLowerCase()
    if (!SECRET_HEADERS.has(key)) result[name] = value
    else if (key === 'cookie') result[name] = redactCookies(value)
    else if (key === 'set-cookie') {
      result[name] = value
        .split('\n')
        .map((line) => {
          const [pair = '', ...attributes] = line.split(';')
          return [redactCookies(pair), ...attributes].join(';')
        })
        .join('\n')
    } else if (key === 'authorization' || key === 'proxy-authorization') {
      const scheme = /^([A-Za-z][\w-]*)\s+\S/.exec(value)?.[1]
      result[name] = scheme ? `${scheme} ${REDACTED}` : REDACTED
    } else result[name] = REDACTED
  }
  return result
}

function redactCookies(value: string): string {
  return value
    .split(';')
    .map((pair) => {
      const at = pair.indexOf('=')
      return at < 0 ? pair.trim() : `${pair.slice(0, at).trim()}=${REDACTED}`
    })
    .filter((pair) => pair !== '')
    .join('; ')
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 64 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1))
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSecretField(key) ? REDACTED : redactValue(item, depth + 1)
  }
  return result
}

function mimeOf(contentType: string): string {
  return contentType.split(';')[0]!.trim().toLowerCase()
}

/** Whether a body of this type is text an agent can read. */
export function isTextType(contentType: string): boolean {
  const mime = mimeOf(contentType)
  if (mime === '') return false
  return (
    mime.startsWith('text/') ||
    /[/+](json|xml)$/.test(mime) ||
    /^application\/(javascript|ecmascript|x-javascript|x-www-form-urlencoded|graphql|x-ndjson)$/.test(
      mime,
    ) ||
    mime === 'image/svg+xml'
  )
}

/** What a body shows: its text, redacted and capped, or why it is not shown. */
export type BodyText = { text: string; note?: string } | { text: null; note: string }

/**
 * A body as an agent reads it: JSON and form fields that look secret are replaced, a form upload
 * or a binary body is only named, and a long one is cut.
 */
export function bodyText(body: string, contentType: string, binary = false): BodyText {
  const mime = mimeOf(contentType)
  const size = `${body.length.toLocaleString('en-US')} ${binary ? 'bytes in base64' : 'characters'}`
  if (mime.startsWith('multipart/'))
    return { text: null, note: `A form upload, ${size}, not shown.` }
  if (binary || (mime !== '' && !isTextType(mime))) {
    return { text: null, note: `A ${mime || 'binary'} body, ${size}, not shown.` }
  }
  let text = body
  if (body.length <= MAX_PARSED_BODY) {
    if (mime === 'application/x-www-form-urlencoded') text = redactForm(body)
    else if (/[/+]json$/.test(mime) || (mime === '' && /^\s*[[{]/.test(body))) {
      text = redactJson(body) ?? body
    }
  } else if (mime === 'application/x-www-form-urlencoded' || /[/+]json$/.test(mime)) {
    return { text: null, note: `A ${mime} body, ${size}, too long to show.` }
  }
  if (text.length > MAX_BODY_CHARS) {
    return {
      text: text.slice(0, MAX_BODY_CHARS),
      note: `Cut to ${MAX_BODY_CHARS.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters.`,
    }
  }
  return { text }
}

function redactJson(body: string): string | null {
  try {
    return JSON.stringify(redactValue(JSON.parse(body)))
  } catch {
    return null
  }
}

function redactForm(body: string): string {
  const params = new URLSearchParams(body)
  for (const key of new Set(params.keys())) {
    if (isSecretField(key)) params.set(key, REDACTED)
  }
  return params.toString()
}

/** Chromium's ResourceTiming: seconds for `requestTime`, milliseconds after it for the rest. */
export interface ResourceTiming {
  requestTime?: number
  dnsStart?: number
  dnsEnd?: number
  connectStart?: number
  connectEnd?: number
  sslStart?: number
  sslEnd?: number
  sendStart?: number
  sendEnd?: number
  receiveHeadersEnd?: number
}

export interface RequestTiming {
  started_at: string | null
  total_ms: number | null
  dns_ms: number | null
  connect_ms: number | null
  tls_ms: number | null
  wait_ms: number | null
  download_ms: number | null
}

const round = (ms: number): number => Math.round(ms * 10) / 10

function span(start: number | undefined, end: number | undefined): number | null {
  if (start === undefined || end === undefined || start < 0 || end < start) return null
  return round(end - start)
}

/**
 * How long a request took and where: `sent` and `ended` are the protocol's monotonic seconds,
 * `wallTime` the clock when it was sent.
 */
export function requestTiming(entry: {
  sent: number | null
  ended: number | null
  wallTime: number | null
  timing: ResourceTiming | null
}): RequestTiming {
  const timing = entry.timing ?? {}
  const headersAt =
    timing.requestTime !== undefined && timing.receiveHeadersEnd !== undefined
      ? timing.requestTime + timing.receiveHeadersEnd / 1000
      : null
  return {
    started_at: entry.wallTime === null ? null : new Date(entry.wallTime * 1000).toISOString(),
    total_ms:
      entry.sent !== null && entry.ended !== null && entry.ended >= entry.sent
        ? round((entry.ended - entry.sent) * 1000)
        : null,
    dns_ms: span(timing.dnsStart, timing.dnsEnd),
    connect_ms: span(timing.connectStart, timing.connectEnd),
    tls_ms: span(timing.sslStart, timing.sslEnd),
    wait_ms: span(timing.sendEnd, timing.receiveHeadersEnd),
    download_ms:
      headersAt !== null && entry.ended !== null && entry.ended >= headersAt
        ? round((entry.ended - headersAt) * 1000)
        : null,
  }
}
