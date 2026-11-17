// Huli Cloud's settings, all from the environment so that no secret sits in the code or the unit
// file: the systemd unit points at an EnvironmentFile only the huli user reads.

import { readFileSync } from 'node:fs'
import { parseSignedRegionList } from '@shared/remote/relay-regions'

export interface ApnsConfig {
  /** The .p8 Auth Key from the Apple Developer account. */
  keyFile: string
  keyId: string
  teamId: string
  /** The iOS app's bundle id, the topic every push names. */
  topic: string
}

export interface Config {
  /** The public origin, as hosts sign it into push requests: `https://huli.example`. */
  origin: string
  host: string
  port: number
  dataDir: string
  /** Take the client address from nginx's X-Real-IP, only for connections from loopback. */
  trustProxy: boolean
  apns: ApnsConfig | null
  /** The hosted web client's origin, which signs in as `kettu-web`; null when there is none. */
  webOrigin: string | null
  /** The signed region list the relay serves, as its file holds it; null for none. */
  regions: string | null
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is not set`)
  return value
}

/** The origin of `url`, refusing anything but https outside loopback. */
export function publicOrigin(url: string): string {
  const parsed = URL.parse(url)
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    throw new Error(`HULI_ORIGIN must be an http(s) origin, not ${url}`)
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol === 'http:' && !loopback) {
    throw new Error('HULI_ORIGIN must use https outside loopback')
  }
  return parsed.origin
}

/** The signed region list in `file`, checked to be one; null without a file. */
export function readRegions(file: string | undefined): string | null {
  const name = file?.trim()
  if (!name) return null
  const text = readFileSync(name, 'utf8').trim()
  if (!parseSignedRegionList(JSON.parse(text))) {
    throw new Error(`${name} is not a signed region list`)
  }
  return text
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.HULI_PORT ?? '3010')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HULI_PORT is invalid')
  const keyFile = env.APNS_KEY_FILE?.trim()
  const web = env.HULI_WEB_ORIGIN?.trim()
  return {
    webOrigin: web ? publicOrigin(web) : null,
    regions: readRegions(env.HULI_REGIONS_FILE),
    origin: publicOrigin(required(env, 'HULI_ORIGIN')),
    host: env.HULI_HOST?.trim() || '127.0.0.1',
    port,
    dataDir: required(env, 'HULI_DATA_DIR'),
    trustProxy: env.HULI_TRUST_PROXY === '1',
    apns: keyFile
      ? {
          keyFile,
          keyId: required(env, 'APNS_KEY_ID'),
          teamId: required(env, 'APNS_TEAM_ID'),
          topic: required(env, 'APNS_TOPIC'),
        }
      : null,
  }
}
