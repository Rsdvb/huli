// Samples what the app costs on the emulator for a while, for run.sh: its process's CPU time and
// memory from /proc every second, SurfaceFlinger's CPU, and the frames the app rendered
// (dumpsys gfxinfo), then prints the CPU as a share of one core over the window and its busiest
// second, and adds them to a JSON file. The Android twin of ../ios/sim/sample.mjs.
// Usage: node sample.mjs <scenario> <seconds> <out.jsonl>. Huli's own; see tools/huli/README.md.

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const [name, secondsText, out] = process.argv.slice(2)
if (!name || !secondsText || !out) throw new Error('Usage: node sample.mjs <name> <seconds> <out>')
const seconds = Number(secondsText)
const PACKAGE = 'io.github.rsdvb.huli'
const TICK = 100

const adb = (command) => {
  try {
    return execFileSync('adb', ['shell', command], { encoding: 'utf8', timeout: 10_000 }).trim()
  } catch {
    return ''
  }
}

const pidOf = (process) => adb(`pidof ${process}`).split(/\s+/)[0] || null
const app = pidOf(PACKAGE)
const flinger = pidOf('surfaceflinger')

/** A process's CPU time in seconds and its resident memory in MB, or null when it is gone. */
function read(pid) {
  if (!pid) return null
  const text = adb(`cat /proc/${pid}/stat; grep VmRSS /proc/${pid}/status`)
  const stat = /\)\s+(.*)$/m.exec(text)?.[1]?.split(/\s+/)
  if (!stat) return null
  const rss = Number(/VmRSS:\s+(\d+)/.exec(text)?.[1] ?? 0)
  return { cpu: (Number(stat[11]) + Number(stat[12])) / TICK, rssMb: Math.round(rss / 102.4) / 10 }
}

const frames = () =>
  Number(/Total frames rendered:\s*(\d+)/.exec(adb(`dumpsys gfxinfo ${PACKAGE}`))?.[1] ?? NaN)

adb(`dumpsys gfxinfo ${PACKAGE} reset`)
const startFrames = frames()
const snaps = []
for (let i = 0; i <= seconds; i++) {
  if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1000))
  snaps.push({ at: Date.now(), app: read(app), flinger: read(flinger) })
}
const endFrames = frames()
const wall = (snaps.at(-1).at - snaps[0].at) / 1000

function usage(key) {
  const a = snaps[0][key]
  const b = snaps.at(-1)[key]
  if (!a || !b) return null
  let peak = 0
  for (let i = 1; i < snaps.length; i++) {
    const x = snaps[i - 1][key]
    const y = snaps[i][key]
    if (!x || !y) continue
    peak = Math.max(peak, ((y.cpu - x.cpu) / ((snaps[i].at - snaps[i - 1].at) / 1000)) * 100)
  }
  return {
    cpu: Math.round(((b.cpu - a.cpu) / wall) * 1000) / 10,
    peak: Math.round(peak * 10) / 10,
    rssMb: b.rssMb,
  }
}

const rendered = endFrames - startFrames
const result = {
  name,
  seconds: Math.round(wall * 10) / 10,
  app: usage('app'),
  surfaceflinger: usage('flinger'),
  frames: Number.isFinite(rendered) ? rendered : null,
  fps: Number.isFinite(rendered) ? Math.round((rendered / wall) * 10) / 10 : null,
}
appendFileSync(out, `${JSON.stringify(result)}\n`)
const show = (u) => (u ? `${u.cpu}% (peak ${u.peak}%, ${u.rssMb} MB)` : '-')
console.log(
  `${name}: app ${show(result.app)} · ${result.fps ?? '-'} frames/s · ` +
    `surfaceflinger ${show(result.surfaceflinger)}`,
)
