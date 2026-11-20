// A local end-to-end check of the relay, run by hand after `pnpm build` and
// `tools/huli/deploy-cloud.ps1 -BuildOnly`: the built Huli Cloud bundle, the built daemon as the
// host (in WSL on Windows, where the daemon does not run), and this process as a device pairing
// and talking to the host through the relay alone. E2E_LOCAL=1 runs it; HULI_WSL_NODE names WSL's
// Node.js 24.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AccountApi } from '@shared/account-api'
import { generateKeyPair } from '@shared/remote/noise'
import { HostLink, hello } from '@shared/remote/link'
import { pair } from '@shared/remote/pair'
import { parsePairingLink } from '@shared/remote/pairing'
import { dialRelay } from '@shared/remote/relay-device'
import { webSocketTransport } from '@shared/remote/websocket-transport'
import { base32Decode, hashPassword, hotp, newTotpSecret, TOTP_PERIOD_S } from '../src/secrets'
import { signInSteps } from './accounts'

const ROOT = path.join(import.meta.dirname, '..', '..')
const PORT = 3911
// WSL's own address, which both Windows and WSL reach.
const HOST =
  process.platform === 'win32'
    ? spawnSync('wsl', ['-e', 'hostname', '-I']).stdout.toString().trim().split(/\s+/)[0]!
    : '127.0.0.1'
const BASE = `http://127.0.0.1:${PORT}`
/** Where this process reaches it. */
const DEVICE = `http://${HOST}:${PORT}`
const PASSWORD = 'correct horse battery staple'
const procs: ChildProcess[] = []
const output = new Map<ChildProcess, string>()

// The daemon runs on macOS and Linux only: on Windows, the cloud and the daemon run in WSL, whose
// ports Windows reaches on localhost.
/** Node.js 24 in WSL, as HULI_WSL_NODE names it. */
const WSL_NODE = process.env.HULI_WSL_NODE ?? 'node'
const toWsl = (file: string) =>
  file.replace(/^([A-Za-z]):\\/, (_, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, '/')

function run(args: string[], env: Record<string, string>, name: string): ChildProcess {
  const vars = Object.entries(env).map(([k, v]) => `${k}=${v.includes(':\\') ? toWsl(v) : v}`)
  const child =
    process.platform === 'win32'
      ? spawn('wsl', ['--cd', toWsl(ROOT), '-e', 'env', ...vars, WSL_NODE, ...args])
      : spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env } })
  output.set(child, '')
  const keep = (chunk: Buffer) => {
    output.set(child, output.get(child)! + chunk.toString())
    if (process.env.E2E_VERBOSE) process.stdout.write(`[${name}] ${chunk}`)
  }
  child.stdout!.on('data', keep)
  child.stderr!.on('data', keep)
  procs.push(child)
  return child
}

async function waitFor<T>(
  what: string,
  check: () => T | null | undefined,
  ms = 60_000,
): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

