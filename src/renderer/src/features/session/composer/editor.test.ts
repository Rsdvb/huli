import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it, vi } from 'vitest'
import { focusOnContextMenu } from './editor-context-menu'

describe('focusOnContextMenu', () => {
  it('focuses an unfocused editable composer before the native context menu opens', () => {
    const focus = vi.fn()
    const state = EditorState.create({ extensions: [EditorView.editable.of(true)] })
    focusOnContextMenu({ hasFocus: false, focus, state })
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('does not refocus an already focused composer, preserving its selection', () => {
    const focus = vi.fn()
    const state = EditorState.create({ extensions: [EditorView.editable.of(true)] })
    focusOnContextMenu({ hasFocus: true, focus, state })
    expect(focus).not.toHaveBeenCalled()
  })

  it('does not focus a disabled composer or missing editor instance', () => {
    const focus = vi.fn()
    const disabledState = EditorState.create({ extensions: [EditorView.editable.of(false)] })
    focusOnContextMenu({ hasFocus: false, focus, state: disabledState })
    focusOnContextMenu(null)
    expect(focus).not.toHaveBeenCalled()
  })
})

describe('ComposerEditor right-click hit-testing wiring', () => {
  const source = readFileSync(join(import.meta.dirname, 'editor.tsx'), 'utf8')

  it('keeps .cm-placeholder non-blocking for pointer hit-testing', () => {
    expect(source).toMatch(/['"]\.cm-placeholder['"]:\s*\{[\s\S]*?pointerEvents:\s*['"]none['"]/)
  })

  it('focuses on contextmenu capture without preventing the native context menu', () => {
    expect(source).toContain('onContextMenuCapture={() => focusOnContextMenu(view.current)}')
    expect(source).not.toMatch(/onContextMenu\w*=\{[^}]*preventDefault/)
  })
})

describe('ComposerEditor multiline Tab suggestion layout (#2874)', () => {
  const source = readFileSync(join(import.meta.dirname, 'editor.tsx'), 'utf8')

  it('keeps plain placeholders single-line truncated so ordinary placeholders stay compact', () => {
    expect(source).toMatch(
      /['"]\.cm-placeholder['"]:\s*\{[\s\S]*?overflow:\s*['"]hidden['"][\s\S]*?textOverflow:\s*['"]ellipsis['"][\s\S]*?whiteSpace:\s*['"]nowrap['"]/,
    )
  })

  // Huli: the suggestion is Kite's ghost prompt, kept on one line with its key in view, rather than
  // Kettu's suggestion wrapping to four lines, so those two cases check the ghost instead.
  it('keeps the ghost prompt on one line, cut with an ellipsis, with its key in view', () => {
    expect(source).toMatch(
      /['"]\.cm-placeholder:has\(\.cm-ghost\)['"]:\s*\{\s*overflow:\s*['"]visible['"]\s*\}/,
    )
    expect(source).toMatch(
      /['"]\.cm-ghost-text['"]:\s*\{[\s\S]*?overflow:\s*['"]hidden['"][\s\S]*?textOverflow:\s*['"]ellipsis['"]/,
    )
    expect(source).toMatch(/['"]\.cm-ghost-key['"]:\s*\{\s*flex:\s*['"]none['"]\s*\}/)
    expect(source).toContain('ghostLine(ghost.text)')
  })

  it('reconfigures empty-box placeholder in useLayoutEffect and clears suggestions on send (#2903)', () => {
    expect(source).toMatch(
      /useLayoutEffect\(\(\) => \{[\s\S]*?view\.current\?\.dispatch\(\{\s*effects:\s*parts\.placeholder\.reconfigure\(placeholderOf\(placeholder,\s*shown\)\),\s*\}\)\s*\},\s*\[parts,\s*placeholder,\s*ghostText,\s*ghostKey,\s*ghostLabel\]\)/,
    )
    const composerSource = readFileSync(join(import.meta.dirname, 'composer.tsx'), 'utf8')
    expect(composerSource).toContain('suppressSuggestion(sessionId)')
    expect(composerSource).toContain('unshow?.({ restoreSuggestion: true })')
  })
})

describe('ComposerEditor and PromptBox input-history guards (#2921)', () => {
  const editorSource = readFileSync(join(import.meta.dirname, 'editor.tsx'), 'utf8')
  const promptBoxSource = readFileSync(join(import.meta.dirname, 'prompt-box.tsx'), 'utf8')

  it('requires a single collapsed caret in atBoundary and short-circuits exact document edges', () => {
    expect(editorSource).toContain(
      'if (selection.ranges.length !== 1 || !selection.main.empty) return false',
    )
    expect(editorSource).toContain('if (selection.main.head === target) return true')
  })

  it('guards PromptBox history navigation against IME composition, popovers, and modifier keys', () => {
    expect(promptBoxSource).toContain("if (handling === 'block') return false")
    expect(promptBoxSource).toMatch(
      /if\s*\(\s*!open\s*&&\s*!modified\s*&&\s*\(event\.key === 'ArrowUp' \|\| event\.key === 'ArrowDown'\)\s*&&\s*box\.moveHistory\(event\.key === 'ArrowDown'\)\s*\)/,
    )
  })
})
