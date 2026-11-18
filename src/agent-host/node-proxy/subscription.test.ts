import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createTcpServer, connect, type AddressInfo, type Socket } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { parseUserinfo, readSubscription, subscriptionTextProblem } from './content'
import {
  downloadSubscription,
  parseDownloadHop,
  routeFor,
  SUBSCRIPTION_USER_AGENT,
  type DownloadHop,
} from './download'

const TOKEN = '8f2c1d9a7b6e5f4a3c2b1d0e9f8a7b6c'
const YAML = `proxies:
  - { name: 'JP 01', type: ss, server: 192.0.2.1, port: 8388, cipher: aes-128-gcm, password: x }
  - name: US 01
    type: trojan
    server: 192.0.2.2
    port: 443
    password: y
proxy-groups: []
`
const LINKS = [
  'ss://YWVzLTEyOC1nY206eA@192.0.2.1:8388#JP%2001',
  'trojan://y@192.0.2.2:443#US%2001',
  'vmess://eyJhZGQiOiIxOTIuMC4yLjMifQ',
].join('\n')

describe('subscription-userinfo', () => {
  it('reads traffic and expiry as mihomo does', () => {
    expect(
      parseUserinfo('upload=1024; download=2048; total=1073741824; expire=1767225600'),
    ).toEqual({ upload: 1024, download: 2048, total: 1073741824, expire: 1767225600000 })
    // Spaces, case, decimals, field order and unknown fields do not matter.
    expect(parseUserinfo('Total = 300.7 ;UPLOAD=1;Download=2.0;foo=bar;expire=')).toEqual({
      upload: 1,
      download: 2,
      total: 300,
      expire: null,
    })
    expect(parseUserinfo('upload=0;download=0;total=10;expire=0')).toMatchObject({ expire: null })
  })

  it('gives nothing without upload, download and total, or for values that are no numbers', () => {
    for (const header of [
      null,
      undefined,
      '',
      'upload=1;download=2',
      'upload=-1;download=2;total=3',
      'upload=1;download=x;total=3',
      'upload=1e400;download=2;total=3',
      'garbage',
    ]) {
      expect(parseUserinfo(header)).toBeNull()
    }
  })
})

describe('a subscription’s content', () => {
  it('keeps Clash YAML as it came and counts its nodes', () => {
    expect(readSubscription(YAML)).toEqual({ format: 'yaml', nodes: 2, data: YAML })
    expect(readSubscription(`\uFEFF${YAML.replace(/\n/g, '\r\n')}`)).toMatchObject({
      format: 'yaml',
      nodes: 2,
    })
  })

  it('writes node links as the standard base64 mihomo decodes, however they came', () => {
    const plain = Buffer.from(LINKS).toString('base64')
    const urlSafe = Buffer.from(`${LINKS}\n`)
      .toString('base64url')
      .replace(/(.{20})/g, '$1\r\n')
    for (const text of [LINKS, plain, `${plain}\n`, urlSafe, `\n${LINKS}\n\n`]) {
      const read = readSubscription(text)
      expect(read.format).toBe('links')
      expect(read.nodes).toBe(3)
      expect(read.data).toMatch(/^[A-Za-z0-9+/]+=*\n$/)
      expect(Buffer.from(read.data, 'base64').toString('utf8')).toBe(LINKS)
    }
  })

  it('refuses content without a node, so it never replaces nodes that work', () => {
    for (const text of [
      '',
      '<html><body><a href="https://example.com">Blocked</a></body></html>',
      'proxies: []\n',
      'proxies:\n  - just a string\n',
      'rules:\n  - MATCH,DIRECT\n',
      Buffer.from('hello world').toString('base64'),
      'ftp://example.com/x\nfile:///etc/passwd',
    ]) {
      expect(() => readSubscription(text)).toThrow(/no nodes/)
    }
  })

  it('takes only text of at most 10 MiB to import', () => {
    expect(subscriptionTextProblem(YAML)).toBeNull()
    expect(subscriptionTextProblem(`${LINKS}\r\n\t`)).toBeNull()
    expect(subscriptionTextProblem('a'.repeat(10 * 1024 * 1024))).toBeNull()
    expect(subscriptionTextProblem('a'.repeat(10 * 1024 * 1024 + 1))).toMatch(/10 MiB/)
    // Characters past ASCII count as the bytes they take.
    expect(subscriptionTextProblem('节'.repeat(3_500_000))).toMatch(/10 MiB/)
    for (const value of ['PK\u0003\u0004zip', 'nul\u0000', '\u007f']) {
      expect(subscriptionTextProblem(value)).toMatch(/binary/)
    }
    for (const value of [null, 42, {}, ['a']]) {
      expect(subscriptionTextProblem(value)).toMatch(/text/)
    }
  })
})

