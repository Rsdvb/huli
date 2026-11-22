// Comments on elements of a page in a session's browser, picked in the pane's pick mode, kept in
// the session's draft beside its comments on diff lines until they go to its agent together as
// one message. Main reads an element's place in the page; the selector is made here, so main and
// the tests share it.

import type { Attachment } from './thread'
import { isAttachment } from './thread'

/**
 * One element on the way from a picked element up to its document or shadow root, as the page
 * reported it: the element first, the root's child last.
 */
export interface ElementStep {
  /** Its local name, lower case. */
  tag: string
  id: string | null
  classes: string[]
  /** The attributes a selector may name it by, of `SELECTOR_ATTRIBUTES`. */
  attrs: Record<string, string>
  /** Its place among its parent's children of the same tag, from 1. */
  nth: number
  /** How many of its parent's children have its tag, itself included. */
  ofType: number
}

/** The attributes a selector may use, the steadiest first. */
export const SELECTOR_ATTRIBUTES = [
  'data-testid',
  'data-test-id',
  'data-test',
  'data-cy',
  'data-qa',
  'name',
  'aria-label',
  'placeholder',
  'title',
  'alt',
  'for',
  'type',
  'role',
] as const

const TEST_ATTRIBUTES = new Set(['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'])

/** The most steps a path holds, and the classes and attribute characters a step keeps. */
export const MAX_STEPS = 32
const MAX_CLASSES = 8
const MAX_NAME_CHARS = 64
const MAX_ATTRIBUTE_CHARS = 80

/** An element's text as a note quotes it. */
export const MAX_ELEMENT_TEXT = 300
export const MAX_SELECTOR = 1024
export const MAX_PAGE_NOTES = 20
export const MAX_PAGE_NOTE_TEXT = 4000
const MAX_URL = 2048
const MAX_LABEL = 200
const MAX_TITLE = 300

/**
 * A CSS identifier for `value`, escaped as `CSS.escape` does, which neither main nor the tests
 * have (https://drafts.csswg.org/cssom/#serialize-an-identifier).
 */
export function cssIdent(value: string): string {
  let out = ''
  const first = value.codePointAt(0)
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    const char = value[i]!
    if (code === 0) out += '\uFFFD'
    else if ((code >= 0x1 && code <= 0x1f) || code === 0x7f) out += `\\${code.toString(16)} `
    else if (i === 0 && code >= 0x30 && code <= 0x39) out += `\\${code.toString(16)} `
    else if (i === 1 && code >= 0x30 && code <= 0x39 && first === 0x2d) {
      out += `\\${code.toString(16)} `
    } else if (i === 0 && code === 0x2d && value.length === 1) out += '\\-'
    else if (
      code >= 0x80 ||
      code === 0x2d ||
      code === 0x5f ||
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a)
    ) {
      out += char
    } else out += `\\${char}`
  }
  return out
}

