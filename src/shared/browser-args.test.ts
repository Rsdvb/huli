import { describe, expect, it } from 'vitest'
import {
  BrowserArgsInvalid,
  changedEmulation,
  clickAtArgs,
  dragArgs,
  emulateArgs,
  NO_EMULATION,
  routeArgs,
  routeMatches,
  routePattern,
  storageStateArgs,
  traceArgs,
  type RouteRuleSpec,
} from './browser-args'

const refuses = (run: () => unknown): void => {
  expect(run).toThrow(BrowserArgsInvalid)
}

describe('browser_emulate arguments', () => {
  it('takes a device by name, and the other items', () => {
    const change = emulateArgs({
      device: 'iPhone 15',
      color_scheme: 'dark',
      reduced_motion: 'reduce',
      locale: 'zh-CN',
      timezone: 'Asia/Shanghai',
      geolocation: { latitude: 31.2, longitude: 121.5 },
      network: 'offline',
    })
    expect(change.set.device).toMatchObject({
      label: 'iPhone 15',
      width: 393,
      height: 852,
      touch: true,
    })
    expect(change.set.network).toMatchObject({ preset: 'offline', offline: true })
    expect(change.set.geolocation).toEqual({ latitude: 31.2, longitude: 121.5, accuracy: 50 })
    expect(change.off).toEqual([])
  })

  it('turns items off, or all of them', () => {
    expect(emulateArgs({ off: ['network', 'locale'] }).off).toEqual(['network', 'locale'])
    expect(emulateArgs({ off: ['all'] }).off).toHaveLength(7)
    const before = changedEmulation(
      NO_EMULATION,
      emulateArgs({ color_scheme: 'dark', locale: 'fr' }),
    )
    expect(changedEmulation(before, emulateArgs({ off: ['locale'] }))).toMatchObject({
      colorScheme: 'dark',
      locale: null,
    })
  })

  it('refuses what does not fit', () => {
    refuses(() => emulateArgs({}))
    refuses(() => emulateArgs({ device: 'nokia-3310' }))
    refuses(() => emulateArgs({ device: 'pixel-8', viewport: { width: 400, height: 800 } }))
    refuses(() => emulateArgs({ viewport: { width: 50, height: 800 } }))
    refuses(() => emulateArgs({ viewport: { width: 400 } }))
    refuses(() => emulateArgs({ color_scheme: 'sepia' }))
    refuses(() => emulateArgs({ locale: 'en_US; DROP' }))
    refuses(() => emulateArgs({ timezone: '../../etc/passwd' }))
    refuses(() => emulateArgs({ geolocation: { latitude: 91, longitude: 0 } }))
    refuses(() => emulateArgs({ network: { download_kbps: 100 } }))
    refuses(() => emulateArgs({ network: '5g' }))
    refuses(() => emulateArgs({ off: ['locale'], locale: 'fr' }))
    refuses(() => emulateArgs({ off: ['everything'] }))
    refuses(() => emulateArgs({ zoom: 2 }))
  })
})

describe('browser_route arguments', () => {
  it('reads a fixed response, an abort and a delay', () => {
    const fulfill = routeArgs({
      action: 'add',
      url: '/api/users',
      method: 'post',
      status: 201,
      headers: { 'X-Test': '1' },
      body: '{"ok":true}',
      content_type: 'application/json',
      times: 2,
    })
    expect(fulfill).toEqual({
      action: 'add',
      rule: {
        pattern: '/api/users',
        method: 'POST',
        response: {
          kind: 'fulfill',
          status: 201,
          headers: [
            ['X-Test', '1'],
            ['Content-Type', 'application/json'],
          ],
          body: '{"ok":true}',
        },
        delayMs: 0,
        times: 2,
      },
    })
    expect(routeArgs({ action: 'add', url: '*.png', abort: 'blocked' })).toMatchObject({
      rule: { response: { kind: 'abort', reason: 'blocked' } },
    })
    expect(routeArgs({ action: 'add', url: '/slow', delay_ms: 2000 })).toMatchObject({
      rule: { response: { kind: 'continue' }, delayMs: 2000 },
    })
    expect(routeArgs({ action: 'remove', id: 'r3' })).toEqual({ action: 'remove', id: 'r3' })
    expect(routeArgs({ action: 'clear' })).toEqual({ action: 'clear' })
  })

  it('refuses a rule that does nothing, or does two things', () => {
    refuses(() => routeArgs({ action: 'add', url: '/x' }))
    refuses(() => routeArgs({ action: 'add', url: '/x', abort: 'failed', status: 500 }))
    refuses(() => routeArgs({ action: 'add', url: ' /x', status: 200 }))
    refuses(() => routeArgs({ action: 'add', url: '/x y', status: 200 }))
    refuses(() => routeArgs({ action: 'add', url: '/x', status: 99 }))
    refuses(() => routeArgs({ action: 'add', url: '/x', delay_ms: 60_000 }))
    refuses(() => routeArgs({ action: 'add', url: '/x', abort: 'exploded' }))
    refuses(() => routeArgs({ action: 'remove', id: 'all' }))
    refuses(() => routeArgs({ action: 'list', url: '/x' }))
    refuses(() => routeArgs({ action: 'mock' }))
  })

  it('refuses headers that could split a response', () => {
    refuses(() =>
      routeArgs({ action: 'add', url: '/x', headers: { 'X-A': 'one\r\nSet-Cookie: a=b' } }),
    )
    refuses(() => routeArgs({ action: 'add', url: '/x', headers: { 'Bad Name': 'v' } }))
    refuses(() => routeArgs({ action: 'add', url: '/x', content_type: 'text/html\nX: y' }))
    refuses(() => routeArgs({ action: 'add', url: '/x', body: 'x'.repeat(256 * 1024 + 1) }))
  })
})

