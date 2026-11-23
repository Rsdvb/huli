import { describe, expect, it } from 'vitest'
import {
  bodyText,
  isSecretField,
  isStaticResource,
  MAX_BODY_CHARS,
  redactHeaders,
  REDACTED,
  requestTiming,
} from './network'

describe('request headers', () => {
  it('replace the values of credentials and keep the rest', () => {
    expect(
      redactHeaders({
        Authorization: 'Bearer eyJhbGciOi.secret.sig',
        'proxy-authorization': 'Basic dXNlcjpwYXNz',
        Cookie: 'sid=abc123; theme=dark',
        'X-Api-Key': 'k-123',
        'x-csrf-token': 'tok',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      }),
    ).toEqual({
      Authorization: `Bearer ${REDACTED}`,
      'proxy-authorization': `Basic ${REDACTED}`,
      Cookie: `sid=${REDACTED}; theme=${REDACTED}`,
      'X-Api-Key': REDACTED,
      'x-csrf-token': REDACTED,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    })
  })

  it('keep each cookie a response sets by name, with its attributes', () => {
    const headers = redactHeaders({
      'set-cookie': 'sid=abc123; Path=/; HttpOnly\nremember=yes; Max-Age=3600',
    })
    expect(headers['set-cookie']).toBe(
      `sid=${REDACTED}; Path=/; HttpOnly\nremember=${REDACTED}; Max-Age=3600`,
    )
    expect(JSON.stringify(headers)).not.toMatch(/abc123|yes;/)
  })

  it('replace a token without a scheme whole', () => {
    expect(redactHeaders({ authorization: 'abc123' })).toEqual({ authorization: REDACTED })
  })
})

describe('request bodies', () => {
  it('replace secret fields in JSON, however deep', () => {
    const body = JSON.stringify({
      user: { email: 'a@b.c', password: 'hunter2' },
      access_token: 'tok-1',
      items: [{ id: 1, apiKey: 'k' }],
      max_tokens: 100,
      shipping: 'fast',
    })
    const shown = bodyText(body, 'application/json; charset=utf-8')
    expect(JSON.parse(shown.text!)).toEqual({
      user: { email: 'a@b.c', password: REDACTED },
      access_token: REDACTED,
      items: [{ id: 1, apiKey: REDACTED }],
      max_tokens: 100,
      shipping: 'fast',
    })
  })

  it('replace secret fields of a form', () => {
    const shown = bodyText(
      'username=ann&password=hunter2&otp=123456&next=%2Fhome',
      'application/x-www-form-urlencoded',
    )
    const params = new URLSearchParams(shown.text!)
    expect(params.get('username')).toBe('ann')
    expect(params.get('password')).toBe(REDACTED)
    expect(params.get('otp')).toBe(REDACTED)
    expect(params.get('next')).toBe('/home')
  })

  it('name a form upload or a binary body without showing it', () => {
    expect(bodyText('--x\r\nfile', 'multipart/form-data; boundary=x')).toMatchObject({
      text: null,
      note: expect.stringMatching(/form upload/),
    })
    expect(bodyText('iVBORw0KGgo=', 'image/png', true)).toMatchObject({ text: null })
    expect(bodyText('PK\u0003\u0004', 'application/zip')).toMatchObject({ text: null })
  })

  it('show text as it is, cut at its length', () => {
    expect(bodyText('<p>Hi</p>', 'text/html')).toEqual({ text: '<p>Hi</p>' })
    const long = bodyText('x'.repeat(MAX_BODY_CHARS + 10), 'text/plain')
    expect(long.text).toHaveLength(MAX_BODY_CHARS)
    expect(long.note).toMatch(/Cut to/)
  })

  it('tell secret field names from others', () => {
    for (const name of ['password', 'newPassword', 'pwd', 'client_secret', 'refreshToken', 'sid'])
      expect(isSecretField(name)).toBe(true)
    for (const name of ['author', 'max_tokens', 'shipping', 'session', 'email', 'username'])
      expect(isSecretField(name)).toBe(false)
  })
})

describe('the request list', () => {
  it('leaves out static resources that loaded, not ones that failed', () => {
    expect(isStaticResource({ type: 'Image', status: 200, error: null })).toBe(true)
    expect(isStaticResource({ type: 'Script', status: 404, error: null })).toBe(false)
    expect(isStaticResource({ type: 'Font', status: null, error: 'net::ERR_FAILED' })).toBe(false)
    expect(isStaticResource({ type: 'Fetch', status: 200, error: null })).toBe(false)
    expect(isStaticResource({ type: 'Document', status: 200, error: null })).toBe(false)
  })
})

describe('request timing', () => {
  it('splits a request into its phases', () => {
    expect(
      requestTiming({
        sent: 100,
        ended: 100.25,
        wallTime: 1_700_000_000,
        timing: {
          requestTime: 100.01,
          dnsStart: 0,
          dnsEnd: 5,
          connectStart: 5,
          connectEnd: 20,
          sslStart: 10,
          sslEnd: 20,
          sendStart: 21,
          sendEnd: 22,
          receiveHeadersEnd: 140,
        },
      }),
    ).toEqual({
      started_at: '2023-11-14T22:13:20.000Z',
      total_ms: 250,
      dns_ms: 5,
      connect_ms: 15,
      tls_ms: 10,
      wait_ms: 118,
      download_ms: 100,
    })
  })

  it('leaves out what a cached or unfinished request has not', () => {
    expect(
      requestTiming({
        sent: 5,
        ended: null,
        wallTime: null,
        timing: { dnsStart: -1, dnsEnd: -1 },
      }),
    ).toEqual({
      started_at: null,
      total_ms: null,
      dns_ms: null,
      connect_ms: null,
      tls_ms: null,
      wait_ms: null,
      download_ms: null,
    })
  })
})
