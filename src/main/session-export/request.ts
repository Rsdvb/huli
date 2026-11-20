// Huli: `session:export`'s request, checked: the page sends the Markdown it built and the pictures
// it read, and main decides where they go.

import {
  EXPORT_ASSET,
  EXPORT_FORMATS,
  EXPORT_IMAGE_NAME,
  type ExportFormat,
  type SessionExportRequest,
} from '@shared/session-export'

export const MAX_TITLE_CHARS = 500
export const MAX_MARKDOWN_CHARS = 64 * 1024 * 1024
export const MAX_IMAGES = 5000
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024
export const MAX_TOTAL_BYTES = 512 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The request from the renderer, or an error saying what is wrong with it. */
export function parseExportRequest(raw: unknown): SessionExportRequest {
  if (!isRecord(raw)) throw new TypeError('An export must be an object')
  const extra = Object.keys(raw).find(
    (key) => !['format', 'title', 'markdown', 'images'].includes(key),
  )
  if (extra !== undefined) throw new TypeError(`An export takes no "${extra}"`)
  const { format, title, markdown, images } = raw
  if (!EXPORT_FORMATS.includes(format as ExportFormat)) {
    throw new TypeError('The format must be md, zip or pdf')
  }
  if (typeof title !== 'string' || title.length > MAX_TITLE_CHARS || title.includes('\0')) {
    throw new TypeError(`The title must be text of at most ${MAX_TITLE_CHARS} characters`)
  }
  if (typeof markdown !== 'string' || markdown.length > MAX_MARKDOWN_CHARS) {
    throw new TypeError('The Markdown must be text of at most 64 MiB')
  }
  if (!Array.isArray(images) || images.length > MAX_IMAGES) {
    throw new TypeError(`The pictures must be a list of at most ${MAX_IMAGES}`)
  }
  const names = new Set<string>()
  let total = 0
  const checked = images.map((image) => {
    if (!isRecord(image) || Object.keys(image).some((key) => key !== 'name' && key !== 'data')) {
      throw new TypeError('A picture must be { name, data }')
    }
    const { name, data } = image
    if (typeof name !== 'string' || !EXPORT_IMAGE_NAME.test(name) || names.has(name)) {
      throw new TypeError('A picture must have a name of its own, such as image-001.png')
    }
    if (!(data instanceof Uint8Array) || data.byteLength > MAX_IMAGE_BYTES) {
      throw new TypeError('A picture must be bytes, at most 50 MiB')
    }
    total += data.byteLength
    if (total > MAX_TOTAL_BYTES)
      throw new TypeError('The pictures are larger than 512 MiB together')
    names.add(name)
    return { name, data }
  })
  return { format: format as ExportFormat, title, markdown, images: checked }
}

/**
 * The Markdown with each picture's link pointing into `folder` (`/`-separated, relative to the
 * file); a link to a picture the export lacks shows its text instead.
 */
export function pointAssets(markdown: string, names: readonly string[], folder: string): string {
  const prefix = folder ? `${encodeLinkPath(folder)}/` : ''
  let out = markdown
  for (const name of names) out = out.split(`(${EXPORT_ASSET}${name})`).join(`(${prefix}${name})`)
  return out.replace(
    new RegExp(
      `!\\[([^\\]]*)\\]\\(${EXPORT_ASSET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^)]*\\)`,
      'g',
    ),
    '*($1)*',
  )
}

/** A relative path as a Markdown link destination takes it: spaces and brackets escaped. */
export function encodeLinkPath(path: string): string {
  return path.replace(
    /[ ()<>%]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  )
}
