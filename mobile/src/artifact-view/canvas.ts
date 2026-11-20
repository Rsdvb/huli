// What a version shows as: a document, a deck, one page, or a canvas of pages in reading order.
// A canvas document's pages are its HTML files at their own sizes; an old canvas, one `index.html`
// whose marked children are its pages, shows each of them alone, as the desktop's protocol does
// with `?page=group.index`, laid out as the split into a canvas document would lay them out.

import { ARTIFACT_ENTRY } from '@shared/artifact-files'
import type { CanvasPage as LegacyPage } from '@shared/artifact-page'
import { CANVAS_FILE, parseCanvasDoc } from '@shared/canvas-doc'
import { splitLegacyCanvas } from '@shared/canvas-legacy'
import { textOf } from './bytes'
import type { LoadedVersion } from './content'

export interface ViewPage {
  /** The canvas document's page id, which `artifacts.view` names; null for an old canvas. */
  id: string | null
  /** In reading order, from 1, as comments number pages. */
  number: number
  name: string | null
  file: string
  legacy: LegacyPage | null
  width: number
  height: number
}

export type VersionView =
  | { kind: 'document' }
  | { kind: 'slides' }
  | { kind: 'page' }
  | { kind: 'canvas'; pages: ViewPage[] }
  | { kind: 'broken'; reason: string }

export function viewOf(version: LoadedVersion): VersionView {
  if (version.type?.name === 'document') return { kind: 'document' }
  if (version.type?.name === 'slides') return { kind: 'slides' }
  const doc = version.files.get(CANVAS_FILE)
  if (doc) {
    try {
      const parsed = parseCanvasDoc(textOf(doc.bytes))
      const pages = parsed.pages.map((p, i) => ({
        id: p.id,
        number: i + 1,
        name: p.name.trim() || null,
        file: p.file,
        legacy: null,
        width: p.width,
        height: p.height,
      }))
      return pages.length > 0
        ? { kind: 'canvas', pages }
        : { kind: 'broken', reason: '这块画布还没有页面。' }
    } catch {
      return { kind: 'broken', reason: '没能读出这块画布。' }
    }
  }
  const entry = version.files.get(ARTIFACT_ENTRY)
  if (!entry) return { kind: 'broken', reason: '这个产物没有可以显示的页面。' }
  const split = splitLegacyCanvas(textOf(entry.bytes), new Set(version.files.keys()))
  if (!split) return { kind: 'page' }
  const counts = new Map<string, number>()
  const pages = split.doc.pages.map((p, i) => {
    const index = (counts.get(p.canvas) ?? 0) + 1
    counts.set(p.canvas, index)
    const group = p.canvas.startsWith('group-') ? Number(p.canvas.slice('group-'.length)) : 0
    return {
      id: null,
      number: i + 1,
      // The split names a page with no name of its own by its number.
      name: p.name === `Frame ${i + 1}` ? null : p.name,
      file: ARTIFACT_ENTRY,
      legacy: { group, index },
      width: p.width,
      height: p.height,
    }
  })
  return { kind: 'canvas', pages }
}

export function pageName(page: ViewPage): string {
  return page.name ?? `第 ${page.number} 页`
}