describe('route rule matching', () => {
  const rule = (pattern: string, method: string | null = null): RouteRuleSpec => ({
    pattern,
    method,
    response: { kind: 'abort', reason: 'failed' },
    delayMs: 0,
    times: null,
  })

  it('matches text the address holds', () => {
    expect(routeMatches(rule('/api/users'), 'http://localhost:3000/api/users?page=2', 'GET')).toBe(
      true,
    )
    expect(routeMatches(rule('/api/users'), 'http://localhost:3000/api/user', 'GET')).toBe(false)
  })

  it('matches a whole address with * for any run, and nothing past its end', () => {
    const api = rule('http://localhost:3000/api/*')
    expect(routeMatches(api, 'http://localhost:3000/api/a/b?x=1', 'GET')).toBe(true)
    expect(routeMatches(api, 'http://localhost:3001/api/a', 'GET')).toBe(false)
    expect(routeMatches(rule('http://localhost:3000/'), 'http://localhost:3000/api', 'GET')).toBe(
      false,
    )
    expect(routeMatches(rule('*.png'), 'https://cdn.test/a/b.png', 'GET')).toBe(true)
    expect(routeMatches(rule('*.png'), 'https://cdn.test/a/b.png?v=1', 'GET')).toBe(false)
  })

  it('takes regex characters as they are written', () => {
    const literal = rule('http://a.test/q?x=(1)+[2]')
    expect(routeMatches(literal, 'http://a.test/q?x=(1)+[2]', 'GET')).toBe(true)
    expect(routeMatches(literal, 'http://aXtest/q?x=(1)+[2]', 'GET')).toBe(false)
    expect(routeMatches(rule('/a.b'), 'http://t/aXb', 'GET')).toBe(false)
  })

  it('matches the method when the rule names one', () => {
    expect(routeMatches(rule('/x', 'POST'), 'http://t/x', 'post')).toBe(true)
    expect(routeMatches(rule('/x', 'POST'), 'http://t/x', 'GET')).toBe(false)
  })

  it('gives the Fetch domain a pattern that pauses what the rule matches', () => {
    expect(routePattern('/api/users').fetch).toBe('*/api/users*')
    expect(routePattern('http://a.test/q?x=1').fetch).toBe('http://a.test/q\\?x=1')
    expect(routePattern('http://a.test/*').fetch).toBe('http://a.test/*')
  })
})

describe('the other tools’ arguments', () => {
  it('keeps a click at a point to numbers and a reason', () => {
    expect(clickAtArgs({ x: 10, y: 20, reason: 'Map pin' })).toEqual({
      x: 10,
      y: 20,
      reason: 'Map pin',
      button: 'left',
      double: false,
    })
    refuses(() => clickAtArgs({ x: 10, y: 20 }))
    refuses(() => clickAtArgs({ x: 10, y: 20, reason: '   ' }))
    refuses(() => clickAtArgs({ x: -1, y: 20, reason: 'r' }))
    refuses(() => clickAtArgs({ x: '10', y: 20, reason: 'r' }))
  })

  it('drags between two refs', () => {
    expect(dragArgs({ start_ref: 'e1', end_ref: 'e2' })).toEqual({ start_ref: 'e1', end_ref: 'e2' })
    refuses(() => dragArgs({ start_ref: 'e1', end_ref: 'e1' }))
    refuses(() => dragArgs({ start_ref: 'e1', end_ref: '#basket' }))
  })

  it('bounds a trace and names a saved state', () => {
    expect(traceArgs({})).toEqual({ seconds: 3, reload: false })
    refuses(() => traceArgs({ seconds: 60 }))
    expect(storageStateArgs({ action: 'save', name: 'admin' })).toEqual({
      action: 'save',
      name: 'admin',
    })
    refuses(() => storageStateArgs({ action: 'restore' }))
    refuses(() => storageStateArgs({ action: 'save', name: 'a\nb' }))
    refuses(() => storageStateArgs({ action: 'delete', name: 'admin' }))
  })
})
