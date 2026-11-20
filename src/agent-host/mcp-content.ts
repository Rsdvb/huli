// Huli: the blocks of a tool's result beyond text and images, as a tool call shows them: an MCP
// resource, a link to one, a sound, a document, a search result and the tools a search found.
// Claude Code passes some of them through in its tool results, Codex passes MCP results as MCP
// sent them; without this every one of them was dropped.

import type { ContentRef } from '@shared/thread'
import { toolTitle } from '@shared/tool-names'
import { contentRef } from './acp/mapper'
import { currentLocale, t } from './i18n'

type Block = Record<string, unknown>

const record = (value: unknown): Block =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Block) : {}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value : null

/** The name a URI ends in, for a link that has none of its own. */
function uriName(uri: string): string {
  const last = URL.parse(uri)?.pathname.split('/').filter(Boolean).pop()
  if (!last) return uri
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/**
 * The text a block carries, as Markdown: a text resource's, a text document's, a search result's
 * title and link, the name of a tool a tool search found. Null for a block without text.
 */
export function blockText(value: unknown): string | null {
  const block = record(value)
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : null
    case 'resource': {
      const resource = record(block.resource)
      return text(resource.text)
    }
    case 'document': {
      const source = record(block.source)
      return source.type === 'text' ? text(source.data) : null
    }
    case 'search_result': {
      const url = text(block.source)
      const title = text(block.title) ?? url
      const body = Array.isArray(block.content)
        ? block.content.flatMap((part) => (record(part).type === 'text' ? [record(part).text] : []))
        : []
      const head = title && url ? `[${title.replace(/[[\]]/g, '')}](${url})` : (title ?? '')
      return [head, ...body.filter((part): part is string => typeof part === 'string')]
        .filter(Boolean)
        .join('\n\n')
    }
    case 'tool_reference': {
      const name = text(block.tool_name)
      return name ? t('content.toolReference', { name: toolTitle(name, currentLocale()) }) : null
    }
    default:
      return null
  }
}

/**
 * What a block shows as other than text: an image or a sound from its bytes, a link to a resource
 * or to a document's page, or a label naming what cannot be shown. Null for a block of text.
 */
export function blockRef(value: unknown): ContentRef | null {
  const block = record(value)
  switch (block.type) {
    case 'image':
      return typeof block.data === 'string' && typeof block.mimeType === 'string'
        ? { kind: 'image', mimeType: block.mimeType, data: block.data }
        : null
    case 'audio':
      return typeof block.data === 'string' && typeof block.mimeType === 'string'
        ? contentRef({ type: 'audio', data: block.data, mimeType: block.mimeType })
        : null
    case 'resource_link': {
      const uri = text(block.uri)
      if (!uri) return null
      return { kind: 'link', uri, name: text(block.title) ?? text(block.name) ?? uriName(uri) }
    }
    case 'resource': {
      const resource = record(block.resource)
      const uri = text(resource.uri)
      if (!uri || text(resource.text)) return null
      const mimeType = text(resource.mimeType)
      const blob = text(resource.blob)
      if (blob && mimeType?.startsWith('image/')) return { kind: 'image', mimeType, data: blob }
      if (blob && mimeType && /^(audio|video)\//.test(mimeType)) {
        return contentRef({ type: 'resource', resource: { uri, mimeType, blob } })
      }
      return { kind: 'link', uri, name: uriName(uri) }
    }
    case 'document': {
      const source = record(block.source)
      const title = text(block.title)
      if (source.type === 'url' && text(source.url)) {
        const url = source.url as string
        return { kind: 'link', uri: url, name: title ?? uriName(url) }
      }
      if (source.type === 'text') return null
      return { kind: 'unsupported', label: t('content.document', { name: title ?? 'PDF' }) }
    }
    default:
      return null
  }
}
