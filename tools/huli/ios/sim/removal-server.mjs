// The computer's owner removing the phone, on the 99-phone-removed flow's word (run.sh starts it):
// a POST to /remove on the runner's loopback removes every device paired with the daemon, through
// `kettu devices remove` as the owner would, and answers once it has. Huli's own; see
// tools/huli/README.md.

import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'

const PORT = 41731
const run = promisify(execFile)
const kettu = (...args) =>
  run(process.execPath, ['out/daemon/main.cjs', ...args], { env: process.env })

async function removeAll() {
  const { stdout } = await kettu('devices')
  // The table's first column, under its ID header.
  const ids = stdout
    .split('\n')
    .slice(1)
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean)
  for (const id of ids) await kettu('devices', 'remove', id)
  return ids.length
}

createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/remove') {
    response.writeHead(404).end()
    return
  }
  removeAll().then(
    (count) => {
      console.log(`removed ${count} device(s)`)
      response.writeHead(count > 0 ? 200 : 409).end(`removed ${count}`)
    },
    (error) => {
      console.error(error)
      response.writeHead(500).end(String(error?.message ?? error))
    },
  )
}).listen(PORT, '127.0.0.1')
