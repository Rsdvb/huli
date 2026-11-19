// Huli's rebranding, run before a build: it swaps the product the user sees from Kettu to Kite
// (ZH_NAME in Chinese copy) without editing the upstream sources by hand, so merging Kettu's updates stays
// clean. Idempotent. Only display text and artwork change: JSON keys, identifiers, URL schemes
// such as kettu-media: and the KettuAI/Kettu repository name are left as they are, and so is the
// attribution to Kettu. The fork itself is still Huli inside (its ids, data folders, update
// channel and repository); see tools/huli/README.md.

import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
/** The product's name in code and in every language but Chinese. */
const NAME = 'Kite'
/** The product's name in Chinese copy. */
const ZH_NAME = '纸鸢'
/** The account service and push gateway's name, in every language. */
const CLOUD = 'Kite Cloud'
// Not the KettuAI organization, nor the repository named after it in `KettuAI/Kettu`. The spaces
// around it are matched so Chinese copy can drop those that set the Latin name off.
const WORD = /( ?)(?<!KettuAI\/)\bKettu\b(?!AI)( ?)/g
const CJK = /[\u3000-\u303F\u3400-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/

/**
 * Phrases that name Kettu itself and stay as written: About's attribution of the fork, and the
 * menu item that stars Kettu's repository.
 */
const KEEP = ['Based on Kettu', 'based on Kettu', '基于 Kettu', 'Star Kettu']

/**
 * Locale files about Kettu itself, left whole: the prompts to star its repository on GitHub, and
 * the import from an official Kettu, which names that app.
 */
const KEEP_FILES = new Set(['star.json', 'kettuImport.json'])

/**
 * Chinese strings whose `{{name}}` is the app's own name, which the main process fills with the
 * product name in Latin letters (`app.name`): the macOS app menu, the quit dialog and the tray's
 * menu. Chinese copy names the app ZH_NAME instead.
 */
const ZH_APP_NAME = {
  'main.json': [
    'menu.about',
    'menu.hide',
    'menu.quit',
    'quit.titleQuit',
    'quit.titleRestart',
    'tray.open',
    'tray.quit',
  ],
}

/** Keys the rebranded code reads, by locale file, key path and language (`*` for the rest). */
const ADD = {
  // About's title: both names in Chinese, since ZH_NAME is the Chinese name of Kite.
  'settings.json': { 'about.version.name': { 'zh-CN': `${ZH_NAME} ${NAME}`, '*': NAME } },
}

/**
 * Code files whose literal display text is swapped. A string has its Kettu swapped for Kite; a
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
  'src/renderer/src/features/settings/about-section.tsx': [
    ['<b>Kettu</b>', "<b>{t('about.version.name')}</b>"],
  ],
  'src/renderer/src/features/settings/theme-section.tsx': ["theme?.name ?? 'Kettu'"],
  'src/renderer/src/features/marketplace/builtin.tsx': ['<h1>Kettu</h1>'],
  'src/renderer/src/features/marketplace/installed.tsx': ["matchesText(['Kettu']"],
  'src/renderer/src/features/marketplace/published-keys.ts': ["return 'Kettu'"],
  'src/renderer/src/features/session/entries/computer-setup-entry.tsx': ['label="Kettu"'],
  'src/renderer/src/features/updates/update-review.tsx': ['name="Kettu"'],
  'src/renderer/src/features/updates/update-card.tsx': ["name: 'Kettu',"],
  'src/renderer/src/features/updates/card-model.ts': ["item.kind === 'app' ? 'Kettu'"],
  'src/renderer/src/features/account/account-menu.tsx': ['label: `Kettu ${info.version}'],
  // The first run's pictures: the account's site in a browser's address bar, and the web app.
  'src/renderer/src/features/onboarding/stage.tsx': [
    [
      /(<Icon icon=\{SquareLock02Icon\} size=\{11\} \/>\s*)kettu\.sh/,
      `$1${CLOUD}`,
      new RegExp(`<Icon icon=\\{SquareLock02Icon\\} size=\\{11\\} \\/>\\s*${CLOUD}`),
    ],
    ['hint="app.kettu.sh"', `hint="${CLOUD}"`],
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
 * Copy about Kettu's own service, in the order applied: the account is Kite Cloud, signed in to
 * with a password and a one-time code, and run by its owner. URLs, as placeholders, stay.
 */
const COPY = [
  ['用邮箱、GitHub、Google 或 Apple 登录，账号免费。', `用你自己的 ${CLOUD} 账号登录。`],
  ["Use email, GitHub, Google or Apple. It's free.", `Sign in with your own ${CLOUD} account.`],
  ['如需帮助，请联系 hello@kettu.sh。', '在服务器上用 huli-cloud 命令处理。'],
  ['Contact hello@kettu.sh for help.', 'Fix it on the server with the huli-cloud command.'],
  ['www.kettu.sh', CLOUD],
  ['kettu.sh', CLOUD],
  // The home folder, as `KETTU_HOME_FOLDER` in src/shared/storage.ts names it.
  ['.kettu/', '.huli/'],
]

/** Links shown as examples, swapped even where the text is a URL: a pairing link's address. */
const LINKS = [['https://kettu.sh/pair#', 'https://huli.invalid/pair#']]

/**
 * Kite's artwork, rendered by tools/huli/brand/render.mjs into a mirror of the repository and
 * copied over Kettu's: the app icons, the tray's images, the renderer's icon, mark and glyphs, and
 * the first run's pictures. Folders in REPLACED are emptied first, as Kite's hold other files.
 */
const ARTWORK = path.join(ROOT, 'tools', 'huli', 'brand', 'assets', 'desktop')
const REPLACED = ['build/icon.icon']

const swapAll = (text, pairs) => pairs.reduce((out, [from, to]) => out.split(from).join(to), text)

function swapName(text, zh) {
  const kept = []
  let out = text
  for (const phrase of KEEP) {
    out = out.split(phrase).join(`\uE000${kept.length}\uE000`)
    kept.push(phrase)
  }
  out = out.replace(WORD, (match, before, after, offset, whole) => {
    if (!zh) return `${before}${NAME}${after}`
    // The Chinese name sits in Chinese without the spaces a Latin word takes, but keeps them
    // beside Latin text.
    const left = before && !CJK.test(whole[offset - 1] ?? '') ? ' ' : ''
    const right = after && !CJK.test(whole[offset + match.length] ?? '') ? ' ' : ''
    return `${left}${ZH_NAME}${right}`
  })
  return out.replace(/\uE000(\d+)\uE000/g, (_, i) => kept[Number(i)])
}

function swapCopy(text) {
  const linked = swapAll(text, LINKS)
  if (/^https?:\/\//.test(linked)) return linked
  return swapAll(linked, COPY)
}

function swapValues(value, zh) {
  if (typeof value === 'string') return swapCopy(swapName(value, zh))
  if (Array.isArray(value)) return value.map((v) => swapValues(v, zh))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, swapValues(v, zh)]))
  }
  return value
}

