import { describe, expect, it } from 'vitest'
import { splitMessage, utf16Length, utf8Length } from './split'

describe('splitMessage', () => {
  it('sends a short text as one piece, and nothing for an empty one', () => {
    expect(splitMessage('hello\nworld', 100)).toEqual(['hello\nworld'])
    expect(splitMessage('  \n\n ', 100)).toEqual([])
  })

  it('keeps every piece within the limit', () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(i % 37)}`).join('\n')
    const pieces = splitMessage(text, 300)
    expect(pieces.length).toBeGreaterThan(1)
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(300)
    expect(pieces.join('\n').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''))
  })

  it('cuts at a paragraph before a line, and at a line before a space', () => {
    const text = `${'a'.repeat(60)}\n\n${'b'.repeat(30)}\n${'c'.repeat(30)}`
    expect(splitMessage(text, 100)).toEqual([
      'a'.repeat(60),
      `${'b'.repeat(30)}\n${'c'.repeat(30)}`,
    ])
    const words = `${'word '.repeat(30)}`.trim()
    for (const piece of splitMessage(words, 40)) {
      expect(piece.startsWith(' ')).toBe(false)
      expect(piece.endsWith('wor')).toBe(false)
    }
  })

  it('closes a code block cut in two and opens it again with its language', () => {
    const code = Array.from({ length: 40 }, (_, i) => `console.log(${i})`).join('\n')
    const text = `Here:\n\n\`\`\`ts\n${code}\n\`\`\`\n\nDone.`
    const pieces = splitMessage(text, 200)
    expect(pieces.length).toBeGreaterThan(2)
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(200)
      const fences = piece.match(/^```/gm) ?? []
      expect(fences.length % 2).toBe(0)
    }
    expect(pieces[1]!.startsWith('```ts\n')).toBe(true)
    expect(pieces.at(-1)!.endsWith('Done.')).toBe(true)
    const body = pieces
      .join('\n')
      .split('\n')
      .filter((line) => line.startsWith('console.log'))
    expect(body).toHaveLength(40)
  })

  it('cuts a line with no space anywhere, never inside a character', () => {
    const text = '😀'.repeat(100)
    const pieces = splitMessage(text, 51)
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(51)
      expect(piece).not.toMatch(/[\ud800-\udbff]$/)
      expect(piece).not.toMatch(/^[\udc00-\udfff]/)
    }
    expect(pieces.join('')).toBe(text)
  })

  it('counts as the platform does', () => {
    const text = '中文'.repeat(100)
    const pieces = splitMessage(text, 90, utf8Length)
    for (const piece of pieces) expect(Buffer.byteLength(piece)).toBeLessThanOrEqual(90)
    expect(pieces.join('')).toBe(text)
    expect(splitMessage(text, 200, utf16Length)).toEqual([text])
  })

  it('says how much was left out past the most pieces', () => {
    const text = Array.from({ length: 50 }, (_, i) => `${i}`.padEnd(40, '.')).join('\n\n')
    const pieces = splitMessage(text, 50, utf16Length, (n) => `(${n} more)`, 3)
    expect(pieces).toHaveLength(3)
    expect(pieces[2]).toMatch(/\(\d+ more\)$/)
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(50)
  })
})
