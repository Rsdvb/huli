import { describe, expect, it } from 'vitest'
import cases from './fixtures/ax-cases.json'
import checkout from './fixtures/ax-checkout.json'
import { buildOutline, MAX_TEXT_CHARS, mergeFrames, outlineText, type AXNode } from './outline'

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
      '- banner:',
      '  - navigation:',
      '    - link "Home" [ref=e1]',
      '    - link "Cart" [ref=e2]',
      '- main:',
      '  - heading "Checkout" [level=1]',
      '  - paragraph: Review your order before paying.',
      '  - text: Subtotal',
      '  - text: $40.00',
      '  - text: Total due $42.00',
      '  - paragraph: Hello world and more text.',
      '  - list:',
      '    - listitem: Apples',
      '    - listitem:',
      '      - text: Bananas',
      '      - link "remove" [ref=e3]',
      '    - listitem: Cherries',
      '  - list:',
      '    - listitem: First step',
      '    - listitem: Second step',
      '  - alert: Network error',
      '  - status: Saving…',
      '  - text: Card declined',
      '  - button "Pay now" [ref=e4]',
      '  - button "Close" [ref=e5]: ×',
      '  - textbox "Email" [value="a@b.c"] [ref=e6]',
      '  - table:',
      '    - row:',
      '      - columnheader "Item"',
      '      - columnheader "Qty"',
      '    - row:',
      '      - cell "Widget"',
      '      - cell "2"',
      '  - list:',
      '    - term "Shipping"',
      '    - definition: Free',
      '  - text: Line one',
      '  - text: Line two',
      '  - region "Promo":',
      '    - paragraph: Use code SAVE10',
      '  - iframe:',
      '    - paragraph: Inside frame',
      '    - button "Frame button" [ref=e7]',
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
    expect(lines).toContain('- link "Read more" [ref=e11]')
    expect(lines).toContain('- generic "Labelled box": Inner text')
  })

  it('gives fields a ref and their value once, content-editable ones too', () => {
    const lines = buildOutline((cases as AXNode[][])[0]!).lines
    expect(lines[0]).toBe('- textbox [value="Editable rich text"] [ref=e1]')
    expect(lines[1]).toBe('- textbox [value="Area value"] [ref=e2]')
    expect(lines).toContain('- searchbox "Search docs" [ref=e3]')
    expect(lines).toContain('  - button "No" [disabled] [ref=e10]')
    expect(lines.join('\n')).not.toMatch(/listitem \[level/)
  })

  it('reads text in an open shadow root and in a dialog', () => {
    const lines = buildOutline((cases as AXNode[][])[0]!).lines
    expect(lines).toEqual(
      expect.arrayContaining([
        '  - paragraph: Shadow text',
        '- dialog "Confirm":',
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
      '  - iframe',
      '- paragraph: Inside frame',
      '- button "Frame button" [ref=e7]',
    ])
  })
})
