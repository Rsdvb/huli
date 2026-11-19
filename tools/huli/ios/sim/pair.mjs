// Pairs the simulator's app with the daemon started by run.sh: runs `kettu pair`, launches the app
// with the code as its -huliPair argument (iOS asks before it opens a huli:// link, and a
// simulator has no camera), and answers the daemon's questions as its owner would.
// Usage: node pair.mjs <simulator udid>. Huli's own; see tools/huli/README.md.

import { execFileSync, spawn } from 'node:child_process'

const udid = process.argv[2]
if (!udid) throw new Error('Usage: node pair.mjs <udid>')

const child = spawn(process.execPath, ['out/daemon/main.cjs', 'pair'], {
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit'],
})
let seen = ''
let launched = false
let added = false
let named = false
// Nothing of what it prints goes to the log, which a public repository shows: it holds the code
// and the computer's addresses.
child.stdout.on('data', (chunk) => {
  const text = chunk.toString()
  seen += text
  const link = /\S+\/pair#\S+/.exec(seen)?.[0]
  if (link && !launched) {
    launched = true
    try {
      execFileSync('xcrun', ['simctl', 'terminate', udid, 'io.github.rsdvb.huli'], {
        stdio: 'ignore',
      })
    } catch {
      // Not running yet.
    }
    execFileSync('xcrun', [
      'simctl',
      'launch',
      udid,
      'io.github.rsdvb.huli',
      '-huliNoAsk',
      'YES',
      '-huliPair',
      link,
    ])
  }
  if (!added && /Add this device\?/.test(seen)) {
    added = true
    child.stdin.write('y\n')
  }
  if (added && !named && /Name: /.test(seen.slice(seen.indexOf('Add this device?')))) {
    named = true
    child.stdin.write('\n')
  }
})
const timer = setTimeout(() => {
  console.error('No device paired within 3 minutes')
  child.kill()
  process.exit(1)
}, 180_000)
child.on('exit', (code) => {
  clearTimeout(timer)
  console.log(code === 0 ? 'Paired.' : `kettu pair ended with ${code}`)
  process.exit(code ?? 1)
})
