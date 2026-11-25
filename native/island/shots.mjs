// @ts-check
// Huli: CI only (huli-island.yml). Runs a built kettu-island on a macOS runner's screen with a
// made-up view, as Kettu's main would send it, and takes screenshots: on the runner's own screen,
// which has no notch, and beside a notch drawn in its menu bar (`fakenotch`), with the menu bar's
// room measured or given (`room=L:R`). Usage: node shots.mjs <helper directory> <output directory>

import { spawn, spawnSync } from 'node:child_process'
import console from 'node:console'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const [helperDir, outDir] = process.argv.slice(2)
if (!helperDir || !outDir) {
  console.error('usage: node shots.mjs <helper directory> <output directory>')
  process.exit(2)
}
const helper = join(resolve(helperDir), 'kettu-island')
mkdirSync(outDir, { recursive: true })
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The helper's words, as main flattens them from the island catalog. */
function strings() {
  const flat = /** @type {Record<string, string>} */ ({})
  const walk = (/** @type {unknown} */ value, /** @type {string} */ prefix) => {
    if (typeof value === 'string') flat[prefix] = value
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value))
        walk(child, prefix ? `${prefix}.${key}` : key)
    }
  }
  const catalog = JSON.parse(readFileSync(join(root, 'src/shared/locales/en/island.json'), 'utf8'))
  walk(catalog.helper, '')
  return flat
}

const now = Date.now()
const row = {
  key: 's1',
  sessionId: 's1',
  host: null,
  parent: null,
  title: 'Keep the island off the menu bar',
  project: 'huli',
  agent: { id: 'claude-code', name: 'Claude Code', harness: 'claude-code', color: null },
  model: null,
  group: 'running',
  status: 'running',
  since: now - 120_000,
  line: 'Editing Panel.swift',
  toolSince: null,
  toolKind: null,
  turnStartedAt: now - 120_000,
  plan: { done: 2, total: 5, step: 2, current: 'Measure the room' },
  subagents: null,
  limit: null,
  phase: 'edit',
  cache: null,
}
const lines = [
  {
    type: 'hello',
    protocol: 4,
    version: '0.1.0',
    locale: 'en',
    strings: strings(),
    colorMode: 'dark',
    stuckAfterMs: 300_000,
    sides: 'auto',
  },
  {
    type: 'view',
    seq: 1,
    rows: [row],
    requests: [],
    notices: [],
    summary: { running: 1, waiting: 0, failed: 0, today: 3 },
  },
]
const pop = {
  type: 'pop',
  row: 's1',
  kind: 'error',
  title: 'Keep the island off the menu bar',
  body: 'The build failed: Panel.swift line 212',
}

/** The main screen's width in points, for a region around its top middle. */
function screenWidth() {
  const result = spawnSync(
    'osascript',
    ['-l', 'JavaScript', '-e', 'ObjC.import("AppKit"); $.NSScreen.mainScreen.frame.size.width'],
    { encoding: 'utf8' },
  )
  const width = Number(result.stdout.trim())
  return Number.isFinite(width) && width > 0 ? width : null
}

const width = screenWidth()
console.log(`Main screen: ${width ?? '?'} points wide`)

function shoot(/** @type {string} */ name, whole = false) {
  const file = join(outDir, `${name}.png`)
  const region = !whole && width ? [`-R${Math.round(width / 2 - 360)},0,720,150`] : []
  const result = spawnSync('screencapture', ['-x', ...region, file], { encoding: 'utf8' })
  console.log(`${name}: ${result.status === 0 ? file : `screencapture failed ${result.stderr}`}`)
}

/**
 * One run of the helper: `debug` is its KETTU_ISLAND_DEBUG, `steps` what to do once it shows the
 * view, each a message to send or a screenshot to take.
 */
async function run(/** @type {string} */ debug, /** @type {any[]} */ steps) {
  console.log(`\n== KETTU_ISLAND_DEBUG=${debug}`)
  const child = spawn(helper, [], {
    stdio: ['pipe', 'ignore', 'inherit'],
    env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, KETTU_ISLAND_DEBUG: debug },
  })
  for (const line of lines) child.stdin.write(`${JSON.stringify(line)}\n`)
  await sleep(1500)
  for (const step of steps) {
    if (typeof step === 'number') await sleep(step)
    else if (step.shot) shoot(step.shot, step.whole)
    else child.stdin.write(`${JSON.stringify(step)}\n`)
  }
  child.stdin.end()
  await new Promise((done) => child.on('exit', done))
}

// No notch: collapsed, the island stays out of the menu bar; a pop hangs below it.
await run('log,drive', [{ shot: 'no-notch-collapsed' }, pop, 700, { shot: 'no-notch-pop' }])
// A drawn notch, the room measured from the runner's own status items.
await run('log,drive,fakenotch', [
  { shot: 'notch-measured' },
  { shot: 'notch-measured-screen', whole: true },
])
// Given rooms: both sides free, one side, too little for the marks, none.
await run('drive,fakenotch,room=200:200', [{ shot: 'notch-room-200-200' }])
await run('drive,fakenotch,room=0:130', [{ shot: 'notch-room-0-130' }])
await run('drive,fakenotch,room=0:90', [{ shot: 'notch-room-0-90' }])
await run('drive,fakenotch,room=0:0', [
  { shot: 'notch-room-0-0' },
  { type: 'debug', kind: 'expand' },
  900,
  { shot: 'notch-room-0-0-open' },
  { type: 'debug', kind: 'collapse' },
  700,
  pop,
  700,
  { shot: 'notch-room-0-0-pop' },
])
await run('drive,fakenotch,room=60:120', [pop, 700, { shot: 'notch-room-60-120-pop' }])
