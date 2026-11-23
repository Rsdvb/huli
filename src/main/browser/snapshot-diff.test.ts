import { describe, expect, it } from 'vitest'
import { diffOutline, editScript } from './snapshot-diff'

const before = [
  '- banner [ref=e1]:',
  '  - link "Home" [ref=e2]',
  '- main [ref=e3]:',
  '  - heading "Checkout" [level=1]',
  '  - form [ref=e4]:',
  '    - textbox "Card" [ref=e5]',
  '    - button "Pay" [ref=e6]',
  '  - status: Ready',
  '- contentinfo [ref=e7]:',
  '  - text: © 2026',
]

describe('the changes between two outlines', () => {
  it('shows each change under the unchanged elements that hold it', () => {
    const after = [
      ...before.slice(0, 5),
      '    - textbox "Card" [value="4242"] [ref=e5]',
      '    - button "Pay" [disabled] [ref=e6]',
      '    - alert: Card declined',
      '  - status: Ready',
      ...before.slice(8),
    ]
    expect(diffOutline(before, after)).toEqual([
      '  - main [ref=e3]:',
      '    - form [ref=e4]:',
      '-     - textbox "Card" [ref=e5]',
      '-     - button "Pay" [ref=e6]',
      '+     - textbox "Card" [value="4242"] [ref=e5]',
      '+     - button "Pay" [disabled] [ref=e6]',
      '+     - alert: Card declined',
    ])
  })

  it('names a holder once for changes in different places under it', () => {
    const after = before.map((line) =>
      line === '  - status: Ready'
        ? '  - status: Paid'
        : line === '  - text: © 2026'
          ? '  - text: © 2027'
          : line,
    )
    expect(diffOutline(before, after)).toEqual([
      '  - main [ref=e3]:',
      '-   - status: Ready',
      '+   - status: Paid',
      '  - contentinfo [ref=e7]:',
      '-   - text: © 2026',
      '+   - text: © 2027',
    ])
  })

  it('shows a removed element under where it was', () => {
    const after = before.filter((line) => !line.includes('heading'))
    expect(diffOutline(before, after)).toEqual([
      '  - main [ref=e3]:',
      '-   - heading "Checkout" [level=1]',
    ])
  })

  it('is empty when nothing changed, and null when too much did', () => {
    expect(diffOutline(before, [...before])).toEqual([])
    const other = before.map((line) => `${line} x`)
    expect(diffOutline(before, other, 5)).toBeNull()
  })

  it('finds the shortest script, which rebuilds the new outline', () => {
    const a = ['a', 'b', 'c', 'a', 'b', 'b', 'a']
    const b = ['c', 'b', 'a', 'b', 'a', 'c']
    const script = editScript(a, b)!
    expect(script.filter((edit) => edit.kind !== 0)).toHaveLength(5)
    expect(script.filter((edit) => edit.kind !== 2).map((edit) => edit.line)).toEqual(b)
    expect(script.filter((edit) => edit.kind !== 1).map((edit) => edit.line)).toEqual(a)
  })
})
