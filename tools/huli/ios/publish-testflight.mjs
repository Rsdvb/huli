// Waits for an uploaded build to finish processing, then puts it on TestFlight's public link:
// its "What to Test", the external group, and Beta App Review.
// Usage: node publish-testflight.mjs <build number> <what to test>
import { createPrivateKey, sign } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const KEY_ID = 'Y945SS5C89'
const ISSUER = '87f439b2-db97-4066-b695-34ff182c5842'
const APP = '6835835076'
const PUBLIC_GROUP = '3cbc9f80-50ef-4c76-b1c5-96708f00c296'
const [buildNumber, whatsNew] = process.argv.slice(2)

function token() {
  const key = createPrivateKey(readFileSync(`${homedir()}/.huli-keys/AuthKey_${KEY_ID}.p8`))
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' })}.${b64({ iss: ISSUER, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' })}`
  return `${unsigned}.${sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

async function api(method, path, body) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
        method,
        headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      })
      const text = await res.text()
      if (!res.ok)
        throw Object.assign(new Error(`${method} ${path}: ${res.status} ${text}`), {
          status: res.status,
        })
      return text ? JSON.parse(text) : null
    } catch (error) {
      // Only the network is retried; Apple's own refusals are final.
      if (error.status || attempt >= 5) throw error
      await new Promise((r) => setTimeout(r, 5000))
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let build = null
for (let i = 0; i < 90; i++) {
  const found = (await api('GET', `/v1/builds?filter[app]=${APP}&filter[version]=${buildNumber}`))
    .data[0]
  if (found?.attributes.processingState === 'VALID') {
    build = found
    break
  }
  if (found && found.attributes.processingState !== 'PROCESSING') {
    throw new Error(`build ${buildNumber} is ${found.attributes.processingState}`)
  }
  await sleep(60_000)
}
if (!build) throw new Error(`build ${buildNumber} did not finish processing in 90 minutes`)
console.log(`build ${buildNumber} processed (${build.attributes.buildAudienceType})`)

if (build.attributes.usesNonExemptEncryption === null) {
  await api('PATCH', `/v1/builds/${build.id}`, {
    data: { type: 'builds', id: build.id, attributes: { usesNonExemptEncryption: false } },
  })
}
await api('POST', '/v1/betaBuildLocalizations', {
  data: {
    type: 'betaBuildLocalizations',
    attributes: { locale: 'zh-Hans', whatsNew },
    relationships: { build: { data: { type: 'builds', id: build.id } } },
  },
}).catch((e) => console.log(`what to test: ${e.message}`))
await api('POST', `/v1/betaGroups/${PUBLIC_GROUP}/relationships/builds`, {
  data: [{ type: 'builds', id: build.id }],
})
console.log('added to the public link group')
const review = await api('POST', '/v1/betaAppReviewSubmissions', {
  data: {
    type: 'betaAppReviewSubmissions',
    relationships: { build: { data: { type: 'builds', id: build.id } } },
  },
})
console.log(`submitted for beta review: ${review.data.attributes.betaReviewState}`)
