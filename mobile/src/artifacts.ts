// Artifacts as the phone shows them: their kinds (the desktop's, from
// src/renderer/src/features/artifacts/model.ts), and their previews, which the computer's desktop
// app captures (`artifacts.thumbnail`) and the phone asks for a few at a time as cards appear. A
// preview is kept on disk by artifact and version, so the next start draws it without asking.

import { useEffect, useSyncExternalStore } from 'react'
import { Directory, File, Paths } from 'expo-file-system'
import { router } from 'expo-router'
import type { ArtifactSummary, ThumbnailPage } from '@shared/artifacts'
import { THUMBNAIL_PAGES } from '@shared/artifacts'
import { CANVAS_FILE, parseCanvasDoc } from '@shared/canvas-doc'
import type { HostLink } from '@shared/remote/link'
import { admin } from './admin'
import type { IconName } from './ui/Icon'

export type ArtifactKind = 'document' | 'slides' | 'web' | 'canvas'

export const KINDS: readonly ArtifactKind[] = ['document', 'slides', 'web', 'canvas']

export const KIND_TEXT: Record<ArtifactKind, string> = {
  document: '文档',
  slides: '幻灯片',
  web: '页面',
  canvas: '画布',
}

export const KIND_ICON: Record<ArtifactKind, IconName> = {
  document: 'doc',
  slides: 'slides',
  web: 'globe',
  canvas: 'canvas',
}

/** Opens the artifact full screen, at its latest version or `version`. */
export function openArtifact(id: string, version?: number | null): void {
  router.push({
    pathname: '/artifact/[id]',
    params: version ? { id, version: String(version) } : { id },
  })
}

export function artifactKind(a: Pick<ArtifactSummary, 'type' | 'pages' | 'canvas'>): ArtifactKind {
  if (a.type) return a.type
  return a.canvas || a.pages >= 2 ? 'canvas' : 'web'
}

export const KEEP_DELETED_DAYS = 30

/** Whole days before Recently deleted removes it for good. */
export function daysLeft(deletedAt: number, now = Date.now()): number {
  const day = 86_400_000
  return Math.max(1, Math.ceil((KEEP_DELETED_DAYS * day - Math.max(0, now - deletedAt)) / day))
}

export type Thumbnail = { state: 'loading' } | { state: 'ready'; uri: string } | { state: 'none' }

const LOADING: Thumbnail = { state: 'loading' }
const NONE: Thumbnail = { state: 'none' }
const KEPT = 120
const AT_ONCE = 3

const made = new Map<string, Thumbnail>()
const waiting: { key: string; artifact: ArtifactSummary; link: HostLink }[] = []
const listeners = new Set<() => void>()
let asking = 0
/** The computer cannot capture previews (the daemon); asked no more until the link changes. */
let refusedBy: HostLink | null = null

function keyOf(a: Pick<ArtifactSummary, 'id' | 'version'>): string {
  return `${a.id}:${a.version}`
}

/** The previews kept between starts, in the cache the system may clear when it needs room. */
const shelf = new Directory(Paths.cache, 'artifact-previews')

function shelved(a: Pick<ArtifactSummary, 'id' | 'version'>): File {
  return new File(shelf, `${a.id}@${a.version}.png`)
}

/** A preview kept from before, or null. */
function fromShelf(a: Pick<ArtifactSummary, 'id' | 'version'>): Thumbnail | null {
  try {
    const file = shelved(a)
    return file.exists ? { state: 'ready', uri: file.uri } : null
  } catch {
    return null
  }
}

/**
 * Keeps a preview the computer sent as a data URL, in place of the artifact's older versions, and
 * gives the kept file's URI; the data URL itself when it cannot be kept.
 */
async function shelve(a: ArtifactSummary, uri: string): Promise<string> {
  const data = /^data:image\/[a-z+]+;base64,(.+)$/.exec(uri)
  if (!data) return uri
  try {
    if (!shelf.exists) shelf.create({ intermediates: true, idempotent: true })
    for (const entry of shelf.list()) {
      if (entry instanceof File && entry.name.startsWith(`${a.id}@`)) entry.delete()
    }
    const file = shelved(a)
    file.create({ overwrite: true })
    await file.write(data[1]!, { encoding: 'base64' })
    return file.uri
  } catch {
    return uri
  }
}

function settle(key: string, thumbnail: Thumbnail): void {
  made.delete(key)
  made.set(key, thumbnail)
  if (made.size > KEPT) made.delete(made.keys().next().value!)
  for (const listener of listeners) listener()
}

/** A canvas document's first canvas, its pages moved to start at the origin, as the desktop does. */
function canvasLayout(json: string): ThumbnailPage[] | null {
  const doc = parseCanvasDoc(json)
  const first = doc.canvases[0]
  if (!first) return null
  const pages = doc.pages.filter((p) => p.canvas === first.id)
  if (pages.length === 0) return null
  const left = Math.min(...pages.map((p) => p.x))
  const top = Math.min(...pages.map((p) => p.y))
  return pages.slice(0, THUMBNAIL_PAGES).map((p, i) => ({
    group: 0,
    index: i + 1,
    file: p.file,
    x: Math.round(p.x - left),
    y: Math.round(p.y - top),
    width: p.width,
    height: p.height,
  }))
}

async function render(link: HostLink, a: ArtifactSummary): Promise<Thumbnail> {
  if (refusedBy === link) return NONE
  let layout: ThumbnailPage[] | null = null
  if (a.canvas || a.pages >= 2) {
    // Only a canvas document can be laid out here; an older page-group canvas needs a browser.
    if (!a.canvas) return NONE
    const { bytes } = (await link.request('artifacts.file', {
      id: a.id,
      version: a.version,
      path: CANVAS_FILE,
    })) as { bytes: ArrayBuffer }
    layout = canvasLayout(new TextDecoder().decode(bytes))
    if (!layout) return NONE
  }
  try {
    const uri = await admin(link, 'artifacts.thumbnail', { id: a.id, version: a.version, layout })
    return uri ? { state: 'ready', uri } : NONE
  } catch (failure) {
    if ((failure as { code?: unknown }).code === 'unavailable') refusedBy = link
    throw failure
  }
}

function pump(): void {
  while (asking < AT_ONCE) {
    const next = waiting.shift()
    if (!next) return
    asking++
    render(next.link, next.artifact)
      .then(async (thumbnail) =>
        thumbnail.state === 'ready'
          ? { state: 'ready' as const, uri: await shelve(next.artifact, thumbnail.uri) }
          : thumbnail,
      )
      .catch(() => NONE)
      .then((thumbnail) => settle(next.key, thumbnail))
      .finally(() => {
        asking--
        pump()
      })
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The artifact's preview, asked for while the card is mounted. */
export function useThumbnail(link: HostLink | null, a: ArtifactSummary): Thumbnail {
  const key = keyOf(a)
  const thumbnail = useSyncExternalStore(subscribe, () => made.get(key) ?? LOADING)
  useEffect(() => {
    if (made.has(key) || waiting.some((w) => w.key === key)) return
    // A kept preview shows at once, and away from the computer too.
    const kept = fromShelf(a)
    if (kept) return settle(key, kept)
    if (!link) return
    waiting.push({ key, artifact: a, link })
    pump()
    return () => {
      const at = waiting.findIndex((w) => w.key === key)
      if (at >= 0) waiting.splice(at, 1)
    }
    // The key names the version; the rest of the summary does not change what renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, link])
  return link || thumbnail.state === 'ready' ? thumbnail : NONE
}
