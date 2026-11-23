// Huli: where in the project's source a picked element comes from, as a dev build tells it:
// attributes a dev plugin writes on elements (react-dev-inspector, code-inspector, the Vue and
// Astro inspectors, LocatorJS, Sentry's component names), React's `_debugSource` before React 19
// and its `_debugStack` since, Svelte's `__svelte_meta`, or Vue's component file. A stack's place
// in served code is mapped back through the script's source map, which this file reads itself
// (VLQ, as the source map format v3 writes it), so no dependency is added.

import type { WebContents } from 'electron'

export interface SourceLocation {
  file: string
  line: number | null
  column: number | null
  /** What said so, for the agent to weigh it. */
  from: 'attribute' | 'react' | 'svelte' | 'vue' | 'stack'
}

/** The longest script or source map read to map a stack's place, in characters. */
const MAX_SCRIPT_CHARS = 8 * 1024 * 1024
const FETCH_MS = 2_000

/**
 * Runs in the page's own world with the element as `this`, since a framework's records hang on
 * the element's object there: the nearest source a dev build left, or a React 19 stack to map.
 */
export const FIND_SOURCE = `function () {
  const num = (value) => { const n = parseInt(value, 10); return Number.isFinite(n) ? n : null }
  const split = (value) => {
    const match = /^(.*?):(\\d+)(?::(\\d+))?(?::[^:]*)?$/.exec(value)
    return match ? { file: match[1], line: num(match[2]), column: num(match[3]) } : { file: value, line: null, column: null }
  }
  for (let node = this, depth = 0; node && node.nodeType === 1 && depth < 40; node = node.parentElement, depth++) {
    const get = (name) => node.getAttribute(name)
    if (get('data-inspector-relative-path')) {
      return { from: 'attribute', file: get('data-inspector-relative-path'), line: num(get('data-inspector-line')), column: num(get('data-inspector-column')) }
    }
    for (const name of ['data-insp-path', 'data-v-inspector', 'data-source', 'data-source-loc']) {
      if (get(name)) return { from: 'attribute', ...split(get(name)) }
    }
    if (get('data-astro-source-file')) {
      const loc = split('x:' + (get('data-astro-source-loc') || ''))
      return { from: 'attribute', file: get('data-astro-source-file'), line: loc.line, column: loc.column }
    }
    if (get('data-locatorjs-id')) {
      const id = get('data-locatorjs-id').split('::')
      const loc = split('x:' + (id[1] || ''))
      return { from: 'attribute', file: id[0], line: loc.line, column: loc.column }
    }
    const meta = node.__svelte_meta && node.__svelte_meta.loc
    if (meta && meta.file) return { from: 'svelte', file: String(meta.file), line: num(meta.line) === null ? null : num(meta.line) + 1, column: num(meta.column) === null ? null : num(meta.column) + 1 }
    const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'))
    if (key) {
      for (let fiber = node[key], hops = 0; fiber && hops < 30; fiber = fiber._debugOwner || fiber.return, hops++) {
        const source = fiber._debugSource
        if (source && source.fileName) return { from: 'react', file: String(source.fileName), line: num(source.lineNumber), column: num(source.columnNumber) }
        const stack = fiber._debugStack && fiber._debugStack.stack
        if (typeof stack === 'string') return { from: 'stack', stack: stack.slice(0, 4000) }
      }
    }
    const vue = node.__vueParentComponent
    if (vue && vue.type && typeof vue.type.__file === 'string') return { from: 'vue', file: vue.type.__file, line: null, column: null }
    if (get('data-sentry-source-file')) return { from: 'attribute', file: get('data-sentry-source-file'), line: null, column: null }
  }
  return null
}`

/**
 * The first frame of a React 19 stack that is the app's own: past React's frames, its runtime's
 * and anything from node_modules or a bundler's dependency cache.
 */
export function appFrame(stack: string): { url: string; line: number; column: number } | null {
  for (const raw of stack.split('\n').slice(1)) {
    const match = /(https?:\/\/[^\s()]+):(\d+):(\d+)\)?\s*$/.exec(raw.trim())
    if (!match) continue
    const url = match[1]!
    if (
      /node_modules|\/\.vite\/deps\/|react-dom|react-jsx|jsx-dev-runtime|\/@react-refresh/.test(url)
    ) {
      continue
    }
    return { url, line: Number(match[2]), column: Number(match[3]) }
  }
  return null
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const DIGIT = new Map([...BASE64].map((char, index) => [char, index]))

/** The values of one VLQ segment of a source map's mappings. */
export function decodeVlq(segment: string): number[] {
  const values: number[] = []
  let value = 0
  let shift = 0
  for (const char of segment) {
    const digit = DIGIT.get(char)
    if (digit === undefined) return values
    value += (digit & 31) << shift
    if (digit & 32) {
      shift += 5
      continue
    }
    values.push(value & 1 ? -(value >>> 1) : value >>> 1)
    value = 0
    shift = 0
  }
  return values
}