describe('the download route', () => {
  const variables = {
    http: 'http://127.0.0.1:7890',
    https: 'socks5://u%40x:p@127.0.0.1:7891',
    all: 'http://all:3128',
    noProxy: 'corp.example,.internal',
  }

  it('takes the scheme’s proxy, else ALL_PROXY, but NO_PROXY and loopback go directly', () => {
    const route = routeFor(variables)
    expect(route(new URL('https://sub.example.net/x'))).toEqual({
      kind: 'socks5',
      host: '127.0.0.1',
      port: 7891,
      user: 'u@x',
      password: 'p',
    })
    expect(route(new URL('http://sub.example.net/x'))).toMatchObject({ kind: 'http', port: 7890 })
    expect(routeFor({ ...variables, https: null })(new URL('https://a.example'))).toMatchObject({
      host: 'all',
      port: 3128,
    })
    for (const url of [
      'https://corp.example/x',
      'https://sub.internal/x',
      'http://127.0.0.1:8080/sub',
      'http://localhost/sub',
      'http://[::1]/sub',
    ]) {
      expect(route(new URL(url))).toBeNull()
    }
    const none = routeFor({ http: null, https: null, all: null, noProxy: null })
    expect(none(new URL('https://a.example'))).toBeNull()
  })

  it('speaks HTTP, HTTPS and SOCKS5 proxies, and refuses others', () => {
    expect(parseDownloadHop('corp:3128')).toMatchObject({ kind: 'http', host: 'corp', port: 3128 })
    expect(parseDownloadHop('https://proxy.example')).toMatchObject({ kind: 'https', port: 443 })
    expect(parseDownloadHop('socks5h://[::1]')).toMatchObject({
      kind: 'socks5',
      host: '::1',
      port: 1080,
    })
    expect(parseDownloadHop('  ')).toBeNull()
    expect(() => parseDownloadHop('socks4://127.0.0.1:1080')).toThrow(/not supported/)
    expect(() => parseDownloadHop('ftp://x')).toThrow(/not supported/)
  })
})

