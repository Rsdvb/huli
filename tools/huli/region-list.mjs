// Huli's signed relay region list, made on the owner's computer, where its signing keys live
// (`~/.huli-keys`, never in the repository; their public halves are REGION_KEYS in
// src/shared/remote/relay-regions.ts).
//
//   node tools/huli/region-list.mjs keys   makes the current and the next key once, prints both
//   node tools/huli/region-list.mjs sign   signs cloud/deploy/regions.json with the current key
//                                          into cloud/deploy/regions.signed.json, serial + 1
//
// Huli Cloud serves the signed file as it is on GET /v1/regions; install.sh copies it over.

import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const KEYS = path.join(homedir(), '.huli-keys')
const SOURCE = path.join(ROOT, 'cloud', 'deploy', 'regions.json')
const SIGNED = path.join(ROOT, 'cloud', 'deploy', 'regions.signed.json')
/** As REGION_LIST_CONTEXT in src/shared/remote/relay-regions.ts. */
const CONTEXT = 'kettu-regions/1\n'
/** The key ids, as REGION_KEYS names them: the current signs, the next waits for a rotation. */
const SLOTS = { current: 'r1', next: 'r2' }

const keyFile = (slot) => path.join(KEYS, `region-list-${slot}.pem`)

function publicOf(privateKey) {
  return privateKey.export({ format: 'jwk' }).x
}

function keys() {
  mkdirSync(KEYS, { recursive: true })
  for (const [slot, id] of Object.entries(SLOTS)) {
    const file = keyFile(slot)
    if (!existsSync(file)) {
      const { privateKey } = generateKeyPairSync('ed25519')
      writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
      writeFileSync(path.join(KEYS, `region-list-${slot}.pub.txt`), `${publicOf(privateKey)}\n`)
      console.log(`made ${file}`)
    }
    const key = createPrivateKey(readFileSync(file))
    console.log(`${id} (${slot}): ${publicOf(key)}`)
  }
}

function signList() {
  const key = createPrivateKey(readFileSync(keyFile('current')))
  const source = JSON.parse(readFileSync(SOURCE, 'utf8'))
  let serial = 1
  if (existsSync(SIGNED)) {
    const before = JSON.parse(readFileSync(SIGNED, 'utf8'))
    serial = JSON.parse(Buffer.from(before.payload, 'base64url').toString('utf8')).serial + 1
  }
  const list = { v: 1, serial, issuedAt: Date.now(), ...source }
  const payload = Buffer.from(JSON.stringify(list), 'utf8').toString('base64url')
  const signature = sign(null, Buffer.from(`${CONTEXT}${payload}`, 'utf8'), key)
  const signed = { key: SLOTS.current, payload, signature: signature.toString('base64url') }
  writeFileSync(SIGNED, `${JSON.stringify(signed, null, 2)}\n`)
  console.log(`signed serial ${serial} with ${SLOTS.current} into ${path.relative(ROOT, SIGNED)}`)
}

const command = process.argv[2]
if (command === 'keys') keys()
else if (command === 'sign') signList()
else {
  console.log('usage: node tools/huli/region-list.mjs keys | sign')
  process.exitCode = 2
}
