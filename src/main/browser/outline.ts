// The outline of a page's accessibility tree that an agent reads: every element it can act on,
// with a ref, and the page's text under the element that holds it, bounded for a model's reading.
// Its text follows Playwright's aria snapshot (Copyright (c) Microsoft Corporation, Apache-2.0):
// https://github.com/microsoft/playwright/blob/main/packages/injected/src/ariaSnapshot.ts

/** The outline an agent reads, before its "… N more lines" marker. */
export const MAX_SNAPSHOT_LINES = 2_000
/** The longest outline, in characters, before the same marker. */
export const MAX_SNAPSHOT_CHARS = 80_000
/** The longest text or name one line shows. */
export const MAX_TEXT_CHARS = 300
/** The refs a document keeps; the oldest go stale beyond this. */
export const MAX_REFS = 20_000

/** Accessibility node, as Accessibility.getFullAXTree reports it. */
export interface AXNode {
  nodeId: string
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  description?: { value?: string }
  value?: { value?: unknown }
  properties?: { name: string; value?: { value?: unknown } }[]
  childIds?: string[]
  backendDOMNodeId?: number
  parentId?: string
}

export interface Outline {
  lines: string[]
  /** `eN` to the node's backend id, in the order the page holds them. */
  refs: Map<string, number>
  /** Lines left out beyond the cap. */
  more: number
  /** False when the element `root` names is not in the tree. */
  found: boolean
}

export interface OutlineOptions {
  /** The ref an element gets; by default they are numbered in the order the page holds them. */
  refFor?: (backend: number) => string
  /** Only the element with this backend id and what it holds. */
  root?: number
  /** How many levels of elements under the top ones to show; all by default. */
  depth?: number
  maxLines?: number
  maxChars?: number
}

/**
 * The refs of one document's elements: an element keeps its ref from one snapshot to the next, so
 * an agent that read an earlier one acts on the same element, and a changed outline is a short
 * diff. Refs are numbered in the order the page first showed the elements.
 */
export class RefRegistry {
  private readonly refs = new Map<number, string>()
  private readonly backends = new Map<string, number>()
  private count = 0
  private readonly max: number

  constructor(max = MAX_REFS) {
    this.max = max
  }

  refFor(backend: number): string {
    const known = this.refs.get(backend)
    if (known !== undefined) return known
    const ref = `e${++this.count}`
    this.refs.set(backend, ref)
    this.backends.set(ref, backend)
    if (this.refs.size > this.max) {
      const [oldest, gone] = this.refs.entries().next().value!
      this.refs.delete(oldest)
      this.backends.delete(gone)
    }
    return ref
  }

  /** The backend id of an element a snapshot named, or undefined for a ref it never gave. */
  backendOf(ref: string): number | undefined {
    return this.backends.get(ref)
  }
}

const ROLE_NAMES: Record<string, string> = {
  RootWebArea: 'page',
  StaticText: 'text',
  TextField: 'textbox',
  SearchBox: 'searchbox',
  CheckBox: 'checkbox',
  RadioButton: 'radio',
  ComboBox: 'combobox',
  ListBox: 'listbox',
  ListBoxOption: 'option',
  MenuListPopup: 'menu',
  MenuItem: 'menuitem',
  MenuBar: 'menubar',
  Menu: 'menu',
  ToggleButton: 'button',
  DisclosureTriangle: 'button',
  PopUpButton: 'button',
  Slider: 'slider',
  SpinButton: 'spinbutton',
  ProgressIndicator: 'progressbar',
  Image: 'image',
  Iframe: 'iframe',
  Heading: 'heading',
  Paragraph: 'paragraph',
  ListItem: 'listitem',
  UnorderedList: 'list',
  OrderedList: 'list',
  DescriptionList: 'list',
  Term: 'term',
  Description: 'definition',
  Link: 'link',
  LabelText: 'label',
}

const ACTIONABLE = new Set([
  'link',
  'button',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'treeitem',
  'textfield',
])

// Elements that hold others, with a ref so that a snapshot can show one of them alone.
const SCOPABLE = new Set([
  'banner',
  'main',
  'navigation',
  'region',
  'form',
  'search',
  'complementary',
  'contentinfo',
  'article',
  'dialog',
  'alertdialog',
  'list',
  'table',
  'grid',
  'treegrid',
  'tree',
  'menu',
  'menubar',
  'tablist',
  'tabpanel',
  'toolbar',
  'group',
  'radiogroup',
  'iframe',
])

// Wrappers that add nothing an agent needs; what they hold takes their place.
const TRANSPARENT = new Set(['none', 'presentation', 'generic', 'ignored', 'label'])

// Inline formatting, whose words run on with the text around them.
const INLINE = new Set([
  'strong',
  'emphasis',
  'mark',
  'code',
  'subscript',
  'superscript',
  'deletion',
  'insertion',
  'time',
  'abbr',
])

// Fields whose value the line shows, and whose text inside is that value again.
const FIELDS = new Set(['textbox', 'searchbox', 'combobox'])