describe('downloadSubscription', () => {
  const servers: { close(): void }[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })

  async function serve(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ): Promise<{ base: string; server: Server }> {
    const server = createServer(handler)
    servers.push({ close: () => server.close() })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
  }

  const direct = { route: () => null }

  it('asks as mihomo does and returns the body with its userinfo', async () => {
    let agent: string | undefined
    const { base } = await serve((request, response) => {
      agent = request.headers['user-agent']
      response.setHeader('subscription-userinfo', 'upload=1; download=2; total=3; expire=4')
      response.end(YAML)
    })
    const got = await downloadSubscription(`${base}/sub?token=${TOKEN}`, direct)
    expect(agent).toBe(SUBSCRIPTION_USER_AGENT)
    expect(agent).toMatch(/^clash\.meta mihomo\/\d/)
    expect(got.body.toString('utf8')).toBe(YAML)
    expect(got.userinfo).toBe('upload=1; download=2; total=3; expire=4')
  })

  it('follows a few http(s) redirects and refuses one to anything else', async () => {
    const { base } = await serve((request, response) => {
      const at = request.url ?? ''
      if (at.startsWith('/hop/')) {
        const left = Number(at.slice(5))
        response.writeHead(302, { Location: left > 0 ? `/hop/${left - 1}` : '/sub' })
        return response.end()
      }
      if (at === '/file') {
        response.writeHead(301, { Location: 'file:///etc/passwd' })
        return response.end()
      }
      if (at === '/js') {
        response.writeHead(307, { Location: 'javascript:alert(1)' })
        return response.end()
      }
      if (at === '/none') {
        response.writeHead(302)
        return response.end()
      }
      response.end(LINKS)
    })
    expect((await downloadSubscription(`${base}/hop/2`, direct)).body.toString()).toBe(LINKS)
    await expect(downloadSubscription(`${base}/hop/9`, direct)).rejects.toThrow(/too many/)
    await expect(downloadSubscription(`${base}/file`, direct)).rejects.toThrow(/not http/)
    await expect(downloadSubscription(`${base}/js`, direct)).rejects.toThrow(/not http/)
    await expect(downloadSubscription(`${base}/none`, direct)).rejects.toThrow(/location/)
    await expect(downloadSubscription('file:///etc/passwd', direct)).rejects.toThrow(/not an http/)
  })

  it('refuses a body past the cap, declared, streamed or compressed', async () => {
    const big = 'x'.repeat(4096)
    const { base } = await serve((request, response) => {
      if (request.url === '/declared') {
        response.setHeader('Content-Length', String(big.length))
        return response.end(big)
      }
      if (request.url === '/gzip') {
        response.setHeader('Content-Encoding', 'gzip')
        return response.end(gzipSync(Buffer.from(big)))
      }
      if (request.url === '/small-gzip') {
        response.setHeader('Content-Encoding', 'gzip')
        return response.end(gzipSync(Buffer.from(LINKS)))
      }
      // Chunked, with no length declared.
      response.write(big.slice(0, 2048))
      response.end(big.slice(2048))
    })
    const capped = { ...direct, maxBytes: 1024 }
    for (const at of ['/declared', '/chunked', '/gzip']) {
      await expect(downloadSubscription(`${base}${at}`, capped)).rejects.toThrow(/larger than/)
    }
    expect((await downloadSubscription(`${base}/small-gzip`, capped)).body.toString()).toBe(LINKS)
  })

  it('gives up at its deadline, and names no address when it fails', async () => {
    const { base } = await serve((request, response) => {
      if (request.url?.startsWith('/slow')) return
      response.statusCode = 403
      response.end('forbidden')
    })
    await expect(
      downloadSubscription(`${base}/slow?token=${TOKEN}`, { ...direct, timeoutMs: 300 }),
    ).rejects.toThrow(/No answer within/)
    const failed = await downloadSubscription(`${base}/sub?token=${TOKEN}`, direct).catch(
      (error: Error) => error.message,
    )
    expect(failed).toBe('The provider answered 403')
  })

  it('goes through an HTTP proxy’s tunnel and a SOCKS5 proxy, with their logins', async () => {
    const { base } = await serve((_request, response) => response.end(LINKS))
    const target = Number(new URL(base).port)
    const seen: string[] = []

    // A CONNECT proxy that wants a login.
    const httpProxy = createServer()
    servers.push(httpProxy)
    httpProxy.on('connect', (request: IncomingMessage, client: Socket) => {
      seen.push(`${request.url} ${request.headers['proxy-authorization']}`)
      const upstream = connect(target, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.pipe(client).pipe(upstream)
      })
    })
    await new Promise<void>((resolve) => httpProxy.listen(0, '127.0.0.1', resolve))

    // A SOCKS5 proxy with a username and password.
    const socks = createTcpServer((client) => {
      let stage = 0
      client.on('data', function onData(data: Buffer) {
        if (stage === 0) {
          client.write(Buffer.from([5, 2]))
          stage = 1
        } else if (stage === 1) {
          const user = data.subarray(2, 2 + data[1]!).toString()
          seen.push(`socks login ${user}`)
          client.write(Buffer.from([1, 0]))
          stage = 2
        } else {
          const name = data.subarray(5, 5 + data[4]!).toString()
          seen.push(`socks to ${name}`)
          client.off('data', onData)
          const upstream = connect(target, '127.0.0.1', () => {
            client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
            upstream.pipe(client).pipe(upstream)
          })
        }
      })
    })
    servers.push(socks)
    await new Promise<void>((resolve) => socks.listen(0, '127.0.0.1', resolve))

    const via = (hop: DownloadHop) => ({ route: () => hop })
    // A name, not loopback, so the route would take the proxy; the proxies reach the server.
    const url = `http://sub.test:${target}/sub`
    const viaHttp = await downloadSubscription(
      url,
      via({
        kind: 'http',
        host: '127.0.0.1',
        port: (httpProxy.address() as AddressInfo).port,
        user: 'me',
        password: 'pw',
      }),
    )
    expect(viaHttp.body.toString()).toBe(LINKS)
    const viaSocks = await downloadSubscription(
      url,
      via({
        kind: 'socks5',
        host: '127.0.0.1',
        port: (socks.address() as AddressInfo).port,
        user: 'me',
        password: 'pw',
      }),
    )
    expect(viaSocks.body.toString()).toBe(LINKS)
    expect(seen).toEqual([
      `sub.test:${target} Basic ${Buffer.from('me:pw').toString('base64')}`,
      'socks login me',
      'socks to sub.test',
    ])
  })

  it('fails when the proxy refuses the tunnel', async () => {
    const proxy = createServer()
    servers.push(proxy)
    proxy.on('connect', (_request, socket: Socket) => {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const hop: DownloadHop = {
      kind: 'http',
      host: '127.0.0.1',
      port: (proxy.address() as AddressInfo).port,
      user: null,
      password: null,
    }
    await expect(
      downloadSubscription('https://sub.example.net/x', { route: () => hop }),
    ).rejects.toThrow(/403/)
  })
})
