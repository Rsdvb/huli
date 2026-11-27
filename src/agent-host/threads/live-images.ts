// Huli: a live thread holds the images its agent sent as base64 until a checkpoint moves them into
// the thread store, where a page names each by the hash of its bytes. A device that reads stored
// images by hash gets a live thread's large images by hash as well, as it would once the session
// is stored, rather than every screenshot's bytes in each page and patch; `sessions.blob` finds
// the bytes in the live thread until the store has them.

import { createHash } from 'node:crypto'
import type { EntryChanges, Patch, PatchBatch, ThreadEntry } from '@shared/thread'
import { INLINE_MEDIA_LIMIT, mapRefs } from './model'

type Json = Record<string, unknown>

/** An image's bytes as the thread holds them. */
export interface HeldImage {
  mimeType: string
  data: string
}

// Each image is hashed once while its ref lives: pages and patches name the same ref again.
const hashes = new WeakMap<object, string>()

/** Whether the store keeps this ref's bytes apart, which is what a page then names by hash. */
function keptApart(ref: Json): ref is Json & { data: string } {
  return (
    ref.kind === 'image' && typeof ref.data === 'string' && ref.data.length > INLINE_MEDIA_LIMIT
  )
}

/** The hash the store keeps the image's bytes under: SHA-256 of the bytes, in hex. */
function hashOf(ref: Json & { data: string }): string {
  let hash = hashes.get(ref)
  if (!hash) {
    hash = createHash('sha256').update(Buffer.from(ref.data, 'base64')).digest('hex')
    hashes.set(ref, hash)
  }
  return hash
}

function byHash(ref: Json): Json {
  if (!keptApart(ref)) return ref
  return { kind: 'image', mimeType: ref.mimeType, blob: hashOf(ref) }
}

/** The entry with each large image named by hash; the same entry when it holds none. */
export function hashedImages<T extends ThreadEntry>(entry: T): T {
  return mapRefs(entry as unknown as Json, byHash) as unknown as T
}

/** An update's changes with the images of their content and attachments named by hash. */
function hashedChanges(changes: EntryChanges): EntryChanges {
  const fields = changes as Json
  let out: Json | null = null
  if (Array.isArray(fields.content)) {
    const mapped = mapRefs({ kind: 'tool', content: fields.content }, byHash).content
    if (mapped !== fields.content) (out ??= { ...fields }).content = mapped
  }
  if (Array.isArray(fields.attachments)) {
    const mapped = mapRefs({ kind: 'agent', attachments: fields.attachments }, byHash).attachments
    if (mapped !== fields.attachments) (out ??= { ...fields }).attachments = mapped
  }
  return (out ?? changes) as EntryChanges
}

function hashedPatch(patch: Patch): Patch {
  if (patch.op === 'entry.add') {
    const entry = hashedImages(patch.entry)
    return entry === patch.entry ? patch : { ...patch, entry }
  }
  if (patch.op === 'entry.update') {
    const changes = hashedChanges(patch.changes)
    return changes === patch.changes ? patch : { ...patch, changes }
  }
  return patch
}

/** A batch of patches with their large images named by hash; the same batch when none has one. */
export function hashedBatch(batch: PatchBatch): PatchBatch {
  let patches: Patch[] | null = null
  batch.patches.forEach((patch, index) => {
    const next = hashedPatch(patch)
    if (next !== patch) (patches ??= [...batch.patches])[index] = next
  })
  return patches ? { ...batch, patches } : batch
}

/** The bytes of the image the entries hold under `hash`, or null when they hold none. */
export function heldImage(entries: Iterable<ThreadEntry>, hash: string): HeldImage | null {
  let found: HeldImage | null = null
  for (const entry of entries) {
    mapRefs(entry as unknown as Json, (ref) => {
      if (!found && keptApart(ref) && hashOf(ref) === hash) {
        found = { mimeType: String(ref.mimeType), data: ref.data }
      }
      return ref
    })
    if (found) return found
  }
  return null
}