/** In Chinese, `{{name}}` swapped for ZH_NAME under the key paths given, and its spaces as above. */
function zhAppName(value, paths, at = '') {
  if (typeof value === 'string') {
    if (!paths.includes(at)) return value
    return value.replace(/ ?\{\{name\}\} ?/g, (match, offset, whole) => {
      const left = match.startsWith(' ') && !CJK.test(whole[offset - 1] ?? '') ? ' ' : ''
      const right = match.endsWith(' ') && !CJK.test(whole[offset + match.length] ?? '') ? ' ' : ''
      return `${left}${ZH_NAME}${right}`
    })
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, zhAppName(v, paths, at ? `${at}.${k}` : k)]),
    )
  }
  return value
}

function addKeys(value, keys, lang) {
  for (const [key, byLang] of Object.entries(keys)) {
    const parts = key.split('.')
    let node = value
    for (const part of parts.slice(0, -1)) node = node[part] ??= {}
    node[parts.at(-1)] = byLang[lang] ?? byLang['*']
  }
  return value
}

async function locales() {
  const base = path.join(ROOT, 'src', 'shared', 'locales')
  let changed = 0
  for (const lang of await readdir(base, { withFileTypes: true })) {
    if (!lang.isDirectory()) continue
    const zh = lang.name.startsWith('zh')
    for (const file of await readdir(path.join(base, lang.name))) {
      if (!file.endsWith('.json') || KEEP_FILES.has(file)) continue
      const full = path.join(base, lang.name, file)
      const text = await readFile(full, 'utf8')
      const parsed = JSON.parse(text)
      let swapped = swapValues(parsed, zh)
      if (zh && ZH_APP_NAME[file]) swapped = zhAppName(swapped, ZH_APP_NAME[file])
      if (ADD[file]) swapped = addKeys(swapped, ADD[file], lang.name)
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

/** Every file under `dir`, relative to it, with forward slashes. */
async function files(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).replaceAll('\\', '/'))
}

async function artwork() {
  const ours = await files(ARTWORK)
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
  await cp(ARTWORK, ROOT, { recursive: true, force: true })
  return ours.length
}

const l = await locales()
const c = await code()
const a = await artwork()
console.log(
  `rebrand: ${l} locale files and ${c} code files now say ${NAME} (${ZH_NAME}); ${a} artwork files copied`,
)
