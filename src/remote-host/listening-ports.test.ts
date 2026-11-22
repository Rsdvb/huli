import { describe, expect, it } from 'vitest'
import {
  isInside,
  parseLsof,
  parseNetstat,
  parseProcNetTcp,
  parseTasklist,
} from './listening-ports'

describe('parseProcNetTcp', () => {
  it('reads the listening sockets of /proc/net/tcp and tcp6', () => {
    const tcp = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41872 1 0000000000000000 100 0 0 10 0',
      '   1: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41873 1 0000000000000000 100 0 0 10 0',
      '   2: 0100007F:1435 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 41874 1 0000000000000000 20 4 30 10 -1',
      '   3: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1234 1 0000000000000000 100 0 0 10 0',
    ].join('\n')
    expect(parseProcNetTcp(tcp)).toEqual([
      { address: '127.0.0.1', port: 5173, uid: 1000, inode: 41872 },
      { address: '0.0.0.0', port: 3000, uid: 1000, inode: 41873 },
      { address: '0.0.0.0', port: 22, uid: 0, inode: 1234 },
    ])
    const tcp6 = [
      '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5555 1 0000000000000000 100 0 0 10 0',
      '   1: 00000000000000000000000000000000:0FA0 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5556 1 0000000000000000 100 0 0 10 0',
    ].join('\n')
    expect(parseProcNetTcp(tcp6)).toEqual([
      { address: '::1', port: 8080, uid: 1000, inode: 5555 },
      { address: '::', port: 4000, uid: 1000, inode: 5556 },
    ])
  })

  it('skips what is no socket line', () => {
    expect(parseProcNetTcp('')).toEqual([])
    expect(parseProcNetTcp('header\n garbage line here\n')).toEqual([])
  })
})

describe('parseLsof', () => {
  it('reads each process’s listening sockets', () => {
    const output = [
      'p501',
      'cnode',
      'f23',
      'n127.0.0.1:5173',
      'f24',
      'n[::1]:5173',
      'p777',
      'cpython3.12',
      'f3',
      'n*:8000',
      '',
    ].join('\n')
    expect(parseLsof(output)).toEqual([
      { address: '127.0.0.1', port: 5173, pid: 501, process: 'node' },
      { address: '::1', port: 5173, pid: 501, process: 'node' },
      { address: '0.0.0.0', port: 8000, pid: 777, process: 'python3.12' },
    ])
  })
})

describe('parseNetstat and parseTasklist', () => {
  it('reads the listening sockets and their programs on Windows', () => {
    const netstat = [
      'Active Connections',
      '',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1100',
      '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4242',
      '  TCP    127.0.0.1:5173         127.0.0.1:50000        ESTABLISHED     4242',
      '  TCP    [::1]:3000             [::]:0                 LISTENING       99',
    ].join('\r\n')
    expect(parseNetstat(netstat)).toEqual([
      { address: '0.0.0.0', port: 135, pid: 1100, process: null },
      { address: '127.0.0.1', port: 5173, pid: 4242, process: null },
      { address: '::1', port: 3000, pid: 99, process: null },
    ])
    const tasks =
      '"node.exe","4242","Console","1","80,000 K"\r\n"System","4","Services","0","100 K"\r\n'
    expect(parseTasklist(tasks)).toEqual(
      new Map([
        [4242, 'node'],
        [4, 'System'],
      ]),
    )
  })
})

describe('isInside', () => {
  it('tells a folder inside another from a neighbor that starts the same', () => {
    expect(isInside('/home/u/app', '/home/u/app', 'linux')).toBe(true)
    expect(isInside('/home/u/app/web', '/home/u/app', 'linux')).toBe(true)
    expect(isInside('/home/u/app2', '/home/u/app', 'linux')).toBe(false)
    expect(isInside('/home/u', '/home/u/app', 'linux')).toBe(false)
    expect(isInside('/home/U/App/web', '/home/u/app', 'darwin')).toBe(true)
    expect(isInside('/home/U/App/web', '/home/u/app', 'linux')).toBe(false)
  })
})
