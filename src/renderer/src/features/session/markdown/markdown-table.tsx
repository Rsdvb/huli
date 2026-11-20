import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import { Download01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import {
  extractTableDataFromElement,
  tableDataToCSV,
  tableDataToMarkdown,
  type ExtraProps,
} from 'streamdown'
import { BlockAction, BlockCopy } from './block-frame'
import { downloadText } from './download'
import { numericColumns, proseColumns, tableSize } from './table-columns'

type Overflow = { left: boolean; right: boolean }

const NO_OVERFLOW: Overflow = { left: false, right: false }

/** What each watched box, or the table in it, measures when it is resized. */
const measures = new WeakMap<Element, () => void>()
/** Each watched box's table. */
const tables = new WeakMap<Element, Element | null>()
let sizes: ResizeObserver | null = null
let nearView: IntersectionObserver | null = null

// The observers' callbacks are the module's own, so they close over no box: a callback made where
// a box was in scope kept the first table's whole reply alive for as long as the window was open.
function resized(entries: ResizeObserverEntry[]): void {
  for (const entry of entries) measures.get(entry.target)?.()
}

function nearViewChanged(entries: IntersectionObserverEntry[]): void {
  for (const { target, isIntersecting } of entries) {
    // A report queued before the table went: watching it now would keep its whole tree.
    if (!tables.has(target)) continue
    for (const el of [target, tables.get(target)]) {
      if (!el) continue
      if (isIntersecting) sizes?.observe(el)
      else sizes?.unobserve(el)
    }
  }
}

/**
 * Measures `box` while it is near the view, after layout. A reply's tables were each measured as
 * they mounted, which forced a layout of the whole thread per table: 0.4 s for a reply of 195
 * tables. One pair of observers serves every table: a box near the view is watched for size
 * changes, which also reports its size once, after the frame's own layout, when watching starts.
 */
function watchOverflow(box: HTMLElement, measure: () => void): () => void {
  sizes ??= new ResizeObserver(resized)
  nearView ??= new IntersectionObserver(nearViewChanged, { rootMargin: '50% 0px' })
  const table = box.firstElementChild
  measures.set(box, measure)
  tables.set(box, table)
  if (table) measures.set(table, measure)
  nearView.observe(box)
  return () => {
    nearView?.unobserve(box)
    sizes?.unobserve(box)
    if (table) sizes?.unobserve(table)
    measures.delete(box)
    tables.delete(box)
    if (table) measures.delete(table)
  }
}

/** Which sides of a scrolled box hide content, so they fade. */
function useOverflow(ref: React.RefObject<HTMLElement | null>): Overflow {
  const [overflow, setOverflow] = useState<Overflow>(NO_OVERFLOW)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const max = el.scrollWidth - el.clientWidth
      const next = { left: el.scrollLeft > 1, right: el.scrollLeft < max - 1 }
      setOverflow((o) => (o.left === next.left && o.right === next.right ? o : next))
    }
    const unwatch = watchOverflow(el, measure)
    el.addEventListener('scroll', measure, { passive: true })
    return () => {
      unwatch()
      el.removeEventListener('scroll', measure)
    }
  }, [ref])
  return overflow
}

/**
 * A table in a thin frame: numeric columns line up on the right, a hovered row tints, a table
 * wider than the reply scrolls sideways with its hidden edge fading, and the footer counts rows
 * and columns and copies it as Markdown or saves it as CSV.
 */
export function MarkdownTable({ node, children, className }: ComponentProps<'table'> & ExtraProps) {
  const { t } = useTranslation('session')
  const table = useRef<HTMLTableElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const overflow = useOverflow(scroller)
  const numeric = useMemo(() => numericColumns(node), [node])
  const prose = useMemo(() => proseColumns(node), [node])
  const size = useMemo(() => tableSize(node), [node])

  // Streamdown draws the cells, so the column marks go on them once they are in the page.
  useLayoutEffect(() => {
    const el = table.current
    if (!el) return
    for (const row of el.rows) {
      for (const [i, cell] of [...row.cells].entries()) {
        cell.toggleAttribute('data-numeric', numeric.includes(i))
        cell.toggleAttribute('data-prose', prose.includes(i))
      }
    }
  })

  const data = () => (table.current ? extractTableDataFromElement(table.current) : null)
  return (
    <div data-table-frame="">
      <div
        ref={scroller}
        data-table-scroll=""
        data-fade-left={overflow.left || undefined}
        data-fade-right={overflow.right || undefined}
      >
        <table ref={table} data-streamdown="table" className={className}>
          {children}
        </table>
      </div>
      <div data-table-footer="">
        <span className="flex-1 tabular">
          {t('block.tableSize', {
            rows: t('block.rows', { count: size.rows }),
            columns: t('block.columns', { count: size.columns }),
          })}
        </span>
        <BlockCopy
          label={t('block.copyMarkdown')}
          text={() => {
            const d = data()
            return d ? tableDataToMarkdown(d) : ''
          }}
        />
        <BlockAction
          label={t('block.downloadCsv')}
          onClick={() => {
            const d = data()
            if (d) downloadText(tableDataToCSV(d), 'table.csv', 'text/csv')
          }}
        >
          <HugeiconsIcon icon={Download01Icon} strokeWidth={1.9} aria-hidden />
        </BlockAction>
      </div>
    </div>
  )
}
