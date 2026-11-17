// Huli's rebranding, run before a build: it swaps the product name the user sees from Kettu to
// Huli without editing the upstream sources by hand, so merging Kettu's updates stays clean.
// Idempotent. Only display text changes: JSON keys, identifiers, URL schemes such as kettu-media:
// and the KettuAI/Kettu repository name are left as they are, and so is the attribution to Kettu.

import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const NAME = 'Huli'
// Not the KettuAI organization, nor the repository named after it in `KettuAI/Kettu`.
const WORD = /(?<!KettuAI\/)\bKettu\b(?!AI)/g

/**
 * Phrases that name Kettu itself and stay as written: About's attribution of the fork, and the
 * menu item that stars Kettu's repository.
 */
const KEEP = ['Based on Kettu', 'based on Kettu', '基于 Kettu', 'Star Kettu']

/** Locale files about Kettu itself, left whole: the prompts to star its repository on GitHub. */
const KEEP_FILES = new Set(['star.json'])

/**
 * Code files whose literal display text is swapped. A string has its Kettu swapped for Huli; a
 * pair is swapped for its second half; a pattern is replaced as `String.replace` does, and a
 * third pattern finds it already swapped.
 */
const CODE = {
  'src/renderer/index.html': ['<title>Kettu</title>'],
  'src/renderer/tray.html': ['<title>Kettu</title>'],
  'src/renderer/overlay.html': ['<title>Kettu</title>'],
  'src/renderer/computer-overlay.html': ['<title>Kettu</title>'],
  'src/renderer/web/index.html': ['<title>Kettu</title>'],
  'src/renderer/src/app/window-title.ts': ["'Kettu'"],
  'src/renderer/src/components/brand.tsx': ['aria-label="Kettu"'],
  'src/renderer/src/features/settings/about-section.tsx': ['<b>Kettu</b>'],
  'src/renderer/src/features/settings/theme-section.tsx': ["theme?.name ?? 'Kettu'"],
  'src/renderer/src/features/marketplace/builtin.tsx': ['<h1>Kettu</h1>'],
  'src/renderer/src/features/marketplace/installed.tsx': ["matchesText(['Kettu']"],
  'src/renderer/src/features/marketplace/published-keys.ts': ["return 'Kettu'"],
  'src/renderer/src/features/session/entries/computer-setup-entry.tsx': ['label="Kettu"'],
  'src/renderer/src/features/updates/update-review.tsx': ["item.kind === 'app' ? 'Kettu'"],
  'src/renderer/src/features/updates/update-card.tsx': ["{ name: 'Kettu',"],
  'src/renderer/src/features/account/account-menu.tsx': ['label: `Kettu ${info.version}'],
  // The first run's pictures: the account's site in a browser's address bar, and the web app.
  'src/renderer/src/features/onboarding/stage.tsx': [
    [
      /(<Icon icon=\{SquareLock02Icon\} size=\{11\} \/>\s*)kettu\.sh/,
      '$1Huli Cloud',
      /<Icon icon=\{SquareLock02Icon\} size=\{11\} \/>\s*Huli Cloud/,
    ],
    ['hint="app.kettu.sh"', 'hint="Huli Cloud"'],
  ],
  'src/main/agent-folders.ts': ["{ agent: 'Kettu' }"],
  'src/main/login-item.ts': ["'Name=Kettu'"],
  // The pages the browser shows at the end of a sign-in.
  'src/main/account/loopback.ts': [
    'This sign-in is over. Go back to Kettu.',
    'This is not the sign-in Kettu is waiting for. Go back to Kettu and sign in again.',
    'Kettu stopped this sign-in.',
  ],
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
  // The home folder, as `KETTU_HOME_FOLDER` in src/shared/storage.ts names it.
  ['.kettu/', '.huli/'],
]

/** Links shown as examples, swapped even where the text is a URL: a pairing link's address. */
const LINKS = [['https://kettu.sh/pair#', 'https://huli.invalid/pair#']]

const swapAll = (text, pairs) => pairs.reduce((out, [from, to]) => out.split(from).join(to), text)

function swapName(text) {
  const kept = []
  let out = text
  for (const phrase of KEEP) {
    out = out.split(phrase).join(`\uE000${kept.length}\uE000`)
    kept.push(phrase)
  }
  out = out.replace(WORD, NAME)
  return out.replace(/\uE000(\d+)\uE000/g, (_, i) => kept[Number(i)])
}

function swapCopy(text) {
  const linked = swapAll(text, LINKS)
  if (/^https?:\/\//.test(linked)) return linked
  return swapAll(linked, COPY)
}

function swapValues(value) {
  if (typeof value === 'string') return swapCopy(swapName(value))
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
      if (!file.endsWith('.json') || KEEP_FILES.has(file)) continue
      const full = path.join(base, lang.name, file)
      const text = await readFile(full, 'utf8')
      const parsed = JSON.parse(text)
      const swapped = swapValues(parsed)
      // A file without anything to swap is left byte for byte as it is.
      if (JSON.stringify(swapped) === JSON.stringify(parsed)) continue
      await writeFile(full, JSON.stringify(swapped, null, 2) + '\n', 'utf8')
      changed++
    }
  }
  return changed
}

/** The text with `swap` made, and whether it was there to make, swapped or not. */
function swapCode(text, swap) {
  if (typeof swap === 'string') swap = [swap, swap.replaceAll('Kettu', NAME)]
  const [from, to, done] = swap
  if (from instanceof RegExp) {
    return { next: text.replace(from, to), found: from.test(text) || done.test(text) }
  }
  return { next: text.split(from).join(to), found: text.includes(from) || text.includes(to) }
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
    let next = text
    for (const swap of swaps) {
      const made = swapCode(next, swap)
      // A spelling upstream changed is a gap to close in this list.
      if (!made.found) console.warn(`rebrand: ${rel} no longer holds ${String(swap)}`)
      next = made.next
    }
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
