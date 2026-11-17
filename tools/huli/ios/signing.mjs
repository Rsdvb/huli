// Prepares manual App Store signing through the App Store Connect API: an Apple Distribution
// certificate whose key lives in the build keychain, and an App Store profile per bundle id.
// Usage: node signing.mjs <keychain> <keychain password file> <bundle id>...
import { execFileSync } from 'node:child_process'
import { createPrivateKey, sign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'

const KEY_ID = 'Y945SS5C89'
const ISSUER = '87f439b2-db97-4066-b695-34ff182c5842'
const HOME = homedir()
const KEYS = `${HOME}/.huli-keys`
const [keychain, passFile, ...bundles] = process.argv.slice(2)
const kpass = readFileSync(passFile, 'utf8').trim()

function token() {
  const key = createPrivateKey(readFileSync(`${KEYS}/AuthKey_${KEY_ID}.p8`))
  const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' })}.${b64({ iss: ISSUER, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' })}`
  return `${unsigned}.${sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

async function api(method, path, body) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

const sh = (cmd, args, input) => execFileSync(cmd, args, { input, encoding: 'utf8' })

// 1. The distribution certificate, reused while its key is in the keychain.
const p12 = `${KEYS}/ios-distribution.p12`
const certs = (await api('GET', '/v1/certificates?filter[certificateType]=DISTRIBUTION&limit=50')).data
let cert = null
if (existsSync(p12)) {
  const serial = readFileSync(`${KEYS}/ios-distribution.serial`, 'utf8').trim()
  cert = certs.find((c) => c.attributes.serialNumber === serial) ?? null
}
if (!cert) {
  const key = `${KEYS}/ios-distribution.key`
  sh('openssl', ['genrsa', '-out', key, '2048'])
  sh('chmod', ['600', key])
  const csr = sh('openssl', ['req', '-new', '-key', key, '-subj', '/CN=Huli/O=Rsdvb/C=CN'])
  cert = (
    await api('POST', '/v1/certificates', {
      data: { type: 'certificates', attributes: { certificateType: 'DISTRIBUTION', csrContent: csr } },
    })
  ).data
  const der = `${KEYS}/ios-distribution.cer`
  writeFileSync(der, Buffer.from(cert.attributes.certificateContent, 'base64'))
  const pem = sh('openssl', ['x509', '-inform', 'DER', '-in', der])
  writeFileSync(`${KEYS}/ios-distribution.pem`, pem)
  sh('openssl', ['pkcs12', '-export', '-inkey', key, '-in', `${KEYS}/ios-distribution.pem`, '-out', p12, '-passout', `pass:${kpass}`, '-name', 'Huli Apple Distribution'])
  sh('chmod', ['600', p12])
  sh('rm', ['-f', key])
  writeFileSync(`${KEYS}/ios-distribution.serial`, cert.attributes.serialNumber)
  console.log(`created distribution certificate ${cert.id}`)
}
try {
  sh('security', ['import', p12, '-k', keychain, '-P', kpass, '-T', '/usr/bin/codesign', '-T', '/usr/bin/security'])
} catch {
  // Already imported.
}
sh('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', kpass, keychain])
const identity = sh('security', ['find-identity', '-v', '-p', 'codesigning', keychain])
  .split('\n')
  .find((l) => l.includes('Apple Distribution'))
if (!identity) throw new Error('no Apple Distribution identity in the keychain')
const sha1 = identity.trim().split(/\s+/)[1]

// 2. A fresh App Store profile per bundle id, installed where Xcode looks.
const dir = `${HOME}/Library/MobileDevice/Provisioning Profiles`
mkdirSync(dir, { recursive: true })
const out = { identity: sha1, profiles: {} }
for (const identifier of bundles) {
  const ids = (await api('GET', `/v1/bundleIds?filter[identifier]=${identifier}&limit=50`)).data
  const bundle = ids.find((b) => b.attributes.identifier === identifier)
  if (!bundle) throw new Error(`bundle id ${identifier} is not registered`)
  const name = `Huli App Store ${identifier}`
  const old = (await api('GET', `/v1/profiles?filter[name]=${encodeURIComponent(name)}&limit=50`)).data
  for (const p of old) await api('DELETE', `/v1/profiles/${p.id}`)
  const profile = (
    await api('POST', '/v1/profiles', {
      data: {
        type: 'profiles',
        attributes: { name, profileType: 'IOS_APP_STORE' },
        relationships: {
          bundleId: { data: { type: 'bundleIds', id: bundle.id } },
          certificates: { data: [{ type: 'certificates', id: cert.id }] },
        },
      },
    })
  ).data
  writeFileSync(`${dir}/${profile.attributes.uuid}.mobileprovision`, Buffer.from(profile.attributes.profileContent, 'base64'))
  out.profiles[identifier] = { name, uuid: profile.attributes.uuid }
}
writeFileSync(`${HOME}/huli/out/signing.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
