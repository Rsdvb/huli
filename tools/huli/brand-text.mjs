// Huli: what the rebrand swaps in text, and how. rebrand.mjs writes these swaps into the tree
// before a build; dev-brand.mjs makes the same ones as `pnpm dev` loads each file, so the two
// never drift. Pure: no file is read or written here. See tools/huli/README.md.

/** The product's name in code and in every language but Chinese. */
export const NAME = 'Kite'
/** The product's name in Chinese copy. */
export const ZH_NAME = '纸鸢'
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

/** Locale files about Kettu itself, left whole: the prompts to star its repository on GitHub. */
const KEEP_FILES = new Set(['star.json'])

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
 * Code files whose literal display text is swapped, by path from the repository's root. A string
 * has its Kettu swapped for Kite; a pair is swapped for its second half; a pattern is replaced as
 * `String.replace` does, and a third pattern finds it already swapped.
 */
export const CODE = {
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
 * Kettu's service where its copy names it after the app, swapped before the name, in the order
 * applied: the account, the relay, the cloud and the published pages are Kite Cloud's, while the
 * app stays Kite (ZH_NAME). A pattern is replaced as `String.replace` does. The Marketplace, the
 * problem reports and the app itself keep the app's name.
 */
const SERVICE = [
  // The cloud switch's note: Kite Cloud is its owner's own, not a free service.
  [
    'The services Kettu runs, with a free Kettu account',
    `${CLOUD}'s services, with your own account`,
  ],
  ['Kettu 运行的服务，用一个免费的 Kettu 账号', `${CLOUD} 的服务，用你自己的账号`],
  // The first run's notes on the relay, which Kite Cloud runs.
  ['even from Kettu', `even from ${CLOUD}`],
  ['Kettu passes your sessions along', `${CLOUD} passes your sessions along`],
  ['Kettu 也看不到', `${CLOUD} 也看不到`],
  ['Kettu 只转交加密后的会话', `${CLOUD} 只转交加密后的会话`],
  // The Account page's line, which would name Kite Cloud twice.
  [', for Kettu’s cloud services', ''],
  ['，用于 Kettu 的云服务', ''],
  ['Kettu account', `${CLOUD} account`],
  ['Kettu 账号', `${CLOUD} 账号`],
  ['Kettu relay', `${CLOUD} relay`],
  ['Kettu 中继', `${CLOUD} 中继`],
  ['Kettu cloud', CLOUD],
  ['Kettu 云端存储', `${CLOUD} 存储`],
  ['Kettu 云服务', CLOUD],
  ['Kettu 的云服务', CLOUD],
  [/Kettu[’']s (?:cloud services|services|servers)\b/g, CLOUD],
  [/(经过|不连) Kettu 的服务器/g, `$1 ${CLOUD}`],
  [/(开着|打开) Kettu 的服务(?!器)/g, `$1 ${CLOUD}`],
  [/\b(Sign|signed) in to Kettu\b/g, `$1 in to ${CLOUD}`],
  ['登录 Kettu', `登录 ${CLOUD}`],
  // Where artifacts publish.
  [/\b(publish(?:es|ed|ing)?\b[^.]*? to|sharing to|on) Kettu\b(?! Marketplace)/gi, `$1 ${CLOUD}`],
  [/发布到 Kettu(?! 的 Marketplace)/g, `发布到 ${CLOUD}`],
  ['在 Kettu 上用新标签页', `在 ${CLOUD} 上用新标签页`],
  ['放在 Kettu 上的', `放在 ${CLOUD} 上的`],
]

/**
 * Copy about Kettu's own service, in the order applied: the account is Kite Cloud, signed in to
 * with a password and a one-time code, and run by its owner. URLs, as placeholders, stay.
 */
const COPY = [
  ['用邮箱、GitHub、Google 或 Apple 登录，账号免费。', `用你自己的 ${CLOUD} 账号登录。`],
  ["Use email, GitHub, Google or Apple. It's free.", `Sign in with your own ${CLOUD} account.`],
  ['如需帮助，请联系 hello@kettu.sh。', `请联系 ${CLOUD} 的管理员。`],
  ['Contact hello@kettu.sh for help.', `Ask the admin of ${CLOUD} for help.`],
  ['www.kettu.sh', CLOUD],
  ['kettu.sh', CLOUD],
  // The home folder, as `KETTU_HOME_FOLDER` in src/shared/storage.ts names it.
  ['.kettu/', '.huli/'],
  // Kite's phone app runs on Android too, and pairs as Kettu's iOS app does.
  ['iPhone、iPad 或另一台电脑', 'iPhone、iPad、Android 手机或另一台电脑'],
  [
    'an iPhone, an iPad or another computer',
    'an iPhone, an iPad, an Android phone or another computer',
  ],
  ['iPhone 或 iPad 上的', 'iPhone、iPad 或 Android 手机上的'],
  ['on an iPhone or iPad', 'on an iPhone, iPad or Android phone'],
  ['iOS 应用', '手机应用'],
  ['iOS app', 'Phone app'],
]

const HAN = '[\\u3400-\\u9FFF\\uF900-\\uFAFF]'
/** Chinese copy sets CLOUD off from Han characters with a space, as it does any Latin word. */
const spaceCloud = (text) =>
  text
    .replace(new RegExp(`(${HAN})(?=${CLOUD})`, 'g'), '$1 ')
    .replace(new RegExp(`(${CLOUD})(?=${HAN})`, 'g'), '$1 ')

/** Links shown as examples, swapped even where the text is a URL: a pairing link's address. */
const LINKS = [['https://kettu.sh/pair#', 'https://huli.invalid/pair#']]

/**
 * Kite's artwork, rendered by tools/huli/brand/render.mjs into a mirror of the repository, by path
 * from the repository's root: the app icons, the tray's images, the renderer's icon, mark and
 * glyphs, and the first run's pictures.
 */
export const ARTWORK = 'tools/huli/brand/assets/desktop'

const swapAll = (text, pairs) =>
  pairs.reduce(
    (out, [from, to]) =>
      from instanceof RegExp ? out.replace(from, to) : out.split(from).join(to),
    text,
  )

function swapName(text, zh) {
  const kept = []
  let out = text
  for (const phrase of KEEP) {
    out = out.split(phrase).join(`\uE000${kept.length}\uE000`)
    kept.push(phrase)
  }
  out = swapAll(out, SERVICE)
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
  if (typeof value === 'string') {
    const out = swapCopy(swapName(value, zh))
    return zh ? spaceCloud(out) : out
  }
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

/** A locale file's parsed catalog as Kite's, `file` its name and `lang` its folder's. */
export function brandLocale(value, file, lang) {
  if (KEEP_FILES.has(file)) return value
  const zh = lang.startsWith('zh')
  let swapped = swapValues(value, zh)
  if (zh && ZH_APP_NAME[file]) swapped = zhAppName(swapped, ZH_APP_NAME[file])
  if (ADD[file]) swapped = addKeys(swapped, ADD[file], lang)
  return swapped
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

/** A code file's text with its CODE swaps made, and the swaps no longer found in it. */
export function brandCode(text, swaps) {
  let next = text
  const missing = []
  for (const swap of swaps) {
    const made = swapCode(next, swap)
    if (!made.found) missing.push(String(swap))
    next = made.next
  }
  return { text: next, missing }
}
