import 'katex/dist/katex.min.css'
import { useContext, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BlockCopy } from './block-frame'
import { LiveContext } from './live'
import { drawTex, formulaView, type FormulaView, type TexError } from './tex'

/** The source of a formula KaTeX could not read, with the part it stopped at in red. */
function Fallback({ tex, error }: { tex: string; error: TexError }) {
  return (
    <code data-math-error="" title={error.message}>
      {tex.slice(0, error.start)}
      <mark>{tex.slice(error.start, error.end)}</mark>
      {tex.slice(error.end)}
    </code>
  )
}

/**
 * KaTeX's drawing of `tex` in an element React leaves to it, or its source (formulaView). It
 * draws when the formula changes, not when the message finishes: a drawing that failed then only
 * shows its source marked, and its last drawing goes as it would have.
 */
function Formula({ tex, display }: { tex: string; display: boolean }) {
  const live = useContext(LiveContext)
  const ref = useRef<HTMLSpanElement>(null)
  const [failed, setFailed] = useState<{ tex: string; error: TexError; drawn: boolean } | null>(
    null,
  )
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    // A half-typed formula keeps its last drawing while the message is written (below).
    const error = drawTex(tex, display, element, true)
    setFailed(error ? { tex, error, drawn: element.childNodes.length > 0 } : null)
  }, [tex, display])
  useLayoutEffect(() => {
    if (!live && failed && ref.current) ref.current.textContent = ''
  }, [live, failed])
  const view: FormulaView = failed ? formulaView(true, live, failed.drawn) : 'drawing'
  return (
    <>
      <span ref={ref} hidden={view !== 'drawing'} data-math-inline={display ? undefined : ''} />
      {failed && view === 'marked' && <Fallback tex={failed.tex} error={failed.error} />}
      {failed && view === 'source' && <code>{failed.tex}</code>}
    </>
  )
}

/** A formula in a line of text, at the text's own line height. */
export function InlineMath({ tex }: { tex: string }) {
  return <Formula tex={tex} display={false} />
}

/**
 * A formula on a line of its own: centered on a subtle ground, numbered on the right in the
 * message's order (globals.css counts them), with Copy LaTeX on hover.
 */
export function MathBlock({ tex, isIncomplete }: { tex: string; isIncomplete: boolean }) {
  const { t } = useTranslation('session')
  const source = tex.replace(/\n$/, '')
  return (
    <div data-math-block="" className="group/math">
      {isIncomplete ? <code>{source}</code> : <Formula tex={source} display />}
      <span className="math-copy">
        <BlockCopy text={source} label={t('block.copyLatex')} />
      </span>
    </div>
  )
}