/** A double-quoted CSS string for an attribute's value. */
export function cssString(value: string): string {
  const escaped = value
    .replace(/[\\"]/g, '\\$&')
    .replace(/[\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)
  return `"${escaped}"`
}

/**
 * Whether an id or class reads as a name a person gave, which survives a rebuild, rather than one
 * a framework or a CSS-in-JS tool made up: React's `:r1:`, `ember123`, `css-1q2w3e`, a hash.
 */
export function isSteadyName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_NAME_CHARS) return false
  if (/^[:_\d-]|:$/.test(name)) return false
  if (/\d{3,}/.test(name)) return false
  // A hash: a run of hex digits mixing letters and numbers, or a styled-components class.
  if (/[0-9a-f]{6,}/i.test(name) && /\d/.test(name) && /[a-f]/i.test(name)) return false
  if (/^(css|sc|jsx|emotion|svelte|astro|tw)-[a-z0-9]{4,}$/i.test(name)) return false
  if (/^[a-z]{1,3}[A-Z0-9][a-zA-Z0-9]{4,}$/.test(name) && /\d/.test(name)) return false
  return true
}

/** A step's own part with nothing that tells it from its siblings: `tag.a.b`, or the tag. */
function tagWithClasses(step: ElementStep, count: number): string {
  const classes = step.classes.filter(isSteadyName).slice(0, count)
  return step.tag + classes.map((name) => `.${cssIdent(name)}`).join('')
}

/** The step's attribute selectors, the steadiest first: a test id, its name, its label. */
function attributeParts(step: ElementStep): string[] {
  const parts: string[] = []
  for (const name of SELECTOR_ATTRIBUTES) {
    const value = step.attrs[name]
    if (value === undefined || value === '' || value.length > MAX_ATTRIBUTE_CHARS) continue
    if (name === 'type' || name === 'role') continue
    const part = `[${name}=${cssString(value)}]`
    parts.push(TEST_ATTRIBUTES.has(name) ? part : `${step.tag}${part}`)
  }
  return parts
}

/** Whether a step anchors a path: an id or a test id that names it alone in most pages. */
function anchorOf(step: ElementStep): string | null {
  if (step.id && isSteadyName(step.id)) return `#${cssIdent(step.id)}`
  for (const name of TEST_ATTRIBUTES) {
    const value = step.attrs[name]
    if (value && value.length <= MAX_ATTRIBUTE_CHARS) return `[${name}=${cssString(value)}]`
  }
  return null
}

/** A step told apart from its siblings by its place, when it has any of its tag. */
function placed(step: ElementStep, base = step.tag): string {
  return step.ofType > 1 ? `${base}:nth-of-type(${step.nth})` : base
}

/**
 * The selectors that may name the element `path` starts with, the steadiest and shortest first:
 * its id or test id, its name or label, its tag and classes, those under the nearest anchored
 * ancestor, and last the full path by place from the root, which only one element matches. The
 * page keeps the first that matches the element alone.
 */
export function selectorCandidates(path: readonly ElementStep[]): string[] {
  if (path.length === 0) return []
  const steps = path.slice(0, MAX_STEPS)
  const target = steps[0]!
  const out: string[] = []
  const add = (selector: string): void => {
    if (selector.length <= MAX_SELECTOR && !out.includes(selector)) out.push(selector)
  }
  const anchor = anchorOf(target)
  if (anchor) add(anchor)
  const own = [...attributeParts(target), tagWithClasses(target, 2), tagWithClasses(target, 1)]
  for (const part of own) add(part)
  // Under each ancestor that anchors, nearest first: by its own part, then by the path between.
  for (let depth = 1; depth < steps.length; depth++) {
    const ancestor = anchorOf(steps[depth]!)
    if (!ancestor) continue
    for (const part of own) add(`${ancestor} ${part}`)
    const between = steps
      .slice(0, depth)
      .reverse()
      .map((step) => placed(step, tagWithClasses(step, 1)))
    add([ancestor, ...between].join(' > '))
    break
  }
  for (const part of own) add(placed(target, part))
  // Only one element sits at each place from the root down.
  add(
    steps
      .slice()
      .reverse()
      .map((step) => placed(step))
      .join(' > '),
  )
  return out
}

/** How the element reads in a label, as DevTools names it: `button#save.primary`. */
export function elementLabel(step: ElementStep): string {
  const id = step.id ? `#${step.id}` : ''
  const classes = step.classes
    .slice(0, 2)
    .map((name) => `.${name}`)
    .join('')
  return `${step.tag}${id}${classes}`.slice(0, MAX_LABEL)
}

/** An element's text as a note quotes it: its runs of white space as one, trimmed and cut. */
export function elementText(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_ELEMENT_TEXT ? `${flat.slice(0, MAX_ELEMENT_TEXT - 1)}…` : flat
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 100_000

/** A path as the page reported it, its steps cut to size; null when it is none. */
export function parseElementPath(value: unknown): ElementStep[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const steps: ElementStep[] = []
  for (const item of value.slice(0, MAX_STEPS)) {
    if (!isRecord(item)) return null
    const { tag, id, classes, attrs, nth, ofType } = item
    if (typeof tag !== 'string' || !/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/.test(tag)) return null
    if (id !== null && typeof id !== 'string') return null
    if (!Array.isArray(classes) || !isRecord(attrs) || !isCount(nth) || !isCount(ofType)) {
      return null
    }
    const kept: Record<string, string> = {}
    for (const name of SELECTOR_ATTRIBUTES) {
      const attr = attrs[name]
      if (typeof attr === 'string') kept[name] = attr.slice(0, MAX_ATTRIBUTE_CHARS + 1)
    }
    steps.push({
      tag,
      id: typeof id === 'string' && id.length > 0 ? id.slice(0, MAX_NAME_CHARS + 1) : null,
      classes: classes
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
        .slice(0, MAX_CLASSES)
        .map((name) => name.slice(0, MAX_NAME_CHARS + 1)),
      attrs: kept,
      nth: Math.min(nth, ofType),
      ofType,
    })
  }
  return steps
}

/** A rectangle in the page's CSS pixels. */
export interface PageBox {
  x: number
  y: number
  width: number
  height: number
}

/** What main tells the pane of an element the user clicked in pick mode. */
export interface ElementPick {
  url: string
  title: string | null
  selector: string
  label: string
  text: string
  /** The element's box in the page's viewport, in its CSS pixels. */
  box: PageBox
  viewport: { width: number; height: number }
  /** The box in the view's own pixels, where the pane draws its outline and the comment's box. */
  frame: PageBox
  /** The page as it showed, a PNG `data:` URL: the pane's still, and the screenshot's source. */
  still: string
  /** The element's visible part in the still's pixels; null when none of it is in view. */
  crop: PageBox | null
}

/** The pick mode's outline color, the theme's accent as the pane reads it. */
export interface PickColor {
  r: number
  g: number
  b: number
}

/** What main tells the pane of its pick mode: an element clicked, or the mode ended. */
export type PickEvent =
  | { sessionId: string; kind: 'picked'; pick: ElementPick }
  /** Escape in the page, another tab or page, or the agent taking the page. */
  | { sessionId: string; kind: 'ended' }

export interface PageNote {
  id: string
  url: string
  title: string | null
  selector: string
  label: string
  /** The element's visible text, trimmed; empty for one without. */
  text: string
  box: PageBox
  viewport: { width: number; height: number }
  /** The host's record of the element's screenshot, which goes with the message as an image. */
  shot: Attachment | null
  /** The other host that holds the screenshot's record; absent for this computer's. */
  shotHost?: string
  comment: string
  /** When it was written, in ms. */
  at: number
}

const isSize = (value: unknown): boolean =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000

function isBox(value: unknown): value is PageBox {
  return (
    isRecord(value) &&
    isSize(value.x) &&
    isSize(value.y) &&
    isSize(value.width) &&
    isSize(value.height)
  )
}

const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length <= max

/** A note as stored in a draft, which another version of the app may have written. */
export function isPageNote(value: unknown): value is PageNote {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    value.id.length <= 64 &&
    isText(value.url, MAX_URL) &&
    value.url.length > 0 &&
    (value.title === null || isText(value.title, MAX_TITLE)) &&
    isText(value.selector, MAX_SELECTOR) &&
    value.selector.length > 0 &&
    isText(value.label, MAX_LABEL) &&
    isText(value.text, MAX_ELEMENT_TEXT) &&
    isBox(value.box) &&
    isRecord(value.viewport) &&
    isSize(value.viewport.width) &&
    isSize(value.viewport.height) &&
    (value.shot === null || isAttachment(value.shot)) &&
    (value.shotHost === undefined || isText(value.shotHost, 64)) &&
    isText(value.comment, MAX_PAGE_NOTE_TEXT) &&
    typeof value.at === 'number'
  )
}

/** The stored notes that still read as notes, as many as a draft keeps. */
export function parsePageNotes(value: unknown): PageNote[] {
  return Array.isArray(value) ? value.filter(isPageNote).slice(0, MAX_PAGE_NOTES) : []
}

const round = (value: number): number => Math.round(value)

/** A note of `comment` on the element `pick` names, its screenshot's record in `shot`. */
export function newPageNote(
  input: { id: string; comment: string; at: number; shot: Attachment | null; shotHost?: string },
  pick: Omit<ElementPick, 'still' | 'crop' | 'frame'>,
): PageNote {
  return {
    id: input.id,
    url: pick.url.slice(0, MAX_URL),
    title: pick.title === null ? null : pick.title.slice(0, MAX_TITLE),
    selector: pick.selector.slice(0, MAX_SELECTOR),
    label: pick.label.slice(0, MAX_LABEL),
    text: elementText(pick.text),
    box: {
      x: round(pick.box.x),
      y: round(pick.box.y),
      width: round(pick.box.width),
      height: round(pick.box.height),
    },
    viewport: { width: round(pick.viewport.width), height: round(pick.viewport.height) },
    shot: input.shot,
    ...(input.shotHost ? { shotHost: input.shotHost } : {}),
    comment: input.comment.slice(0, MAX_PAGE_NOTE_TEXT),
    at: input.at,
  }
}

/** The words the message puts around the notes, in the user's language. */
export interface PageNoteLabels {
  /** The line above the notes, for `count` of them. */
  intro: (count: number) => string
  /** `Page`, before the address. */
  page: string
  selector: string
  text: string
  /** The element's box: its size and where it is in the viewport. */
  box: (box: PageBox, viewport: { width: number; height: number }) => string
  /** The screenshot that goes as the message's `index`th image, from 1. */
  shot: (index: number) => string
}

/** A code span that holds `text` whatever backticks it has. */
function code(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  const ticks = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${ticks}${pad}${text}${pad}${ticks}`
}

/**
 * The message the notes go to the agent as, in Markdown any agent reads: for each, the element's
 * page, selector, text and box, which image is its screenshot, then the comment. `firstImage` is
 * the number of the first screenshot among the message's images.
 */
export function pageNotesMessage(
  notes: readonly PageNote[],
  labels: PageNoteLabels,
  firstImage = 1,
): string {
  const parts = [labels.intro(notes.length)]
  let image = firstImage
  notes.forEach((note, index) => {
    const lines = [
      `### ${index + 1}. ${code(note.label)}`,
      '',
      `- ${labels.page}: ${note.url}`,
      `- ${labels.selector}: ${code(note.selector)}`,
      ...(note.text ? [`- ${labels.text}: ${code(note.text)}`] : []),
      `- ${labels.box(note.box, note.viewport)}`,
      ...(note.shot ? [`- ${labels.shot(image++)}`] : []),
      '',
      note.comment.trim(),
    ]
    parts.push(lines.join('\n'))
  })
  return parts.join('\n\n')
}
