// Pairs the emulator's app with the daemon started by run.sh: runs `kettu pair`, opens the code in
// the app as a huli://pair link, and answers the daemon's questions as its owner would. The
// Android twin of ../ios/sim/pair.mjs. Usage: node pair.mjs. Huli's own; see tools/huli/README.md.

import { execFileSync, spawn } from 'node:child_process'

const child = spawn(process.execPath, ['out/daemon/main.cjs', 'pair'], {
  env: process.env,
  stdio: ['pipe', 'pipe', 'inherit'],
})
let seen = ''
let opened = false
let added = false
let named = false
// Nothing of what it prints goes to the log, which a public repository shows: it holds the code
// and the computer's addresses.
child.stdout.on('data', (chunk) => {
  seen += chunk.toString()
  const code = /\S+\/pair#(\S+)/.exec(seen)?.[1]
  if (code && !opened) {
    opened = true
    execFileSync('adb', [
      'shell',
      `am start -W -a android.intent.action.VIEW -d 'huli://pair#${code}' io.github.rsdvb.huli`,
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
