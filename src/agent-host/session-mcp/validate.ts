// Huli: the guards of a session's MCP panel. A server is named as its agent names it, so its name
// is only bounded and kept free of control characters; the agent itself refuses a name it lacks.

import {
  MCP_SERVER_NAME_CHARS,
  SESSION_MCP_ACTIONS,
  type SessionMcpAction,
} from '@shared/session-mcp'
import { invalidParams } from '../errors'
import type { Validators } from '../rpc'

type Fields = Record<string, unknown>

export type SessionMcpMethod =
  | 'sessions.mcp'
  | 'sessions.mcpAct'
  | 'sessions.mcpLogin'
  | 'sessions.reloadPlugins'
  | 'sessions.dismissNotice'

const ID_CHARS = 256
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

function fields(value: unknown): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidParams('params must be an object')
  }
  return value as Fields
}

function sessionId(o: Fields): string {
  return id(o, 'sessionId')
}

function id(o: Fields, key: 'sessionId' | 'entryId'): string {
  const value = o[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > ID_CHARS) {
    throw invalidParams(`${key} must be a string of 1 to ${ID_CHARS} characters`)
  }
  return value
}

function serverName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MCP_SERVER_NAME_CHARS ||
    CONTROL.test(value)
  ) {
    throw invalidParams(
      `server must be a name of 1 to ${MCP_SERVER_NAME_CHARS} characters without control characters`,
    )
  }
  return value
}

function action(value: unknown): SessionMcpAction {
  const found = SESSION_MCP_ACTIONS.find((known) => known === value)
  if (!found) throw invalidParams(`action must be one of ${SESSION_MCP_ACTIONS.join(', ')}`)
  return found
}

export const sessionMcpValidators: Pick<Validators, SessionMcpMethod> = {
  'sessions.mcp': (params) => ({ sessionId: sessionId(fields(params)) }),
  'sessions.mcpAct': (params) => {
    const o = fields(params)
    const act = action(o.action)
    // Only a reconnect reaches every server at once; a switch names the one it turns.
    const server = o.server === null && act === 'reconnect' ? null : serverName(o.server)
    return { sessionId: sessionId(o), action: act, server }
  },
  'sessions.mcpLogin': (params) => {
    const o = fields(params)
    return { sessionId: sessionId(o), server: serverName(o.server) }
  },
  'sessions.dismissNotice': (params) => {
    const o = fields(params)
    return { sessionId: sessionId(o), entryId: id(o, 'entryId') }
  },
  'sessions.reloadPlugins': (params) => {
    if (params === undefined || params === null) return {}
    const o = fields(params)
    return o.sessionId === undefined ? {} : { sessionId: sessionId(o) }
  },
}