describe.runIf(process.env.E2E_LOCAL)('relay end to end', () => {
  it('pairs and talks to the daemon through the relay alone', { timeout: 240_000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'huli-e2e-'))
    const cloudDir = path.join(dir, 'cloud')
    mkdirSync(cloudDir)
    const secret = newTotpSecret()
    writeFileSync(
      path.join(cloudDir, 'state.json'),
      JSON.stringify({
        v: 1,
        account: {
          id: 'acct-e2e',
          email: 'me@example.com',
          name: 'Me',
          password: await hashPassword(PASSWORD),
          totp: secret,
          totpLastStep: -1,
          recovery: [],
        },
        families: [],
        access: [],
      }),
    )
    const cloud = run(
      ['out/cloud-deploy/huli-cloud.mjs', 'serve'],
      {
        HULI_ORIGIN: BASE,
        HULI_PORT: String(PORT),
        HULI_HOST: '0.0.0.0',
        HULI_DATA_DIR: cloudDir,
        HULI_WEB_ORIGIN: 'http://localhost:5199',
        HULI_REGIONS_FILE: path.join(ROOT, 'cloud', 'deploy', 'regions.signed.json'),
      },
      'cloud',
    )
    try {
      await waitFor('the cloud', () => output.get(cloud)!.includes('listening'))

      // One web session approves every device code: the owner's password, then its code.
      const code = hotp(base32Decode(secret), Math.floor(Date.now() / 1000 / TOTP_PERIOD_S))
      const login = await signInSteps(
        (fields) =>
          fetch(`${DEVICE}/web/login`, {
            method: 'POST',
            body: new URLSearchParams(fields),
            redirect: 'manual',
          }),
        { password: PASSWORD, next: '/account/devices/' },
        code,
      )
      expect(login.status).toBe(302)
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!
      const approve = async (userCode: string) => {
        const page = await (
          await fetch(`${DEVICE}/device?code=${userCode}`, { headers: { cookie } })
        ).text()
        const csrf = /name="csrf" value="([^"]+)"/.exec(page)![1]!
        const answer = await fetch(`${DEVICE}/device`, {
          method: 'POST',
          headers: { cookie },
          body: new URLSearchParams({ csrf, user_code: userCode, action: 'allow' }),
        })
        expect(answer.status).toBe(200)
      }

      const daemonEnv = {
        KETTU_DAEMON_DATA: `/tmp/huli-e2e-daemon-${Date.now()}`,
        KETTU_ACCOUNT_URL: BASE,
        KETTU_RELAY_URL: BASE,
        KETTU_PUSH_URL: BASE,
        KETTU_DIRECT_PORT: '4791',
      }
      const signIn = run(['out/daemon/main.cjs', 'login'], daemonEnv, 'login')
      const userCode = await waitFor(
        'the user code',
        () => /[B-Z]{4}-[B-Z]{4}/.exec(output.get(signIn)!)?.[0],
      )
      await approve(userCode)
      await new Promise((resolve) => signIn.on('exit', resolve))

      const daemon = run(['out/daemon/main.cjs', 'run'], daemonEnv, 'daemon')
      await waitFor('the host on the relay', () =>
        output.get(cloud)!.match(/relay host [a-z2-7]{8} signed in/),
      )

      const adding = run(['out/daemon/main.cjs', 'pair'], daemonEnv, 'pair')
      const link = await waitFor(
        'the pairing link',
        () => /https:\/\/huli\.invalid\/pair#[A-Za-z0-9_-]+/.exec(output.get(adding)!)?.[0],
      )
      const payload = parsePairingLink(link)!
      expect(payload.relay?.urls).toEqual([BASE])

      // The device signs in to the same account, as a second client.
      const api = new AccountApi(DEVICE, fetch)
      const started = await api.startDevice({
        kind: 'daemon',
        name: 'Phone',
        os: 'test',
        arch: 'x',
        version: null,
      })
      await approve(started.userCode)
      await new Promise((resolve) => setTimeout(resolve, started.interval * 1000 + 200))
      const tokens = await api.pollDevice(started.deviceCode)
      const relayToken = (await api.relayToken(tokens.accessToken)).token

      const viaRelay = async () => {
        const result = await dialRelay({
          relays: [DEVICE],
          id: payload.relay!.id,
          token: relayToken,
          openSocket: (url) => new WebSocket(url),
          timeoutMs: 10_000,
        })
        if (result.kind !== 'joined') throw new Error(`relay: ${JSON.stringify(result)}`)
        return webSocketTransport(result.socket, true)
      }
      const key = await generateKeyPair()
      const client = { kind: 'web', version: '0.1.0', platform: 'test' }
      const pairing = pair(
        { dial: viaRelay, payload, key, client, device: { name: 'E2E', model: 'Node' } },
        (state) => {
          if (state.state !== 'waiting') return
          void waitFor('the confirm', () => output.get(adding)!.includes('[y/N]')).then(() => {
            adding.stdin!.write('y\n')
            return waitFor('the name', () => output.get(adding)!.includes('Name:')).then(() =>
              adding.stdin!.write('\n'),
            )
          })
        },
      )
      const paired = await pairing
      expect(paired?.welcome.relay?.id).toBe(payload.relay!.id)

      const hostLink = new HostLink({
        dial: viaRelay,
        routes: () => [{ key: 'relay', relay: true, dial: viaRelay }],
        hostKey: payload.hostKey,
        key,
        hello: hello(client),
        adopt: paired!,
      })
      hostLink.start()
      await waitFor('the link', () => hostLink.state.kind === 'connected')
      const sessions = await hostLink.request('sessions.list', {})
      expect(Array.isArray(sessions)).toBe(true)
      hostLink.stop()
      expect(output.get(cloud)).not.toMatch(/hr1\.|failed:/)
      daemon.kill()
    } finally {
      for (const child of procs) child.kill()
      if (process.platform === 'win32') {
        spawnSync('wsl', ['-e', 'pkill', '-f', 'huli-cloud.mjs serve'])
        spawnSync('wsl', ['-e', 'pkill', '-f', 'out/daemon/'])
      }
      if (process.env.E2E_VERBOSE) console.log(output.get(cloud))
    }
  })
})
