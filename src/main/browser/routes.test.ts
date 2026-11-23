import { describe, expect, it } from 'vitest'
import { routeArgs, type RouteRuleSpec } from '@shared/browser-args'
import { answerFor, mockedLabel, RouteBook } from './routes'

function spec(args: Record<string, unknown>): RouteRuleSpec {
  const call = routeArgs({ action: 'add', ...args })
  if (call.action !== 'add') throw new Error('not an add')
  return call.rule
}

const get = (url: string, headers: Record<string, string> = {}) => ({
  url,
  method: 'GET',
  headers,
  resourceType: 'Fetch',
})

describe('the answers rules give paused requests', () => {
  it('answers with the first rule that matches, in the order added', () => {
    const book = new RouteBook()
    book.add('s1', spec({ url: '/api/', status: 500 }))
    book.add('s1', spec({ url: '/api/users', status: 200 }))
    const answer = answerFor(book.rules('s1'), get('http://localhost:3000/api/users'))
    expect(answer).toMatchObject({ kind: 'fulfill', status: 500, rule: { id: 'r1' } })
    expect(answerFor(book.rules('s1'), get('http://localhost:3000/other'))).toEqual({
      kind: 'continue',
      rule: null,
    })
  })

  it('keeps one session’s rules from another’s pages', () => {
    const book = new RouteBook()
    book.add('s1', spec({ url: '/api/', abort: 'failed' }))
    expect(book.rules('s2')).toEqual([])
    expect(book.patterns('s2')).toEqual([])
  })

  it('lets a cross-origin page read a mocked answer, unless the rule says otherwise', () => {
    const book = new RouteBook()
    book.add('s1', spec({ url: '/api/a', body: '{}' }))
    book.add(
      's1',
      spec({
        url: '/api/b',
        body: '{}',
        headers: { 'Access-Control-Allow-Origin': 'https://x.test' },
      }),
    )
    const a = answerFor(
      book.rules('s1'),
      get('http://api.test/api/a', { Origin: 'http://localhost:3000' }),
    )
    expect(a.kind === 'fulfill' && a.headers).toContainEqual({
      name: 'Access-Control-Allow-Origin',
      value: 'http://localhost:3000',
    })
    const b = answerFor(
      book.rules('s1'),
      get('http://api.test/api/b', { origin: 'http://localhost:3000' }),
    )
    expect(b.kind === 'fulfill' && b.headers.filter((h) => /allow-origin/i.test(h.name))).toEqual([
      { name: 'Access-Control-Allow-Origin', value: 'https://x.test' },
    ])
  })

  it('answers the preflight of a request a rule mocks', () => {
    const book = new RouteBook()
    book.add('s1', spec({ url: '/api/a', method: 'PUT', body: '{}' }))
    const answer = answerFor(book.rules('s1'), {
      url: 'http://api.test/api/a',
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'PUT' },
      resourceType: 'Preflight',
    })
    expect(answer).toMatchObject({ kind: 'fulfill', status: 204 })
  })

  it('fails and delays as the rule says, and labels what it did', () => {
    const book = new RouteBook()
    const abort = book.add('s1', spec({ url: '/a', abort: 'connection_refused' }))
    const slow = book.add('s1', spec({ url: '/slow', delay_ms: 500 }))
    const failed = answerFor([abort], get('http://t/a'))
    expect(failed).toEqual({ kind: 'fail', rule: abort, reason: 'ConnectionRefused' })
    expect(mockedLabel(failed)).toBe('failed by r1')
    const delayed = answerFor([slow], get('http://t/slow'))
    expect(delayed).toEqual({ kind: 'continue', rule: slow })
    expect(mockedLabel(delayed)).toBe('delayed 500 ms by r2')
  })

  it('drops a rule once it answered its count', () => {
    const book = new RouteBook()
    const rule = book.add('s1', spec({ url: '/once', status: 200, times: 1 }))
    expect(book.used('s1', rule)).toBe(true)
    expect(book.rules('s1')).toEqual([])
  })

  it('holds at most 50 rules a session', () => {
    const book = new RouteBook()
    for (let n = 0; n < 50; n++) book.add('s1', spec({ url: `/r${n}`, status: 200 }))
    expect(() => book.add('s1', spec({ url: '/more', status: 200 }))).toThrow()
    expect(book.clear('s1')).toBe(50)
  })
})
