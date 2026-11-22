import { describe, expect, it } from 'vitest'
import { isOtherHostMethod } from './host-sessions'
import {
  ForwardBook,
  MAX_HOST_FORWARDS,
  devPorts,
  forwardedAddress,
  loopbackPort,
  parsePortFolders,
  parsePortList,
  type PortForward,
} from './port-forwards'

const forward = (more: Partial<PortForward> = {}): PortForward => ({
  hostId: 'a'.repeat(32),
  sessionId: null,
  port: 5173,
  localPort: 5173,
  process: 'node',
  auto: false,
  at: 1,
  ...more,
})

describe('parsePortList', () => {
  it('keeps the ports the host named, once each', () => {
    expect(
      parsePortList({
        ports: [
          { port: 5173, address: '127.0.0.1', pid: 42, process: 'node', folder: '/home/u/app' },
          { port: 5173, address: '::1', pid: 42, process: 'node', folder: null },
          { port: 3000, address: '0.0.0.0', pid: -1, process: '', folder: 7 },
          { port: 70_000, address: '::', pid: 1, process: 'x', folder: null },
          { port: 8080, address: 9 },
          'junk',
        ],
      }),
    ).toEqual({
      ports: [
        { port: 5173, address: '127.0.0.1', pid: 42, process: 'node', folder: '/home/u/app' },
        { port: 3000, address: '0.0.0.0', pid: null, process: null, folder: null },
      ],
    })
  })

  it('reads a host that cannot list, and refuses what is no answer', () => {
    expect(parsePortList({ ports: null })).toEqual({ ports: null })
    expect(parsePortList({ ports: 'x' })).toBeNull()
    expect(parsePortList(null)).toBeNull()
  })
})

describe('parsePortFolders', () => {
  it('takes folders, once each', () => {
    expect(parsePortFolders(['/a', '/b', '/a'])).toEqual(['/a', '/b'])
    expect(parsePortFolders([])).toEqual([])
  })

  it('refuses what is not a list of folders', () => {
    expect(parsePortFolders('/a')).toBeNull()
    expect(parsePortFolders([''])).toBeNull()
    expect(parsePortFolders(['/a\0b'])).toBeNull()
    expect(parsePortFolders([3])).toBeNull()
    expect(parsePortFolders(Array.from({ length: 201 }, (_, i) => `/f${i}`))).toBeNull()
  })
})

describe('devPorts', () => {
  it('puts the folders’ programs first and leaves the system’s ports out', () => {
    const ports = devPorts([
      { port: 9000, address: '127.0.0.1', pid: 1, process: 'a', folder: null },
      { port: 22, address: '0.0.0.0', pid: 2, process: 'sshd', folder: null },
      { port: 5173, address: '127.0.0.1', pid: 3, process: 'node', folder: '/p' },
      { port: 3000, address: '127.0.0.1', pid: 4, process: 'b', folder: null },
    ])
    expect(ports.map((p) => p.port)).toEqual([5173, 3000, 9000])
  })
})

describe('loopback addresses', () => {
  it('reads the port of a dev server’s address', () => {
    expect(loopbackPort('http://localhost:5173/')).toBe(5173)
    expect(loopbackPort('https://127.0.0.1:8443/x')).toBe(8443)
    expect(loopbackPort('http://0.0.0.0:3000')).toBe(3000)
    expect(loopbackPort('http://[::1]:4000/')).toBe(4000)
    expect(loopbackPort('http://localhost/')).toBeNull()
    expect(loopbackPort('http://example.com:3000/')).toBeNull()
    expect(loopbackPort('ftp://localhost:21/')).toBeNull()
    expect(loopbackPort('not a url')).toBeNull()
  })

  it('moves an address to its forward', () => {
    expect(forwardedAddress('http://0.0.0.0:3000/app?x=1#y', 61_000)).toBe(
      'http://localhost:61000/app?x=1#y',
    )
    expect(forwardedAddress('http://[::1]:4000/', 4000)).toBe('http://localhost:4000/')
    expect(forwardedAddress('http://example.com:3000/', 1)).toBeNull()
  })
})

describe('ForwardBook', () => {
  it('keeps one forward a host, session and port', () => {
    const book = new ForwardBook()
    book.add(forward())
    book.add(forward({ localPort: 6000 }))
    book.add(forward({ sessionId: 's1', at: 2 }))
    expect(book.list().map((f) => [f.sessionId, f.localPort])).toEqual([
      [null, 6000],
      ['s1', 5173],
    ])
    expect(book.get('a'.repeat(32), 's1', 5173)?.at).toBe(2)
    expect(book.anyFor('a'.repeat(32), 5173)?.sessionId).toBeNull()
    expect(book.remove('a'.repeat(32), null, 5173)?.localPort).toBe(6000)
    expect(book.anyFor('a'.repeat(32), 5173)?.sessionId).toBe('s1')
    expect(book.remove('a'.repeat(32), null, 5173)).toBeNull()
  })

  it('drops a host’s forwards with its session, and a session’s with it', () => {
    const book = new ForwardBook()
    const other = 'b'.repeat(32)
    book.add(forward({ sessionId: 's1' }))
    book.add(forward({ sessionId: 's2', port: 3000 }))
    book.add(forward({ hostId: other, sessionId: 's1' }))
    book.add(forward({ hostId: other }))
    expect(book.removeSession('s1', other).map((f) => f.hostId)).toEqual([other])
    expect(book.keepSessions(new Set(['s2'])).map((f) => f.sessionId)).toEqual(['s1'])
    expect(book.removeHost('a'.repeat(32)).map((f) => f.port)).toEqual([3000])
    expect(book.list()).toEqual([forward({ hostId: other })])
  })

  it('has room for as many forwards to a host as it keeps', () => {
    const book = new ForwardBook()
    for (let i = 0; i < MAX_HOST_FORWARDS; i++) book.add(forward({ port: 2000 + i }))
    expect(book.hasRoom('a'.repeat(32))).toBe(false)
    expect(book.hasRoom('b'.repeat(32))).toBe(true)
  })
})

describe('the host calls a window may not make', () => {
  it('leaves listing and forwarding ports to main', () => {
    for (const method of ['ports.list', 'ports.forward', 'ports.unforward']) {
      expect(isOtherHostMethod(method), method).toBe(false)
    }
  })
})
