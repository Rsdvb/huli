import { describe, expect, it } from 'vitest'
import {
  cssIdent,
  cssString,
  elementLabel,
  elementText,
  isPageNote,
  isSteadyName,
  newPageNote,
  pageNotesMessage,
  parseElementPath,
  parsePageNotes,
  selectorCandidates,
  type ElementStep,
  type PageNoteLabels,
} from './page-notes'
import type { Attachment } from './thread'

const step = (tag: string, more: Partial<ElementStep> = {}): ElementStep => ({
  tag,
  id: null,
  classes: [],
  attrs: {},
  nth: 1,
  ofType: 1,
  ...more,
})

describe('cssIdent', () => {
  it('escapes as CSS.escape does', () => {
    expect(cssIdent('save')).toBe('save')
    expect(cssIdent('a.b')).toBe('a\\.b')
    expect(cssIdent('1st')).toBe('\\31 st')
    expect(cssIdent('-1x')).toBe('-\\31 x')
    expect(cssIdent('-')).toBe('\\-')
    expect(cssIdent('w-[12px]')).toBe('w-\\[12px\\]')
    expect(cssIdent('hover:bg')).toBe('hover\\:bg')
    expect(cssIdent('名前')).toBe('名前')
    expect(cssIdent('a\u0000b')).toBe('a�b')
  })

  it('quotes attribute values', () => {
    expect(cssString('Sign in')).toBe('"Sign in"')
    expect(cssString('say "hi" \\ there')).toBe('"say \\"hi\\" \\\\ there"')
    expect(cssString('two\nlines')).toBe('"two\\a lines"')
  })
})

describe('isSteadyName', () => {
  it('keeps names a person gave', () => {
    for (const name of ['login-form', 'save', 'btn-primary', 'nav__item', 'h1', 'col-2', 'mt-4']) {
      expect(isSteadyName(name), name).toBe(true)
    }
  })

  it('drops names a framework made up', () => {
    for (const name of [
      ':r1:',
      'ember123',
      'css-1q2w3e',
      'sc-bdVaJa',
      'a1b2c3d4',
      '_x9',
      '',
      '9a',
    ]) {
      expect(isSteadyName(name), name).toBe(false)
    }
  })
})

describe('selectorCandidates', () => {
  it('starts with a steady id', () => {
    const path = [step('button', { id: 'save', classes: ['btn'] }), step('form'), step('body')]
    expect(selectorCandidates(path)[0]).toBe('#save')
  })

  it('skips a generated id for a test id, then a name', () => {
    const path = [
      step('input', { id: ':r5:', attrs: { 'data-testid': 'email', name: 'email' } }),
      step('body'),
    ]
    const candidates = selectorCandidates(path)
    expect(candidates[0]).toBe('[data-testid="email"]')
    expect(candidates).toContain('input[name="email"]')
    expect(candidates.some((c) => c.includes(':r5:'))).toBe(false)
  })

  it('names classes, then the anchored ancestor, and ends with the full path', () => {
    const path = [
      step('a', { classes: ['link', 'css-9x8y7z'], nth: 2, ofType: 3 }),
      step('li', { nth: 4, ofType: 5 }),
      step('ul', { id: 'menu' }),
      step('body'),
      step('html'),
    ]
    const candidates = selectorCandidates(path)
    expect(candidates).toContain('a.link')
    expect(candidates).toContain('#menu a.link')
    expect(candidates).toContain('#menu > li:nth-of-type(4) > a.link:nth-of-type(2)')
    expect(candidates.at(-1)).toBe('html > body > ul > li:nth-of-type(4) > a:nth-of-type(2)')
    // The generated class never shows.
    expect(candidates.some((c) => c.includes('css-9x8y7z'))).toBe(false)
  })

  it('escapes what it names', () => {
    const path = [step('div', { classes: ['md:flex'], attrs: { 'aria-label': 'Say "hi"' } })]
    const candidates = selectorCandidates(path)
    expect(candidates).toContain('div[aria-label="Say \\"hi\\""]')
    expect(candidates).toContain('div.md\\:flex')
  })

  it('names nothing for no path', () => {
    expect(selectorCandidates([])).toEqual([])
  })
})

