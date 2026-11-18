// A device's link uploading a file as it reads it, against a remote host and an in-process agent
// host: the file goes a part at a time, the host can stop it, its caller can give it up, and a
// dropped connection starts it over, once.

import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hello, HostLink } from '@shared/remote/link'
import { generateKeyPair } from '@shared/remote/noise'
import type { Transport } from '@shared/remote/transport'
import { UploadSource } from '@shared/remote/upload-source'
import { startTestHost, type TestHost } from '../agent-host/testing/harness'
import { ActivityLog } from './activity'
import { DeviceStore } from './devices'
import { DiscoveryRequests } from './discovery'
import { PairingCodes } from './pairing'
import { RemoteServer, type RemoteServerOptions } from './server'
import { memoryPorts, memoryTransports } from './testing/memory'

const cleanups: (() => Promise<void> | void)[] = []
let agent: TestHost | null = null

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await agent?.stop()
  agent = null
})

async function setup(options: Pick<RemoteServerOptions, 'uploadFreeSpace'> = {}) {
  agent = await startTestHost()
  const log = () => {}
  const uploads = path.join(agent.dir, 'remote', 'uploads')
  await mkdir(uploads, { recursive: true })
  const devices = await DeviceStore.load(agent.dir, log)
  const hostKey = await generateKeyPair()
  const phoneKey = await generateKeyPair()
  await devices.add({
    publicKey: Buffer.from(phoneKey.publicKey).toString('base64'),
    name: 'Phone',
    kind: 'ios',
    platform: 'ios',
    model: 'iPhone 17 Pro',
  })
  const host = agent.host
  const server = new RemoteServer({
    staticKey: hostKey,
    devices,
    activity: await ActivityLog.load(agent.dir, log),
    pairing: new PairingCodes({ hostKey: hostKey.publicKey, addresses: () => [], send: () => {} }),
    discovery: new DiscoveryRequests({ send: () => {} }),
    host: { name: 'Studio', platform: process.platform, version: '0.0.0-test' },
    uploads,
    openAgentPort: async (device) => {
      const [remoteEnd, agentEnd] = memoryPorts()
      host.connect(agentEnd as Parameters<typeof host.connect>[0], device)
      return remoteEnd
    },
    changed: () => {},
    log,
    ...options,
  })
  cleanups.push(() => server.stop('stopping'))
  /** The device's side of each connection the link opened. */
  const transports: Transport[] = []
  const link = new HostLink({
    dial: async () => {
      const [deviceEnd, hostEnd] = memoryTransports()
      server.accept(hostEnd)
      transports.push(deviceEnd)
      return deviceEnd
    },
    hostKey: hostKey.publicKey,
    key: phoneKey,
    hello: hello({ kind: 'ios', version: '1.0.0', platform: 'iOS 26' }),
    retryDelay: () => 0,
  })
  cleanups.push(() => link.stop())
  link.start()
  await expect.poll(() => link.state.kind).toBe('connected')
  return { link, uploads, transports }
}

/** A file of `size` bytes read as a phone reads one, whose reads can be held. */
function file(size: number) {
  const reads: number[] = []
  const sent: number[] = []
  let hold: Promise<void> | null = null
  let release = () => {}
  const source = new UploadSource(
    size,
    () => {
      let at = 0
      return {
        read: async (length) => {
          if (hold) await hold
          reads.push(at)
          const part = new Uint8Array(Math.min(length, size - at)).fill(at % 251)
          at += part.length
          return part
        },
        close: () => {},
      }
    },
    (bytes) => sent.push(bytes),
  )
  return {
    source,
    reads,
    sent,
    /** The next read waits until `go` is called. */
    hold: () => {
      hold = new Promise((resolve) => (release = resolve))
    },
    go: () => {
      hold = null
      release()
    },
  }
}

const add = (link: HostLink, source: UploadSource, signal?: AbortSignal) =>
  link.request(
    'attachments.add',
    { source: { bytes: source, mimeType: 'video/mp4', name: 'clip.mp4' }, thumb: null },
    signal,
  )

describe('a streamed file', () => {
  it('goes a part at a time and becomes an attachment', async () => {
    const { link, uploads } = await setup()
    const clip = file(700_000)
    const attachment = await add(link, clip.source)
    expect(attachment).toMatchObject({ type: 'file', name: 'clip.mp4', size: 700_000 })
    expect(clip.reads).toEqual([0, 262_144, 524_288])
    expect(clip.sent).toEqual([0, 262_144, 524_288, 700_000])
    expect(await readdir(uploads)).toEqual([])
  })

  it('stops as soon as the host gives it up, with the host reason', async () => {
    const { link, uploads } = await setup({ uploadFreeSpace: async () => 1024 })
    const clip = file(50 * 1024 * 1024)
    await expect(add(link, clip.source)).rejects.toMatchObject({
      code: 'unavailable',
      message: expect.stringContaining('free disk space'),
    })
    expect(clip.reads.length).toBeLessThan(20)
    expect(await readdir(uploads)).toEqual([])
  })

  it('stops when its caller gives it up, and the host deletes what came', async () => {
    const { link, uploads } = await setup()
    const clip = file(2_000_000)
    const controller = new AbortController()
    clip.hold()
    const request = add(link, clip.source, controller.signal)
    request.catch(() => {})
    await expect.poll(() => clip.sent).toEqual([0])
    // The host has the upload's file by now.
    await expect.poll(() => readdir(uploads)).toHaveLength(1)
    controller.abort()
    clip.go()
    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await expect.poll(() => readdir(uploads)).toEqual([])
    expect(clip.reads).toEqual([0])
    expect(clip.sent).toEqual([0])
  })

  it('starts over once after a drop, and fails after a second', async () => {
    const { link, transports } = await setup()
    const clip = file(1_000_000)
    clip.hold()
    const request = add(link, clip.source)
    request.catch(() => {})
    await expect.poll(() => clip.sent).toEqual([0])
    transports.at(-1)!.close()
    clip.go()
    await expect.poll(() => transports.length).toBe(2)
    await expect.poll(() => link.state.kind).toBe('connected')
    expect(await request).toMatchObject({ type: 'file', size: 1_000_000 })
    expect(clip.sent.filter((bytes) => bytes === 0)).toHaveLength(2)

    const again = file(1_000_000)
    again.hold()
    const second = add(link, again.source)
    second.catch(() => {})
    for (const drop of [3, 4]) {
      await expect.poll(() => again.sent.filter((bytes) => bytes === 0).length).toBe(drop - 2)
      transports.at(-1)!.close()
      // Held again at once: on a fast machine the start over sends the whole file before a poll
      // sees the new link, and the upload this test drops twice would finish.
      again.go()
      again.hold()
      await expect.poll(() => transports.length).toBe(drop)
    }
    again.go()
    await expect(second).rejects.toMatchObject({ code: 'host_restarted' })
  })
})
