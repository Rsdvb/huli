// Huli: comments on elements of a page in the session's browser, picked in the pane's pick mode,
// kept in the session's draft beside its comments on diff lines and sent with them as one message
// (@shared/page-notes). Each element's screenshot is added on the session's host as a pasted image
// is, and goes with the message as an image.

import {
  MAX_PAGE_NOTES,
  newPageNote,
  pageNotesMessage,
  type ElementPick,
  type PageNote,
} from '@shared/page-notes'
import type { Attachment } from '@shared/thread'
import { readDraftPageNotes, writeDraftPageNotes } from '@renderer/features/session/composer/drafts'
import { prepareImage } from '@renderer/features/session/composer/image-work'
import { base64Bytes } from '@renderer/features/session/media/carried'
import { host, hostAt, learnAttachmentHost } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'

let made = 0

/** The screenshot's name, one word as a pasted still's is: `element-<site>.png`. */
function shotName(url: string): string {
  const site = URL.parse(url)?.host.replaceAll(':', '-')
  return site ? `element-${site}.png` : 'element.png'
}

/** The element's visible part, cut from the still of the page; null when none was in view. */
async function cropShot(pick: ElementPick): Promise<Blob | null> {
  const { crop } = pick
  if (!crop) return null
  const bytes = base64Bytes(pick.still.slice(pick.still.indexOf(',') + 1))
  const bitmap = await createImageBitmap(
    new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
    crop.x,
    crop.y,
    crop.width,
    crop.height,
  )
  const canvas = new OffscreenCanvas(crop.width, crop.height)
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
  bitmap.close()
  return canvas.convertToBlob({ type: 'image/png' })
}

/** Adds the element's screenshot on the session's host, `hostId` null being this computer. */
async function addShot(pick: ElementPick, hostId: string | null): Promise<Attachment | null> {
  const shot = await cropShot(pick)
  if (!shot) return null
  const image = await prepareImage(shot)
  const params = {
    source: { bytes: image.bytes, mimeType: image.mimeType, name: shotName(pick.url) },
    thumb: image.thumb,
  }
  return hostId === null
    ? host('attachments.add', params)
    : hostAt(hostId, 'attachments.add', params)
}

/** Whether the session can take another page note. */
export const pageNotesFull = (sessionId: string): boolean =>
  readDraftPageNotes(sessionId).length >= MAX_PAGE_NOTES

/**
 * A comment on the picked element, its screenshot added first. Without the screenshot, as when
 * it could not be added, the note still names the element.
 */
export async function addPageNote(
  sessionId: string,
  pick: ElementPick,
  comment: string,
  hostId: string | null,
): Promise<void> {
  const shot = await addShot(pick, hostId).catch((error: unknown) => {
    console.warn('Could not add the screenshot of the element', error)
    return null
  })
  const at = Date.now()
  const note = newPageNote(
    {
      id: `p${at.toString(36)}-${(++made).toString(36)}`,
      comment,
      at,
      shot,
      ...(shot && hostId ? { shotHost: hostId } : {}),
    },
    pick,
  )
  writeDraftPageNotes(sessionId, [...readDraftPageNotes(sessionId), note].slice(-MAX_PAGE_NOTES))
}

export function editPageNote(sessionId: string, id: string, comment: string): void {
  writeDraftPageNotes(
    sessionId,
    readDraftPageNotes(sessionId).map((note) => (note.id === id ? { ...note, comment } : note)),
  )
}

/** Removes a note, and its screenshot's record on the host. */
export function removePageNote(sessionId: string, id: string): void {
  const notes = readDraftPageNotes(sessionId)
  const note = notes.find((entry) => entry.id === id)
  writeDraftPageNotes(
    sessionId,
    notes.filter((entry) => entry.id !== id),
  )
  if (note?.shot) dropShot(note)
}

function dropShot(note: PageNote): void {
  const shot = note.shot
  if (!shot) return
  if (note.shotHost) learnAttachmentHost(shot.id, note.shotHost)
  void host('attachments.remove', { id: shot.id }).catch(() => {})
}

/** The page notes' screenshots, for the message's images, their hosts learned again. */
export function pageNoteShots(notes: readonly PageNote[]): Attachment[] {
  return notes.flatMap((note) => {
    if (!note.shot) return []
    if (note.shotHost) learnAttachmentHost(note.shot.id, note.shotHost)
    return [note.shot]
  })
}

/** The part of the message for the page notes, in the interface's language. */
export function pageNotesText(notes: readonly PageNote[], firstImage = 1): string {
  const t = i18n.getFixedT(null, 'browser')
  return pageNotesMessage(
    notes,
    {
      intro: (count) => t('pick.message.intro', { count }),
      page: t('pick.message.page'),
      selector: t('pick.message.selector'),
      text: t('pick.message.text'),
      box: (box, viewport) =>
        t('pick.message.box', {
          width: box.width,
          height: box.height,
          x: box.x,
          y: box.y,
          viewWidth: viewport.width,
          viewHeight: viewport.height,
        }),
      shot: (index) => t('pick.message.shot', { index }),
    },
    firstImage,
  )
}
