// Huli's rebranding, run before a build: it swaps the product name the user sees from Kettu to
// Huli without editing the upstream sources by hand, so merging Kettu's updates stays clean.
// Idempotent. Only display text changes: JSON keys, identifiers, URL schemes such as kettu-media:
// and the KettuAI repository name are left as they are.

import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const NAME = 'Huli'
const WORD = /\bKettu\b(?!AI)/g

/** Code files whose literal display name is swapped, with the exact spellings to swap. */
const CODE = {
  'src/renderer/index.html': ['<title>Kettu</title>'],
  'src/renderer/tray.html': ['<title>Kettu</title>'],
  'src/renderer/overlay.html': ['<title>Kettu</title>'],
  'src/renderer/computer-overlay.html': ['<title>Kettu</title>'],
  'src/renderer/src/app/window-title.ts': ["'Kettu'"],
  'src/renderer/src/components/brand.tsx': ['aria-label="Kettu"'],
  'src/renderer/src/features/settings/about-section.tsx': ['<b>Kettu</b>'],
  'src/renderer/src/features/marketplace/builtin.tsx': ['<h1>Kettu</h1>'],
  'src/renderer/src/features/session/entries/computer-setup-entry.tsx': ['label="Kettu"'],
}

/**
 * Copy about Kettu's own service, in the order applied: the account is Huli Cloud, signed in to
 * with a password and a one-time code, and run by its owner. URLs, as placeholders, stay.
 */
const COPY = [
  ['用邮箱、GitHub、Google 或 Apple 登录，账号免费。', '用你自己的 Huli Cloud 账号登录。'],
  ["Use email, GitHub, Google or Apple. It's free.", 'Sign in with your own Huli Cloud account.'],
  ['如需帮助，请联系 hello@kettu.sh。', '在服务器上用 huli-cloud 命令处理。'],
  ['Contact hello@kettu.sh for help.', 'Fix it on the server with the huli-cloud command.'],
  ['www.kettu.sh', 'Huli Cloud'],
  ['kettu.sh', 'Huli Cloud'],
]

function swapCopy(text) {
  if (/^https?:\/\//.test(text)) return text
  return COPY.reduce((out, [from, to]) => out.split(from).join(to), text)
}

function swapValues(value) {
  if (typeof value === 'string') return swapCopy(value.replace(WORD, NAME))
  if (Array.isArray(value)) return value.map(swapValues)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swapValues(v)]))
  }
  return value
}

async function locales() {
  const base = path.join(ROOT, 'src', 'shared', 'locales')
  let changed = 0
  for (const lang of await readdir(base, { withFileTypes: true })) {
    if (!lang.isDirectory()) continue
    for (const file of await readdir(path.join(base, lang.name))) {
      if (!file.endsWith('.json')) continue
      const full = path.join(base, lang.name, file)
      const text = await readFile(full, 'utf8')
      WORD.lastIndex = 0
      if (!WORD.test(text) && !text.includes('kettu.sh')) continue
      WORD.lastIndex = 0
      const next = JSON.stringify(swapValues(JSON.parse(text)), null, 2) + '\n'
      if (next !== text) {
        await writeFile(full, next, 'utf8')
        changed++
      }
    }
  }
  return changed
}

async function code() {
  let changed = 0
  for (const [rel, spellings] of Object.entries(CODE)) {
    const full = path.join(ROOT, rel)
    let text
    try {
      text = await readFile(full, 'utf8')
    } catch {
      console.warn(`rebrand: ${rel} is gone upstream; skipped`)
      continue
    }
    let next = text
    for (const s of spellings) next = next.split(s).join(s.replace('Kettu', NAME))
    if (next !== text) {
      await writeFile(full, next, 'utf8')
      changed++
    }
  }
  return changed
}

const l = await locales()
const c = await code()
console.log(`rebrand: ${l} locale files and ${c} code files now say ${NAME}`)
