// Huli: a project's further folders over ACP: its own `additionalDirectories` where the agent
// declares it, the session router's folder flag where the router found one, and else nothing, so
// the host names them ahead of a prompt.

import { agent, methods } from '@agentclientprotocol/sdk/unstable'
import { describe, expect, it } from 'vitest'
import type { ConnectionHooks } from '../connection'
import { AcpConnection, inProcessTransport } from './connection'

interface Opened {
  method: string
  dirs: unknown
  meta: unknown
}

function connect(declares: boolean, routerFlag: string | null) {
  const opened: Opened[] = []
  let next = 0
  const app = agent({ name: 'folders-test' })
    .onRequest(methods.agent.initialize, () => ({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          resume: {},
          fork: {},
          ...(declares ? { additionalDirectories: {} } : {}),
        },
      },
      agentInfo: { name: 'folders-test', version: '1.0.0' },
      ...(routerFlag ? { _meta: { 'sh.kettu/dir-flag': routerFlag } } : {}),
    }))
    .onRequest(methods.agent.session.new, (ctx) => {
      opened.push({ method: 'new', dirs: ctx.params.additionalDirectories, meta: ctx.params._meta })
      return { sessionId: `s-${++next}` }
    })
    .onRequest(methods.agent.session.load, (ctx) => {
      opened.push({
        method: 'load',
        dirs: ctx.params.additionalDirectories,
        meta: ctx.params._meta,
      })
      return {}
    })
    .onRequest(methods.agent.session.resume, (ctx) => {
      opened.push({
        method: 'resume',
        dirs: ctx.params.additionalDirectories,
        meta: ctx.params._meta,
      })
      return {}
    })
    .onRequest(methods.agent.session.fork, (ctx) => {
      opened.push({
        method: 'fork',
        dirs: ctx.params.additionalDirectories,
        meta: ctx.params._meta,
      })
      return { sessionId: `s-${++next}` }
    })
  const hooks: ConnectionHooks = {
    traffic: () => {},
    account: () => {},
    ignored: () => {},
    log: () => {},
  }
  const connection = AcpConnection.connect(inProcessTransport(app), {
    ...hooks,
    agentId: 'fake-agent',
    name: 'Folders test',
  })
  return { connection, opened }
}

const folders = ['/work/api', '/work/web']

describe("a project's further folders over ACP", () => {
  it('go as additionalDirectories on every lifecycle request of an agent that declares them', async () => {
    const { connection, opened } = connect(true, null)
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/work/app', { folders })
    await connection.loadSession('s-9', '/work/app', { folders })
    await connection.resumeSession('s-8', '/work/app', { folders })
    await connection.forkSession(sessionId, '/work/app', { folders })
    expect(opened.map((o) => [o.method, o.dirs])).toEqual([
      ['new', folders],
      ['load', folders],
      ['resume', folders],
      ['fork', folders],
    ])
    expect(opened.every((o) => o.meta === undefined)).toBe(true)
    expect(connection.takesFolders(sessionId)).toBe(true)
    await connection.newSession('/work/app', {})
    expect(opened.at(-1)?.dirs).toBeUndefined()
  })

  it("go to the session router's folder flag for an agent that does not declare them", async () => {
    const { connection, opened } = connect(false, '--add-dir')
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/work/app', { folders })
    expect(opened[0]).toEqual({
      method: 'new',
      dirs: undefined,
      meta: { 'sh.kettu/dirs': folders },
    })
    expect(connection.takesFolders(sessionId)).toBe(true)
  })

  it('go nowhere for an agent with neither, which the host then tells of them itself', async () => {
    const { connection, opened } = connect(false, null)
    await connection.initialize('1.0.0')
    const { sessionId } = await connection.newSession('/work/app', { folders })
    expect(opened[0]).toEqual({ method: 'new', dirs: undefined, meta: undefined })
    expect(connection.takesFolders(sessionId)).toBe(false)
  })
})
