// Huli's rebranding, run before a build: it swaps the product the user sees from Kettu to Kite
// (ZH_NAME in Chinese copy) without editing the upstream sources by hand, so merging Kettu's updates stays
// clean. Idempotent. Only display text and artwork change: JSON keys, identifiers, URL schemes
// such as kettu-media: and the KettuAI/Kettu repository name are left as they are, and so is the
// attribution to Kettu. The fork itself is still Huli inside (its ids, data folders, update
// channel and repository); see tools/huli/README.md.

import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ARTWORK, CODE, NAME, ZH_NAME, brandCode, brandLocale } from './brand-text.mjs'
import { fillUpdatePath } from './update-path.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Kite's artwork (ARTWORK) is copied over Kettu's. Folders in REPLACED are emptied first, as Kite's
 * hold other files.
 */
const REPLACED = ['build/icon.icon']

async function locales() {
  const base = path.join(ROOT, 'src', 'shared', 'locales')
  let changed = 0
  for (const lang of await readdir(base, { withFileTypes: true })) {
    if (!lang.isDirectory()) continue
    for (const file of await readdir(path.join(base, lang.name))) {
      if (!file.endsWith('.json')) continue
      const full = path.join(base, lang.name, file)
      const text = await readFile(full, 'utf8')
      const parsed = JSON.parse(text)
      const swapped = brandLocale(parsed, file, lang.name)
      // A file without anything to swap is left byte for byte as it is.
      if (JSON.stringify(swapped) === JSON.stringify(parsed)) continue
      await writeFile(full, JSON.stringify(swapped, null, 2) + '\n', 'utf8')
      changed++
    }
  }
  return changed
}

async function code() {
  let changed = 0
  for (const [rel, swaps] of Object.entries(CODE)) {
    const full = path.join(ROOT, rel)
    let text
    try {
      text = await readFile(full, 'utf8')
    } catch {
      console.warn(`rebrand: ${rel} is gone upstream; skipped`)
      continue
    }
    const { text: next, missing } = brandCode(text, swaps)
    // A spelling upstream changed is a gap to close in CODE.
    for (const swap of missing) console.warn(`rebrand: ${rel} no longer holds ${swap}`)
    if (next !== text) {
      await writeFile(full, next, 'utf8')
      changed++
    }
  }
  return changed
}

/** Every file under `dir`, relative to it, with forward slashes. */
async function files(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).replaceAll('\\', '/'))
}

async function artwork() {
  const mirror = path.join(ROOT, ARTWORK)
  const ours = await files(mirror)
  // A tray image or brand file upstream adds would still show Kettu: a gap to draw for Kite.
  for (const folder of ['resources/tray', 'src/renderer/src/assets']) {
    const theirs = await files(path.join(ROOT, folder)).catch(() => [])
    for (const file of theirs) {
      const rel = `${folder}/${file}`
      if (/\b(tray|kettu)[^/]*$/.test(rel) && !ours.includes(rel)) {
        console.warn(`rebrand: ${rel} has no Kite version in tools/huli/brand`)
      }
    }
  }
  for (const folder of REPLACED) {
    await rm(path.join(ROOT, folder), { recursive: true, force: true })
  }
  await cp(mirror, ROOT, { recursive: true, force: true })
  return ours.length
}

const l = await locales()
const c = await code()
const a = await artwork()
console.log(
  `rebrand: ${l} locale files and ${c} code files now say ${NAME} (${ZH_NAME}); ${a} artwork files copied`,
)
// The update channel's path (tools/huli/update-path.mjs). A build served to anyone, such as the
// hosted web client's, passes --no-update-path so the path stays out of it.
if (!process.argv.includes('--no-update-path')) {
  try {
    console.log(`rebrand: update path filled in ${await fillUpdatePath()} files`)
  } catch (error) {
    console.error(`rebrand: ${error.message}`)
    process.exitCode = 1
  }
}