describe('parseElementPath', () => {
  it('takes what the page reported, cut to size', () => {
    const path = parseElementPath([
      {
        tag: 'div',
        id: '',
        classes: ['a', 3, ''],
        attrs: { role: 'x', onclick: 'y' },
        nth: 9,
        ofType: 2,
      },
    ])
    expect(path).toEqual([
      { tag: 'div', id: null, classes: ['a'], attrs: { role: 'x' }, nth: 2, ofType: 2 },
    ])
  })

  it('refuses what is not a path', () => {
    expect(parseElementPath([])).toBeNull()
    expect(parseElementPath('div')).toBeNull()
    expect(
      parseElementPath([{ tag: 'DIV<', id: null, classes: [], attrs: {}, nth: 1, ofType: 1 }]),
    ).toBeNull()
    expect(
      parseElementPath([{ tag: 'div', id: null, classes: [], attrs: {}, nth: 0, ofType: 1 }]),
    ).toBeNull()
  })
})

describe('labels and text', () => {
  it('labels an element as DevTools does', () => {
    expect(elementLabel(step('button', { id: 'go', classes: ['a', 'b', 'c'] }))).toBe(
      'button#go.a.b',
    )
  })

  it('quotes text on one line, cut', () => {
    expect(elementText('  Sign\n\n  in  ')).toBe('Sign in')
    const long = elementText('x'.repeat(500))
    expect(long).toHaveLength(300)
    expect(long.endsWith('…')).toBe(true)
  })
})

const shot: Attachment = {
  id: 'att-1',
  type: 'image',
  name: 'element-localhost-5173.png',
  uri: null,
  mimeType: 'image/png',
  size: 1234,
  sent: null,
  thumb: null,
  blob: null,
}

const pick = {
  url: 'http://localhost:5173/login',
  title: 'Login',
  selector: '#login > button.primary',
  label: 'button.primary',
  text: '  Sign  in ',
  box: { x: 10.4, y: 20.6, width: 100, height: 32.2 },
  viewport: { width: 1280, height: 800 },
}

const labels: PageNoteLabels = {
  intro: (count) => `Comments on the page (${count}):`,
  page: 'Page',
  selector: 'Selector',
  text: 'Text',
  box: (box, viewport) =>
    `Box: ${box.width}×${box.height} at ${box.x},${box.y} in ${viewport.width}×${viewport.height}`,
  shot: (index) => `Screenshot: image ${index}`,
}

describe('page notes', () => {
  it('makes a note that reads back from a draft', () => {
    const note = newPageNote({ id: 'n1', comment: 'Make it blue', at: 5, shot }, pick)
    expect(note.text).toBe('Sign in')
    expect(note.box).toEqual({ x: 10, y: 21, width: 100, height: 32 })
    expect(isPageNote(note)).toBe(true)
    expect(parsePageNotes([note, { ...note, id: '' }, 'x'])).toEqual([note])
    expect(isPageNote({ ...note, shot: { id: 'x' } })).toBe(false)
    expect(isPageNote({ ...note, selector: '' })).toBe(false)
    expect(parsePageNotes(null)).toEqual([])
  })

  it('writes the message with each element, its image and the comment', () => {
    const first = newPageNote({ id: 'n1', comment: ' Make it blue ', at: 1, shot }, pick)
    const second = newPageNote(
      { id: 'n2', comment: 'Hide this', at: 2, shot: null },
      { ...pick, text: '', label: 'div`x`', selector: 'div' },
    )
    const third = newPageNote({ id: 'n3', comment: 'Bigger', at: 3, shot }, pick)
    expect(pageNotesMessage([first, second, third], labels, 2)).toBe(
      [
        'Comments on the page (3):',
        [
          '### 1. `button.primary`',
          '',
          '- Page: http://localhost:5173/login',
          '- Selector: `#login > button.primary`',
          '- Text: `Sign in`',
          '- Box: 100×32 at 10,21 in 1280×800',
          '- Screenshot: image 2',
          '',
          'Make it blue',
        ].join('\n'),
        [
          '### 2. `` div`x` ``',
          '',
          '- Page: http://localhost:5173/login',
          '- Selector: `div`',
          '- Box: 100×32 at 10,21 in 1280×800',
          '',
          'Hide this',
        ].join('\n'),
        [
          '### 3. `button.primary`',
          '',
          '- Page: http://localhost:5173/login',
          '- Selector: `#login > button.primary`',
          '- Text: `Sign in`',
          '- Box: 100×32 at 10,21 in 1280×800',
          '- Screenshot: image 3',
          '',
          'Bigger',
        ].join('\n'),
      ].join('\n\n'),
    )
  })
})
