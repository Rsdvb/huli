// Samples what the simulator's processes cost for a while, for measure.sh: every second it reads
// each process's CPU time and memory with `ps`, then prints the app's, the simulator's render
// server's and Maestro's driver's CPU (the share of one core over the window and its busiest
// second) and memory, with the processes that took the most CPU, and adds them to a JSON file.
// Usage: node sample.mjs <scenario> <seconds> <out.jsonl>. Huli's own; see tools/huli/README.md.

import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

const [name, secondsText, out] = process.argv.slice(2)
if (!name || !secondsText || !out) throw new Error('Usage: node sample.mjs <name> <seconds> <out>')
const seconds = Number(secondsText)

const WATCHED = {
  app: /\/Huli\.app\/Huli(\s|$)/,
  backboardd: /RuntimeRoot\/usr\/libexec\/backboardd(\s|$)/,
  simMetal: /SimMetalHost|SimRenderServer/,
  maestro: /maestro-driver/i,
}

/** CPU time as ps prints it, [[dd-]hh:]mm:ss.ss, in seconds. */
function cpuSeconds(text) {
  const [days, rest] = text.includes('-') ? text.split('-') : ['0', text]
  return rest
    .split(':')
    .map(Number)
    .reduce((sum, part) => sum * 60 + part, Number(days) * 86400)
}

function snapshot() {
  const text = execFileSync('ps', ['-Ao', 'pid=,time=,rss=,command='], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const at = Date.now()
  const procs = new Map()
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/.exec(line)
    if (!m) continue
    procs.set(Number(m[1]), { cpu: cpuSeconds(m[2]), rssKb: Number(m[3]), command: m[4] })
  }
  return { at, procs }
}

const snaps = [snapshot()]
for (let i = 0; i < seconds; i++) {
  await new Promise((resolve) => setTimeout(resolve, 1000))
  snaps.push(snapshot())
}
const first = snaps[0]
const last = snaps.at(-1)
const wall = (last.at - first.at) / 1000

function usage(pid) {
  const a = first.procs.get(pid)
  const b = last.procs.get(pid)
  if (!a || !b) return null
  let peak = 0
  for (let i = 1; i < snaps.length; i++) {
    const x = snaps[i - 1].procs.get(pid)
    const y = snaps[i].procs.get(pid)
    if (!x || !y) continue
    const dt = (snaps[i].at - snaps[i - 1].at) / 1000
    peak = Math.max(peak, ((y.cpu - x.cpu) / dt) * 100)
  }
  return {
    pid,
    cpu: Math.round(((b.cpu - a.cpu) / wall) * 1000) / 10,
    peak: Math.round(peak * 10) / 10,
    rssMb: Math.round(b.rssKb / 102.4) / 10,
  }
}

const result = { name, seconds: Math.round(wall * 10) / 10, at: new Date(first.at).toISOString() }
for (const [key, pattern] of Object.entries(WATCHED)) {
  const pids = [...last.procs].filter(([, p]) => pattern.test(p.command)).map(([pid]) => pid)
  const each = pids.map(usage).filter(Boolean)
  // Several of a kind (such as two render processes) count together.
  result[key] = each.length
    ? {
        cpu: Math.round(each.reduce((s, u) => s + u.cpu, 0) * 10) / 10,
        peak: Math.max(...each.map((u) => u.peak)),
        rssMb: Math.round(each.reduce((s, u) => s + u.rssMb, 0) * 10) / 10,
        count: each.length,
      }
    : null
}
result.top = [...last.procs.keys()]
  .map((pid) => ({ pid, use: usage(pid), command: last.procs.get(pid).command }))
  .filter((p) => p.use && p.use.cpu > 0.5)
  .sort((a, b) => b.use.cpu - a.use.cpu)
  .slice(0, 10)
  .map((p) => ({
    cpu: p.use.cpu,
    rssMb: p.use.rssMb,
    command: p.command.replace(/^.*\//, '').slice(0, 80),
  }))
appendFileSync(out, `${JSON.stringify(result)}\n`)
const show = (u) => (u ? `${u.cpu}% (peak ${u.peak}%, ${u.rssMb} MB)` : '-')
console.log(
  `${name}: app ${show(result.app)} · backboardd ${show(result.backboardd)} · ` +
    `render ${show(result.simMetal)} · maestro ${show(result.maestro)}`,
)
