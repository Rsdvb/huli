// App Store Connect API helper: node asc.mjs GET /v1/certificates | node asc.mjs DELETE /v1/certificates/<id>
import { createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const KEY_ID = 'Y945SS5C89'
const ISSUER = '87f439b2-db97-4066-b695-34ff182c5842'
const key = createPrivateKey(readFileSync(`${homedir()}/.huli-keys/AuthKey_${KEY_ID}.p8`))
const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')
const now = Math.floor(Date.now() / 1000)
const head = b64({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' })
const body = b64({ iss: ISSUER, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' })
const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' })
const jwt = `${head}.${body}.${sig.toString('base64url')}`

const [method, path, bodyFile] = process.argv.slice(2)
const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
  method,
  headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
  body: bodyFile ? readFileSync(bodyFile, 'utf8') : undefined,
})
const text = await res.text()
console.log(res.status)
if (text && process.env.RAW) console.log(text)
else if (text) {
  const json = JSON.parse(text)
  for (const d of json.data ?? [])
    console.log(d.id, d.attributes?.certificateType ?? '', d.attributes?.name ?? '', d.attributes?.displayName ?? '', d.attributes?.expirationDate ?? '')
  if (json.errors) console.log(JSON.stringify(json.errors))
}