interface SourceMap {
  sources?: unknown
  sourceRoot?: unknown
  mappings?: unknown
}

/**
 * The original place of a generated one (`line` from 1, `column` from 1) in a source map: the
 * last mapping of that line at or before the column. Null when the map has none.
 */
export function originalPosition(
  map: SourceMap,
  line: number,
  column: number,
): { source: string; line: number; column: number } | null {
  if (typeof map.mappings !== 'string' || !Array.isArray(map.sources)) return null
  const lines = map.mappings.split(';')
  let source = 0
  let originalLine = 0
  let originalColumn = 0
  let best: { source: number; line: number; column: number } | null = null
  for (let index = 0; index < lines.length && index < line; index++) {
    let generated = 0
    for (const segment of lines[index]!.split(',')) {
      if (segment === '') continue
      const values = decodeVlq(segment)
      if (values.length === 0) continue
      generated += values[0]!
      if (values.length >= 4) {
        source += values[1]!
        originalLine += values[2]!
        originalColumn += values[3]!
        if (index === line - 1 && generated <= column - 1) {
          best = { source, line: originalLine, column: originalColumn }
        }
      }
    }
  }
  if (!best) return null
  const name = map.sources[best.source]
  if (typeof name !== 'string') return null
  const root = typeof map.sourceRoot === 'string' ? map.sourceRoot : ''
  return {
    source: root && !name.startsWith(root) ? `${root}${name}` : name,
    line: best.line + 1,
    column: best.column + 1,
  }
}

/** A source map's file name as the project names it, without a bundler's scheme or query. */
export function projectPath(source: string): string {
  return source
    .replace(/^webpack:\/\/[^/]*\//, '')
    .replace(/^(file|vite):\/\//, '')
    .replace(/[?#].*$/, '')
    .replace(/^\.\//, '')
}

async function fetchText(contents: WebContents, url: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_MS)
  try {
    const response = await contents.session.fetch(url, { signal: controller.signal })
    if (!response.ok) return null
    const text = await response.text()
    return text.length > MAX_SCRIPT_CHARS ? null : text
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A served script's place in the project's source, through its source map: inline, as Vite and
 * webpack's dev servers write it, or a file of the page's own origin. Only the page's origin is
 * read, so a pick never makes the browser fetch another site.
 */
export async function mapThroughSource(
  contents: WebContents,
  frame: { url: string; line: number; column: number },
): Promise<SourceLocation | null> {
  const page = URL.parse(contents.getURL())
  const script = URL.parse(frame.url)
  if (!page || !script || script.origin !== page.origin) return null
  const text = await fetchText(contents, script.href)
  const reference = text ? /\/\/[#@] sourceMappingURL=(\S+)\s*$/.exec(text.trimEnd())?.[1] : null
  let map: SourceMap | null = null
  try {
    if (reference?.startsWith('data:')) {
      const comma = reference.indexOf(',')
      const body = reference.slice(comma + 1)
      map = JSON.parse(
        /;base64/.test(reference.slice(0, comma))
          ? Buffer.from(body, 'base64').toString('utf8')
          : decodeURIComponent(body),
      ) as SourceMap
    } else if (reference) {
      const mapUrl = URL.parse(reference, script.href)
      if (mapUrl && mapUrl.origin === page.origin) {
        const json = await fetchText(contents, mapUrl.href)
        if (json) map = JSON.parse(json) as SourceMap
      }
    }
  } catch {
    map = null
  }
  const found = map ? originalPosition(map, frame.line, frame.column) : null
  if (found) {
    return {
      file: projectPath(found.source),
      line: found.line,
      column: found.column,
      from: 'stack',
    }
  }
  // No map: the served path is the best name there is.
  return {
    file: projectPath(script.pathname.replace(/^\//, '')),
    line: frame.line,
    column: frame.column,
    from: 'stack',
  }
}

/** The location a page's answer to FIND_SOURCE names, its stack mapped when it gave one. */
export async function sourceOf(
  contents: WebContents,
  found: unknown,
): Promise<SourceLocation | null> {
  if (typeof found !== 'object' || found === null) return null
  const value = found as Record<string, unknown>
  if (value.from === 'stack') {
    const frame = typeof value.stack === 'string' ? appFrame(value.stack) : null
    return frame ? mapThroughSource(contents, frame) : null
  }
  const file = typeof value.file === 'string' ? value.file.slice(0, 500) : ''
  if (!file) return null
  const from = value.from
  if (from !== 'attribute' && from !== 'react' && from !== 'svelte' && from !== 'vue') return null
  const int = (n: unknown): number | null =>
    typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 10_000_000 ? n : null
  return { file, line: int(value.line), column: int(value.column), from }
}
