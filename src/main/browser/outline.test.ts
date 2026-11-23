import { describe, expect, it } from 'vitest'
import cases from './fixtures/ax-cases.json'
import checkout from './fixtures/ax-checkout.json'
import {
  buildOutline,
  MAX_TEXT_CHARS,
  mergeFrames,
  outlineText,
  RefRegistry,
  type AXNode,
} from './outline'

// The fixtures are Accessibility.getFullAXTree of the pages beside them, one tree per frame, as
// Electron 44's Chromium reports them, trimmed to the fields the outline reads.
const CHECKOUT_IFRAME = 58

function checkoutTree(): AXNode[] {
  const [page, frame] = checkout as AXNode[][]
  return mergeFrames(page!, [{ owner: CHECKOUT_IFRAME, nodes: frame! }])
}

let next = 0

/** A node of a hand-made tree; its children follow it in the list it returns. */
function node(role: string, name: string, children: AXNode[][] = [], extra: Partial<AXNode> = {}) {
  const id = `n${++next}`
  const own: AXNode = {
    nodeId: id,
    role: { value: role },
    name: { value: name },
    backendDOMNodeId: next,
    ...extra,
  }
  const tops = children.map((list) => list[0]!)
  for (const top of tops) top.parentId = id
  own.childIds = tops.map((top) => top.nodeId)
  return [own, ...children.flat()]
}

const text = (value: string, extra: Partial<AXNode> = {}) =>
  node('StaticText', value, [node('InlineTextBox', value)], extra)

