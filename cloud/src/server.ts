// The HTTP server: routes, the security headers of every answer, and nothing else.

import { createServer, type Server } from 'node:http'
import type { ApnsSender } from './apns'
import { Auth } from './auth'
import type { Config } from './config'
import { sendError, sendHtml, TooBig } from './http'
import { messagePage, STYLE } from './pages'
import { PushGateway } from './push'
import { Store } from './store'

export interface ServerParts {
  server: Server
  store: Store
  auth: Auth
}

export function makeServer(
  config: Pick<Config, 'origin' | 'dataDir' | 'trustProxy'>,
  apns: { send: ApnsSender; topic: string } | null,
  options: { now?: () => number; log?: (line: string) => void; store?: Store } = {},
): ServerParts {
  const secure = config.origin.startsWith('https:')
  const store = options.store ?? new Store(config.dataDir, options.now)
  const auth = new Auth({ store, origin: config.origin, trustProxy: config.trustProxy, ...options })
  const push = new PushGateway({
    auth,
    origin: config.origin,
    trustProxy: config.trustProxy,
    apns,
    ...options,
  })
  const log = options.log ?? ((line: string) => console.warn(line))

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', config.origin)
    // The desktop app opens its pages under the user's language, as /zh-CN/signin/app/; the pages
    // here are in Chinese whatever the prefix, so it is dropped.
    url.pathname = url.pathname.replace(/^\/[a-z]{2}(?:-[A-Z]{2})?(?=\/)/, '')
    const route = `${request.method} ${url.pathname}`
    try {
      switch (route) {
        case 'GET /':
          return sendHtml(response, secure, 200, messagePage('Huli Cloud', '这是一个私人服务。'))
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
        case 'POST /api/v1/relay/token':
        case 'POST /api/v1/reports':
          return sendError(
            response,
            secure,
            404,
            'not_available',
            'Huli Cloud does not offer this.',
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
  server.headersTimeout = 15_000
  server.requestTimeout = 30_000
  return { server, store, auth }
}