// The states a line names, as the tree's properties spell them in lower case.
const STATES = new Map([
  ['checked', 'checked'],
  ['expanded', 'expanded'],
  ['selected', 'selected'],
  ['pressed', 'pressed'],
  ['level', 'level'],
  ['invalid', 'invalid'],
  ['haspopup', 'popup'],
  ['readonly', 'readonly'],
  ['multiselectable', 'multiselectable'],
])

// Roles whose level says something; a list item's only repeats its nesting.
const LEVELED = new Set(['heading', 'treeitem'])

export function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Text cut to `max` characters, without splitting a surrogate pair. */
export function cut(text: string, max = MAX_TEXT_CHARS): string {
  if (text.length <= max) return text
  let end = max
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…`
}

function quoted(text: string): string {
  return `"${cut(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

const TEXT = 0
const ELEMENT = 1

/** A run of the page's text; an open one takes the inline text that follows it. */
interface TextItem {
  kind: typeof TEXT
  text: string
  open: boolean
}

interface ElementItem {
  kind: typeof ELEMENT
  head: string
  name: string
  children: Item[]
}

type Item = TextItem | ElementItem

function pushInline(out: Item[], text: string): void {
  const last = out[out.length - 1]
  if (last !== undefined && last.kind === TEXT && last.open) last.text += text
  else out.push({ kind: TEXT, text, open: true })
}

function closeText(out: Item[]): void {
  const last = out[out.length - 1]
  if (last !== undefined && last.kind === TEXT) last.open = false
}

/**
 * The items an element holds, its text cleaned: a run that is empty, or that the element's name
 * already says, is left out.
 */
function finish(items: Item[], name: string): Item[] {
  const said = name.toLowerCase()
  const result: Item[] = []
  for (const item of items) {
    if (item.kind === TEXT) {
      const text = clean(item.text)
      if (text === '' || (said !== '' && said.includes(text.toLowerCase()))) continue
      item.text = text
    }
    result.push(item)
  }
  return result
}

/** The outline of a page's accessibility tree, with a ref on every element an agent can act on. */
export function buildOutline(nodes: readonly AXNode[], options: OutlineOptions = {}): Outline {
  const byId = new Map<string, AXNode>()
  for (const node of nodes) byId.set(node.nodeId, node)
  const refs = new Map<string, number>()
  const seen = new Set<string>()
  const refFor = options.refFor ?? ((): string => `e${refs.size + 1}`)

  const childrenOf = (node: AXNode, out: Item[]): void => {
    const ids = node.childIds
    if (!ids) return
    for (const id of ids) {
      const child = byId.get(id)
      if (child) collect(child, out)
    }
  }

  const collect = (node: AXNode, out: Item[]): void => {
    if (seen.has(node.nodeId)) return
    seen.add(node.nodeId)
    const raw = node.role?.value ?? ''
    if (node.ignored) {
      // Hidden text is left out; what an ignored wrapper holds may still show.
      if (raw !== 'StaticText') childrenOf(node, out)
      return
    }
    switch (raw) {
      case 'RootWebArea':
        childrenOf(node, out)
        closeText(out)
        return
      case 'StaticText':
        pushInline(out, node.name?.value ?? '')
        return
      case 'InlineTextBox':
      case 'ListMarker':
        return
      case 'LineBreak':
        closeText(out)
        return
    }
    let role = ROLE_NAMES[raw] ?? raw.toLowerCase()
    const name = clean(node.name?.value ?? '')
    if (INLINE.has(role) && name === '') {
      childrenOf(node, out)
      return
    }
    let disabled = false
    let editable: unknown
    let valueText: unknown
    let states = ''
    for (const property of node.properties ?? []) {
      const key = property.name.toLowerCase()
      const value = property.value?.value
      if (key === 'disabled') disabled = value === true
      else if (key === 'editable') editable = value
      else if (key === 'valuetext') valueText = value
      else if (value !== undefined && value !== false && value !== 'false') {
        const label = STATES.get(key)
        if (label === undefined) continue
        if (key === 'level') {
          if (LEVELED.has(role)) states += ` [level=${String(value)}]`
        } else if (value === true || value === 'true') states += ` [${label}]`
        else states += ` [${label}=${String(value)}]`
      }
    }
    // A content-editable element takes typing as a field does.
    if (editable === 'richtext' && role === 'generic') role = 'textbox'
    const description = name === '' ? clean(node.description?.value ?? '') : ''
    if (TRANSPARENT.has(role) && name === '' && description === '') {
      const inner: Item[] = []
      childrenOf(node, inner)
      let items = finish(inner, '')
      if (role === 'label') {
        // A label's words are the name of the field it holds.
        const names = items.flatMap((item) =>
          item.kind === ELEMENT && item.name ? [item.name.toLowerCase()] : [],
        )
        items = items.filter(
          (item) =>
            item.kind === ELEMENT ||
            !names.some((field) => field.includes(item.text.toLowerCase())),
        )
      }
      if (items.every((item) => item.kind === TEXT)) {
        closeText(out)
        for (const item of items) out.push({ kind: TEXT, text: item.text, open: false })
        return
      }
      if (items.length === 1) {
        closeText(out)
        out.push(items[0]!)
        return
      }
      closeText(out)
      out.push({
        kind: ELEMENT,
        head: role === 'label' ? 'generic' : role,
        name: '',
        children: items,
      })
      return
    }
    let head = role
    if (name !== '') head += ` ${quoted(name)}`
    else if (description !== '') head += ` ${quoted(description)}`
    head += states
    if (disabled) head += ' [disabled]'
    const value = valueText ?? node.value?.value
    if (typeof value === 'string' && value !== '' && FIELDS.has(role))
      head += ` [value=${quoted(value.slice(0, 80))}]`
    const backend = node.backendDOMNodeId
    // A select's own list of options is the select's to act on.
    const scopable = SCOPABLE.has(role) && raw !== 'MenuListPopup'
    if ((ACTIONABLE.has(role) || scopable) && backend !== undefined) {
      const ref = refFor(backend)
      refs.set(ref, backend)
      head += ` [ref=${ref}]`
    }
    const inner: Item[] = []
    // A field's text is its value, which the line already shows.
    if (!(FIELDS.has(role) && editable !== undefined)) childrenOf(node, inner)
    closeText(out)
    out.push({ kind: ELEMENT, head, name, children: finish(inner, name) })
  }

  const top: Item[] = []
  if (options.root !== undefined) {
    const scope = nodes.find((node) => node.backendDOMNodeId === options.root)
    if (!scope) return { lines: [], refs, more: 0, found: false }
    collect(scope, top)
  } else {
    for (const node of nodes) {
      if (node.parentId === undefined || !byId.has(node.parentId)) collect(node, top)
    }
  }
  return { ...cap(render(finish(top, ''), options.depth), refs, options), found: true }
}

/**
 * The lines of the items, children indented under their element; below `depth` levels an element
 * that holds more ends in `: …`.
 */
function render(items: readonly Item[], depth?: number): string[] {
  const lines: string[] = []
  const walk = (list: readonly Item[], indent: string, level: number): void => {
    for (const item of list) {
      if (item.kind === TEXT) {
        lines.push(`${indent}- text: ${cut(item.text)}`)
        continue
      }
      const line = `${indent}- ${item.head}`
      const only = item.children.length === 1 ? item.children[0]! : null
      if (item.children.length === 0) lines.push(line)
      else if (only?.kind === TEXT) lines.push(`${line}: ${cut(only.text)}`)
      else if (depth !== undefined && level >= depth) lines.push(`${line}: …`)
      else {
        lines.push(`${line}:`)
        walk(item.children, `${indent}  `, level + 1)
      }
    }
  }
  walk(items, '', 0)
  return lines
}

function cap(
  lines: string[],
  refs: Map<string, number>,
  options: OutlineOptions,
): Omit<Outline, 'found'> {
  const maxLines = options.maxLines ?? MAX_SNAPSHOT_LINES
  const maxChars = options.maxChars ?? MAX_SNAPSHOT_CHARS
  let kept = 0
  let chars = 0
  while (kept < lines.length && kept < maxLines) {
    chars += lines[kept]!.length + 1
    if (chars > maxChars) break
    kept += 1
  }
  return {
    lines: kept < lines.length ? lines.slice(0, kept) : lines,
    refs,
    more: lines.length - kept,
  }
}

/** The text an agent reads for a snapshot: the page's title and address, then the outline. */
export function outlineText(page: { title: string | null; url: string }, outline: Outline): string {
  const head = `- Page: ${clean(page.title ?? '') || 'Untitled'} (${page.url || 'about:blank'})`
  const lines = [head, ...outline.lines]
  if (outline.more > 0) lines.push(`… ${outline.more} more lines`)
  return lines.join('\n')
}

/**
 * One tree of a page and its frames: each frame's content goes under the iframe element that holds
 * it, and a frame whose element is not found follows the page, as before. Node ids are made unique
 * across the frames.
 */
export function mergeFrames(
  page: readonly AXNode[],
  frames: readonly { owner: number | null; nodes: readonly AXNode[] }[],
): AXNode[] {
  const merged = page.slice()
  frames.forEach((frame, index) => {
    const prefix = `f${index + 1}:`
    const nodes = frame.nodes.map((node) => ({
      ...node,
      nodeId: prefix + node.nodeId,
      ...(node.parentId === undefined ? {} : { parentId: prefix + node.parentId }),
      ...(node.childIds ? { childIds: node.childIds.map((id) => prefix + id) } : {}),
    }))
    const ids = new Set(nodes.map((node) => node.nodeId))
    const root = nodes.find(
      (node) =>
        node.role?.value === 'RootWebArea' &&
        (node.parentId === undefined || !ids.has(node.parentId)),
    )
    const at =
      frame.owner === null || !root
        ? -1
        : merged.findIndex((node) => node.backendDOMNodeId === frame.owner)
    for (const node of nodes) {
      if (node === root) continue
      if (at >= 0 && node.parentId === root!.nodeId) node.parentId = merged[at]!.nodeId
      merged.push(node)
    }
    if (at >= 0) {
      const owner = merged[at]!
      merged[at] = { ...owner, childIds: [...(owner.childIds ?? []), ...(root!.childIds ?? [])] }
    }
  })
  return merged
}
