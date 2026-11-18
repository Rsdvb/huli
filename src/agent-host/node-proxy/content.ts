// Huli: what a subscription holds, checked before mihomo gets it. mihomo v1.19.34's provider
// parser (adapter/provider/provider.go) reads a file provider as Clash YAML with a `proxies` list
// and, when that fails, as a v2ray list of node links (common/convert/converter.go), which it takes
// either plain or in standard base64 without anything around it. Kite keeps YAML as it came and
// writes a list of links back as standard base64, so a provider's URL-safe or wrapped base64, or a
// plain list YAML could misread, still reaches mihomo in the form it decodes. Content without a
// node is refused, so a failed download or a wrong file never replaces nodes that work. Huli's
// own; see tools/huli/README.md.

import { isMap, isSeq, parseDocument } from 'yaml'
import { MAX_SUBSCRIPTION_BYTES, type SubscriptionUsage } from '@shared/agent-network'

/** The link schemes mihomo's v2ray converter turns into nodes. */
const NODE_SCHEMES = new Set([
  'hysteria',
  'hysteria2',
  'hy2',
  'hysteria2+realm',
  'hy2+realm',
  'tuic',
  'trojan',
  'vless',
  'vmess',
  'ss',
  'ssr',
  'socks',
  'socks5',
  'socks5h',
  'http',
  'https',
  'anytls',
  'mierus',
])

export interface SubscriptionContent {
  format: 'yaml' | 'links'
  nodes: number
  /** What mihomo's file provider reads. */
  data: string
}

// Text: no control character but tab and line breaks.
// eslint-disable-next-line no-control-regex
const BINARY = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** Why `content` is no subscription text to import, or null when it is one. */
export function subscriptionTextProblem(content: unknown): string | null {
  if (typeof content !== 'string') return 'content must be text'
  if (Buffer.byteLength(content, 'utf8') > MAX_SUBSCRIPTION_BYTES) {
    return `content must be at most ${MAX_SUBSCRIPTION_BYTES / 1024 / 1024} MiB`
  }
  if (BINARY.test(content)) return 'content must be text, not a binary file'
  return null
}

function nodeLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      const at = line.indexOf('://')
      return at > 0 && NODE_SCHEMES.has(line.slice(0, at).toLowerCase())
    })
}

/** The text a base64 block stands for, URL-safe or not, wrapped or not; null if it is none. */
function fromBase64(text: string): string | null {
  const compact = text.replace(/\s+/g, '')
  if (compact.length === 0 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return null
  const decoded = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  const out = decoded.toString('utf8')
  return out.includes('://') ? out : null
}

/** The subscription's nodes, as mihomo will read them; throws when it holds none. */
export function readSubscription(raw: string): SubscriptionContent {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  // The document's tree alone: no alias is expanded, so neither a large Clash file nor one built
  // to expand without end costs more than its size. Anything else is a list of links.
  const doc = parseDocument(text)
  if (doc.errors.length === 0 && isMap(doc.contents)) {
    const proxies = doc.contents.get('proxies', true)
    if (isSeq(proxies)) {
      const nodes = proxies.items.filter((item) => isMap(item)).length
      if (nodes === 0) throw new Error('The subscription lists no nodes')
      return { format: 'yaml', nodes, data: text }
    }
  }
  const lines = nodeLines(fromBase64(text) ?? text)
  if (lines.length === 0) {
    throw new Error('The subscription holds no nodes: it is neither Clash YAML nor node links')
  }
  return {
    format: 'links',
    nodes: lines.length,
    data: `${Buffer.from(lines.join('\n'), 'utf8').toString('base64')}\n`,
  }
}

/**
 * The traffic and expiry of a `subscription-userinfo` header, read as mihomo reads it: fields
 * `key=value` split by `;`, spaces ignored, numbers whole or decimal, the expiry in seconds and 0
 * for none. Null without upload, download and total.
 */
export function parseUserinfo(header: string | null | undefined): SubscriptionUsage | null {
  if (!header) return null
  const fields = new Map<string, number>()
  for (const field of header.toLowerCase().replace(/\s+/g, '').split(';')) {
    const at = field.indexOf('=')
    if (at <= 0) continue
    const value = field.slice(at + 1)
    if (!/^\d+(\.\d+)?(e\+?\d+)?$/.test(value)) continue
    const number = Math.trunc(Number(value))
    if (Number.isSafeInteger(number)) fields.set(field.slice(0, at), number)
  }
  const upload = fields.get('upload')
  const download = fields.get('download')
  const total = fields.get('total')
  if (upload === undefined || download === undefined || total === undefined) return null
  const expire = fields.get('expire')
  return { upload, download, total, expire: expire ? expire * 1000 : null }
}
