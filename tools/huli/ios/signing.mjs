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
// SIGNING=development makes a build for the registered devices instead of the App Store's.
const DEV = process.env.SIGNING === 'development'
const KIND = DEV ? 'development' : 'distribution'
const CERT_TYPE = DEV ? 'DEVELOPMENT' : 'DISTRIBUTION'
const IDENTITY = DEV ? 'Apple Development' : 'Apple Distribution'
const p12 = `/ios-${KIND}.p12`
const certs = (await api('GET', `/v1/certificates?filter[certificateType]=${CERT_TYPE}&limit=50`)).data
let cert = null
if (existsSync(p12)) {
  const serial = readFileSync(`${KEYS}/ios-${KIND}.serial`, 'utf8').trim()
  cert = certs.find((c) => c.attributes.serialNumber === serial) ?? null
}
if (!cert) {
  const key = `${KEYS}/ios-${KIND}.key`
  sh('openssl', ['genrsa', '-out', key, '2048'])
  sh('chmod', ['600', key])
  const csr = sh('openssl', ['req', '-new', '-key', key, '-subj', '/CN=Huli/O=Rsdvb/C=CN'])
  cert = (
    await api('POST', '/v1/certificates', {
      data: { type: 'certificates', attributes: { certificateType: CERT_TYPE, csrContent: csr } },
    })
  ).data
  const der = `${KEYS}/ios-${KIND}.cer`
  writeFileSync(der, Buffer.from(cert.attributes.certificateContent, 'base64'))
  const pem = sh('openssl', ['x509', '-inform', 'DER', '-in', der])
  writeFileSync(`${KEYS}/ios-${KIND}.pem`, pem)
  sh('openssl', ['pkcs12', '-export', '-inkey', key, '-in', `${KEYS}/ios-${KIND}.pem`, '-out', p12, '-passout', `pass:${kpass}`, '-name', `Huli ${IDENTITY}`])
  sh('chmod', ['600', p12])
  sh('rm', ['-f', key])
  writeFileSync(`${KEYS}/ios-${KIND}.serial`, cert.attributes.serialNumber)
  console.log(`created ${KIND} certificate ${cert.id}`)
}
try {
  sh('security', ['import', p12, '-k', keychain, '-P', kpass, '-T', '/usr/bin/codesign', '-T', '/usr/bin/security'])
} catch {
  // Already imported.
}
sh('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', kpass, keychain])
const identity = sh('security', ['find-identity', '-v', '-p', 'codesigning', keychain])
  .split('\n')
  .find((l) => l.includes(IDENTITY) && (!DEV || l.includes('Huli')))
if (!identity) throw new Error(`no ${IDENTITY} identity in the keychain`)
const sha1 = identity.trim().split(/\s+/)[1]

// 2. A fresh App Store profile per bundle id, installed where Xcode looks.
const dir = `${HOME}/Library/MobileDevice/Provisioning Profiles`
mkdirSync(dir, { recursive: true })
const out = { identity: sha1, signing: IDENTITY, profiles: {} }
// A development profile lists the devices it installs on: every enabled iPhone the team has.
const devices = DEV
  ? (await api('GET', '/v1/devices?filter[platform]=IOS&filter[status]=ENABLED&limit=100')).data
  : []
if (DEV && devices.length === 0) throw new Error('no iOS device is registered')
for (const identifier of bundles) {
  const ids = (await api('GET', `/v1/bundleIds?filter[identifier]=${identifier}&limit=50`)).data
  const bundle = ids.find((b) => b.attributes.identifier === identifier)
  if (!bundle) throw new Error(`bundle id ${identifier} is not registered`)
  const name = DEV ? `Huli Development ${identifier}` : `Huli App Store ${identifier}`
  const old = (await api('GET', `/v1/profiles?filter[name]=${encodeURIComponent(name)}&limit=50`)).data
  for (const p of old) await api('DELETE', `/v1/profiles/${p.id}`)
  const profile = (
    await api('POST', '/v1/profiles', {
      data: {
        type: 'profiles',
        attributes: { name, profileType: DEV ? 'IOS_APP_DEVELOPMENT' : 'IOS_APP_STORE' },
        relationships: {
          bundleId: { data: { type: 'bundleIds', id: bundle.id } },
          certificates: { data: [{ type: 'certificates', id: cert.id }] },
          ...(DEV && { devices: { data: devices.map((d) => ({ type: 'devices', id: d.id })) } }),
        },
      },
    })
  ).data
  writeFileSync(`${dir}/${profile.attributes.uuid}.mobileprovision`, Buffer.from(profile.attributes.profileContent, 'base64'))
  out.profiles[identifier] = { name, uuid: profile.attributes.uuid }
}
writeFileSync(`${process.env.OUT ?? `${HOME}/huli/out`}/signing.json`, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
