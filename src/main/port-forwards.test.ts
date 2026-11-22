import { describe, expect, it } from 'vitest'
import type { PortForward } from '@shared/port-forwards'
import { PortForwards, folderArgs, forwardArgs, type PortForwardsDeps } from './port-forwards'

const HOST = 'a'.repeat(32)

function setup(overrides: Partial<PortForwardsDeps> = {}) {
  const calls: { method: string; params: unknown }[] = []
  const requests: { method: string; params: unknown }[] = []
  const listening: string[] = []
  const stopped: string[] = []
  const changes: PortForward[][] = []
  const forwards = new PortForwards({
    call: async (_hostId, method, params) => {
      calls.push({ method, params })
      if (method === 'ports.list') {
        return {
          ports: [
            { port: 22, address: '0.0.0.0', pid: 1, process: 'sshd', folder: null },
            { port: 8080, address: '127.0.0.1', pid: 2, process: 'java', folder: null },
            { port: 5173, address: '127.0.0.1', pid: 3, process: 'node', folder: '/w/app' },
          ],
        }
      }
      return null
    },
    request: (_hostId, method, params) => {
      requests.push({ method, params })
      return true
    },
    listen: async (_hostId, scope, port) => {
      listening.push(`${scope}:${port}`)
      return port
    },
    stopListening: (_hostId, scope, port) => stopped.push(`${scope}:${port}`),
    changed: (list) => changes.push(list),
    now: () => 7,
    ...overrides,
  })
  return { forwards, calls, requests, listening, stopped, changes }
}

describe('forwardArgs and folderArgs', () => {
  it('take a host, a port and a session or none', () => {
    expect(forwardArgs(HOST, 5173, null)).toEqual({ hostId: HOST, port: 5173, sessionId: null })
    expect(forwardArgs(HOST, 1, 's1')).toEqual({ hostId: HOST, port: 1, sessionId: 's1' })
  })

  it('refuse what is not one', () => {
    expect(() => forwardArgs('host', 5173, null)).toThrow()
    expect(() => forwardArgs(HOST, 0, null)).toThrow()
    expect(() => forwardArgs(HOST, 65_536, null)).toThrow()
    expect(() => forwardArgs(HOST, 80.5, null)).toThrow()
    expect(() => forwardArgs(HOST, '80', null)).toThrow()
    expect(() => forwardArgs(HOST, 80, '')).toThrow()
    expect(() => forwardArgs(HOST, 80, 'a\0b')).toThrow()
    expect(() => forwardArgs(HOST, 80, 'x'.repeat(257))).toThrow()
    expect(() => forwardArgs(HOST, 80, 3)).toThrow()
    expect(folderArgs(['/w/app'])).toEqual(['/w/app'])
    expect(() => folderArgs('/w/app')).toThrow()
    expect(() => folderArgs([''])).toThrow()
  })
})

describe('PortForwards', () => {
  it('lists the host’s dev ports, the folders’ programs first', async () => {
    const t = setup()
    const result = await t.forwards.ports(HOST, ['/w/app'])
    expect(t.calls).toEqual([{ method: 'ports.list', params: { folders: ['/w/app'] } }])
    expect(result).toEqual({
      ok: true,
      ports: [
        { port: 5173, address: '127.0.0.1', pid: 3, process: 'node', folder: '/w/app' },
        { port: 8080, address: '127.0.0.1', pid: 2, process: 'java', folder: null },
      ],
    })
  })

  it('says why a host could not list', async () => {
    const offline = setup({ call: () => Promise.reject({ code: 'host_offline' }) })
    expect(await offline.forwards.ports(HOST, [])).toEqual({ ok: false, reason: 'offline' })
    const old = setup({ call: () => Promise.reject({ code: 'unknown_method' }) })
    expect(await old.forwards.ports(HOST, [])).toEqual({ ok: false, reason: 'unsupported' })
    const none = setup({ call: async () => ({ ports: null }) })
    expect(await none.forwards.ports(HOST, [])).toEqual({ ok: false, reason: 'failed' })
    const junk = setup({ call: async () => 'junk' })
    expect(await junk.forwards.ports(HOST, [])).toEqual({ ok: false, reason: 'failed' })
  })

  it('grants the port on the host, then listens, once for every ask', async () => {
    const t = setup()
    const [first, second] = await Promise.all([
      t.forwards.forward(HOST, 5173, 's1', false),
      t.forwards.forward(HOST, 5173, 's1', false),
    ])
    expect(first).toEqual(second)
    expect(first).toEqual({
      ok: true,
      forward: {
        hostId: HOST,
        sessionId: 's1',
        port: 5173,
        localPort: 5173,
        process: null,
        auto: false,
        at: 7,
      },
    })
    expect(t.calls).toEqual([{ method: 'ports.forward', params: { scope: 's1', port: 5173 } }])
    expect(t.listening).toEqual(['s1:5173'])
    // Another session, or the host's page, takes the same listener.
    expect(await t.forwards.forward(HOST, 5173, null, false)).toEqual(first)
    expect(t.listening).toEqual(['s1:5173'])
    expect(t.changes).toHaveLength(1)
  })

  it('takes the grant back when nothing could listen', async () => {
    const t = setup({ listen: async () => null })
    expect(await t.forwards.forward(HOST, 3000, null, true)).toEqual({
      ok: false,
      reason: 'failed',
    })
    expect(t.requests).toEqual([{ method: 'ports.unforward', params: { scope: '', port: 3000 } }])
    expect(t.forwards.list()).toEqual([])
  })

  it('says why the host refused a forward', async () => {
    const old = setup({ call: () => Promise.reject({ code: 'unknown_method' }) })
    expect(await old.forwards.forward(HOST, 3000, null, false)).toEqual({
      ok: false,
      reason: 'unsupported',
    })
    const busy = setup({ call: () => Promise.reject({ code: 'busy' }) })
    expect(await busy.forwards.forward(HOST, 3000, null, false)).toEqual({
      ok: false,
      reason: 'full',
    })
  })

  it('stops a forward on both sides, and drops a gone host’s or session’s', async () => {
    const t = setup()
    await t.forwards.forward(HOST, 3000, null, false)
    await t.forwards.forward(HOST, 4000, 's1', true)
    await t.forwards.forward(HOST, 5000, 's2', true)
    t.forwards.stop(HOST, 3000, null)
    expect(t.stopped).toEqual([':3000'])
    expect(t.requests.at(-1)).toEqual({
      method: 'ports.unforward',
      params: { scope: '', port: 3000 },
    })
    t.forwards.keepSessions(['s2'])
    expect(t.stopped).toEqual([':3000', 's1:4000'])
    // The page went with its listeners: only the host's grant is left to take back.
    t.forwards.sessionClosed(HOST, 's2')
    expect(t.stopped).toEqual([':3000', 's1:4000'])
    expect(t.requests.at(-1)).toEqual({
      method: 'ports.unforward',
      params: { scope: 's2', port: 5000 },
    })
    expect(t.forwards.list()).toEqual([])
    await t.forwards.forward(HOST, 6000, null, false)
    t.forwards.hostEnded(HOST)
    expect(t.forwards.list()).toEqual([])
    expect(t.changes.at(-1)).toEqual([])
  })
})
