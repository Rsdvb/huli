// The HTTP server: routes, the security headers of every answer, and nothing else. The relay's
// WebSockets come in as upgrades of the same server.

import { createServer, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { parseRegionPayload, parseSignedRegionList } from '@shared/remote/relay-regions'
import { decodeRelayBytes } from '@shared/remote/relay'
import type { ApnsSender } from './apns'
import { Auth } from './auth'
import type { Config } from './config'
import { sendError, sendHtml, sendJson, TooBig } from './http'
import { messagePage, SERVICE_NAME, STYLE } from './pages'
import { PushGateway } from './push'
import { Relay, type RelayLimits } from './relay'
import { loadRelayTokenKey, RelayTokens } from './relay-tokens'
import { Store } from './store'

export interface ServerParts {
  server: Server
  store: Store
  auth: Auth
  relay: Relay
}

/** The id the signed list gives the region at `origin`, the relay's own; `main` without one. */
export function regionIdOf(regions: string | null, origin: string): string {
  const signed = regions ? parseSignedRegionList(JSON.parse(regions)) : null
  const payload = signed ? decodeRelayBytes(signed.payload) : null
  if (!payload) return 'main'
  try {
    const list = parseRegionPayload(JSON.parse(new TextDecoder().decode(payload)), origin)
    return list?.regions.find((region) => region.url === origin)?.id ?? 'main'
  } catch {
    return 'main'
  }
}

export function makeServer(
  config: Pick<Config, 'origin' | 'dataDir' | 'trustProxy'> &
    Partial<Pick<Config, 'webOrigin' | 'regions'>>,
  apns: { send: ApnsSender; topic: string } | null,
  options: {
    now?: () => number
    log?: (line: string) => void
    store?: Store
    relayLimits?: Partial<RelayLimits>
  } = {},
): ServerParts {
  const secure = config.origin.startsWith('https:')
  const webOrigin = config.webOrigin ?? null
  const regions = config.regions ?? null
  const store = options.store ?? new Store(config.dataDir, options.now)
  const auth = new Auth({
    store,
    origin: config.origin,
    trustProxy: config.trustProxy,
    webOrigin,
    ...options,
  })
  const push = new PushGateway({
    auth,
    origin: config.origin,
    trustProxy: config.trustProxy,
    apns,
    ...options,
  })
  const tokens = new RelayTokens(store, loadRelayTokenKey(config.dataDir), options.now)
  const relay = new Relay({
    origin: config.origin,
    webOrigins: webOrigin ? [webOrigin] : [],
    regionId: regionIdOf(regions, config.origin),
    regions,
    tokens,
    trustProxy: config.trustProxy,
    ...(options.relayLimits ? { limits: options.relayLimits } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.log ? { log: options.log } : {}),
  })
  const log = options.log ?? ((line: string) => console.warn(line))

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', config.origin)
    // The desktop app opens its pages under the user's language, as /zh-CN/signin/app/; the pages
    // here are in Chinese whatever the prefix, so it is dropped.
    url.pathname = url.pathname.replace(/^\/[a-z]{2}(?:-[A-Z]{2})?(?=\/)/, '')
    const route = `${request.method} ${url.pathname}`
    try {
      if (url.pathname.startsWith('/v1') && relay.http(request, response, url.pathname)) return
      // The hosted web client calls the API from its own origin, with bearer tokens, never cookies.
      if (url.pathname.startsWith('/api/') && webOrigin && request.headers.origin === webOrigin) {
        response.setHeader('access-control-allow-origin', webOrigin)
        response.setHeader('vary', 'Origin')
        if (request.method === 'OPTIONS') {
          response.writeHead(204, {
            'access-control-allow-methods': 'GET, POST',
            'access-control-allow-headers': 'authorization, content-type',
            'access-control-max-age': '600',
          })
          return response.end()
        }
      }
      switch (route) {
        case 'GET /':
          return sendHtml(response, secure, 200, messagePage(SERVICE_NAME, '这是一个私人服务。'))
        case 'GET /healthz':
          response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
          return response.end('ok')
        case 'GET /static/style.css':
          response.writeHead(200, {
            'content-type': 'text/css; charset=utf-8',
            'cache-control': 'public, max-age=86400',
            'x-content-type-options': 'nosniff',
          })
          return response.end(STYLE)
        case 'GET /signin/app/':
          return auth.signInPage(request, response, url)
        case 'POST /signin/app/':
          return await auth.signInSubmit(request, response)
        case 'POST /api/oauth/token':
          return await auth.token(request, response)
        case 'POST /api/oauth/device':
          return await auth.deviceStart(request, response)
        case 'POST /api/oauth/revoke':
          return await auth.revoke(request, response)
        case 'GET /api/v1/me':
          return auth.me(request, response)
        case 'POST /api/v1/relay/token': {
          const family = auth.authorize(request, response)
          if (!family) return
          return sendJson(response, secure, 200, tokens.issue(family.id))
        }
        case 'GET /device':
          return auth.devicePage(request, response, url)
        case 'POST /device':
          return await auth.deviceSubmit(request, response)
        case 'POST /web/login':
          return await auth.webLogin(request, response)
        case 'GET /account/':
        case 'GET /account/devices/':
          return auth.accountPage(request, response)
        case 'POST /account/devices/revoke':
          return await auth.revokeDevice(request, response)
        case 'POST /account/signout':
          return await auth.webSignOut(request, response)
        case 'POST /v1/push':
          return await push.handle(request, response)
        case 'POST /api/v1/reports':
          return sendError(
            response,
            secure,
            404,
            'not_available',
            `${SERVICE_NAME} does not offer this.`,
          )
        default:
          return sendError(response, secure, 404, 'not_found', 'Not found.')
      }
    } catch (error) {
      if (error instanceof TooBig) {
        return sendError(response, secure, 413, 'too_big', 'The request is too large.')
      }
      log(`huli-cloud: ${route} failed: ${(error as Error).stack ?? String(error)}`)
      if (!response.headersSent)
        sendError(response, secure, 500, 'server_error', 'Something went wrong.')
      else response.destroy()
    }
  })
  server.on('upgrade', (request, socket: Duplex, head: Buffer) => {
    socket.on('error', () => {})
    if (
      request.headers.upgrade?.toLowerCase() !== 'websocket' ||
      !relay.upgrade(request, socket, head)
    ) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    }
  })
  server.on('close', () => relay.close())
  server.headersTimeout = 15_000
  server.requestTimeout = 30_000
  return { server, store, auth, relay }
}
