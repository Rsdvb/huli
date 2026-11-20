import { describe, expect, it } from 'vitest'
import { resultMarkdown } from './result-text'

describe("a tool's text result", () => {
  it('indents JSON in a fence', () => {
    expect(resultMarkdown('{"ok":true,"items":[1,2]}')).toBe(
      '```json\n{\n  "ok": true,\n  "items": [\n    1,\n    2\n  ]\n}\n```',
    )
  })

  it('fences a log, whose lines Markdown would run together', () => {
    expect(resultMarkdown('12:00:01 started\n12:00:02 listening on 3000\n')).toBe(
      '```\n12:00:01 started\n12:00:02 listening on 3000\n```',
    )
  })

  it('lists links one per line', () => {
    expect(resultMarkdown('https://a.dev/x\nhttps://b.dev/y')).toBe(
      '- <https://a.dev/x>\n- <https://b.dev/y>',
    )
  })

  it('keeps Markdown, a line and paragraphs as they are', () => {
    expect(resultMarkdown('# Title\n\n- one\n- two')).toBe('# Title\n\n- one\n- two')
    expect(resultMarkdown('Done.')).toBe('Done.')
    expect(resultMarkdown('First.\n\nSecond.')).toBe('First.\n\nSecond.')
    expect(resultMarkdown('[1, 2')).toBe('[1, 2')
  })

  it('fences text that holds a fence with a longer one', () => {
    expect(resultMarkdown('a\n```\nb')).toBe('a\n```\nb')
    expect(resultMarkdown('line one\nline two ```')).toBe('````\nline one\nline two ```\n````')
  })
})