describe('the snapshot outline', () => {
  it('keeps the text of paragraphs, wrappers, list items and alerts', () => {
    expect(buildOutline(checkoutTree()).lines).toEqual([
      '- banner [ref=e1]:',
      '  - navigation [ref=e2]:',
      '    - link "Home" [ref=e3]',
      '    - link "Cart" [ref=e4]',
      '- main [ref=e5]:',
      '  - heading "Checkout" [level=1]',
      '  - paragraph: Review your order before paying.',
      '  - text: Subtotal',
      '  - text: $40.00',
      '  - text: Total due $42.00',
      '  - paragraph: Hello world and more text.',
      '  - list [ref=e6]:',
      '    - listitem: Apples',
      '    - listitem:',
      '      - text: Bananas',
      '      - link "remove" [ref=e7]',
      '    - listitem: Cherries',
      '  - list [ref=e8]:',
      '    - listitem: First step',
      '    - listitem: Second step',
      '  - alert: Network error',
      '  - status: Saving…',
      '  - text: Card declined',
      '  - button "Pay now" [ref=e9]',
      '  - button "Close" [ref=e10]: ×',
      '  - textbox "Email" [value="a@b.c"] [ref=e11]',
      '  - table [ref=e12]:',
      '    - row:',
      '      - columnheader "Item"',
      '      - columnheader "Qty"',
      '    - row:',
      '      - cell "Widget"',
      '      - cell "2"',
      '  - list [ref=e13]:',
      '    - term "Shipping"',
      '    - definition: Free',
      '  - text: Line one',
      '  - text: Line two',
      '  - region "Promo" [ref=e14]:',
      '    - paragraph: Use code SAVE10',
      '  - iframe [ref=e15]:',
      '    - paragraph: Inside frame',
      '    - button "Frame button" [ref=e16]',
    ])
  })

  it('leaves out what the page hides, list markers and text boxes', () => {
    const outline = outlineText(
      { title: 'Checkout', url: 'http://localhost/' },
      buildOutline(checkoutTree()),
    )
    expect(outline).not.toMatch(/Hidden from AT|Display none text|listmarker|inlinetextbox|•/i)
    // The field's value and the label's words show once, on the field.
    expect(outline.match(/a@b\.c/g)).toHaveLength(1)
    expect(outline.match(/Email/g)).toHaveLength(1)
  })

  it('runs inline formatting on with its text and breaks lines where the page does', () => {
    const lines = buildOutline((cases as AXNode[][])[0]!).lines
    expect(lines).toContain('- text: Inline lonely span')
    expect(lines).toEqual(expect.arrayContaining(['  - text: Price: $9', '  - text: Tax: $1']))
    expect(lines).toContain('- link "Read more" [ref=e13]')
    expect(lines).toContain('- generic "Labelled box": Inner text')
  })

  it('gives fields a ref and their value once, content-editable ones too', () => {
    const lines = buildOutline((cases as AXNode[][])[0]!).lines
    expect(lines[0]).toBe('- textbox [value="Editable rich text"] [ref=e1]')
    expect(lines[1]).toBe('- textbox [value="Area value"] [ref=e2]')
    expect(lines).toContain('- searchbox "Search docs" [ref=e3]')
    expect(lines).toContain('  - button "No" [disabled] [ref=e12]')
    expect(lines.join('\n')).not.toMatch(/listitem \[level/)
  })

  it('reads text in an open shadow root and in a dialog', () => {
    const lines = buildOutline((cases as AXNode[][])[0]!).lines
    expect(lines).toEqual(
      expect.arrayContaining([
        '  - paragraph: Shadow text',
        '- dialog "Confirm" [ref=e10]:',
        '  - paragraph: Are you sure?',
      ]),
    )
  })

  it('leaves out text the tree marks ignored', () => {
    const tree = node('RootWebArea', 'Page', [
      node('generic', '', [text('Shown'), text('Hidden', { ignored: true })]),
    ])
    expect(buildOutline(tree).lines).toEqual(['- text: Shown'])
  })

  it('cuts a long text, and the outline at its length', () => {
    const long = 'word '.repeat(200)
    const tree = node('RootWebArea', 'Page', [node('paragraph', '', [text(long)])])
    const [line] = buildOutline(tree).lines
    expect(line!.length).toBeLessThan(MAX_TEXT_CHARS + 20)
    expect(line).toMatch(/…$/)

    const many = node(
      'RootWebArea',
      'Page',
      Array.from({ length: 50 }, (_, i) => node('paragraph', '', [text(`Paragraph ${i}`)])),
    )
    const outline = buildOutline(many, { maxChars: 200 })
    expect(outline.lines.join('\n').length).toBeLessThanOrEqual(200)
    expect(outline.more).toBe(50 - outline.lines.length)
    expect(outlineText({ title: 'P', url: 'http://localhost/' }, outline)).toMatch(
      new RegExp(`… ${outline.more} more lines$`),
    )
  })

  it('keeps a frame whose element is not found after the page', () => {
    const [page, frame] = checkout as AXNode[][]
    const lines = buildOutline(mergeFrames(page!, [{ owner: null, nodes: frame! }])).lines
    expect(lines.slice(-3)).toEqual([
      '  - iframe [ref=e15]',
      '- paragraph: Inside frame',
      '- button "Frame button" [ref=e16]',
    ])
  })
})

describe('a scoped outline', () => {
  it('shows one element and what it holds', () => {
    const lines = buildOutline(checkoutTree(), { root: 24 }).lines
    expect(lines).toEqual([
      '- list [ref=e1]:',
      '  - listitem: Apples',
      '  - listitem:',
      '    - text: Bananas',
      '    - link "remove" [ref=e2]',
      '  - listitem: Cherries',
    ])
    expect(buildOutline(checkoutTree(), { root: 99_999 }).found).toBe(false)
  })

  it('stops at a depth, marking what it left out', () => {
    const lines = buildOutline(checkoutTree(), { depth: 1 }).lines
    expect(lines).toContain('  - list [ref=e6]: …')
    expect(lines).toContain('  - paragraph: Review your order before paying.')
    expect(lines).not.toContain('    - listitem: Apples')
    expect(buildOutline(checkoutTree(), { depth: 0 }).lines).toEqual([
      '- banner [ref=e1]: …',
      '- main [ref=e5]: …',
    ])
  })
})

describe('refs', () => {
  it('stay the same element’s from one outline to the next', () => {
    const registry = new RefRegistry()
    const refFor = (backend: number) => registry.refFor(backend)
    const whole = buildOutline(checkoutTree(), { refFor }).lines
    expect(whole).toContain('      - link "remove" [ref=e7]')
    // The list alone, and the page again, give its link the ref it had.
    expect(buildOutline(checkoutTree(), { refFor, root: 24 }).lines).toContain(
      '    - link "remove" [ref=e7]',
    )
    expect(buildOutline(checkoutTree(), { refFor }).lines).toEqual(whole)
    expect(registry.backendOf('e7')).toBe(27)
  })

  it('number a new element on and let the oldest go past the cap', () => {
    const registry = new RefRegistry(2)
    expect([1, 2, 1, 3].map((backend) => registry.refFor(backend))).toEqual([
      'e1',
      'e2',
      'e1',
      'e3',
    ])
    expect(registry.backendOf('e1')).toBeUndefined()
    expect(registry.backendOf('e3')).toBe(3)
  })
})
