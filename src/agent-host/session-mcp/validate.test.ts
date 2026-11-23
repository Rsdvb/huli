import { describe, expect, it } from 'vitest'
import { HOST_METHODS } from '@shared/agent-host'
import { forbiddenToDevices } from '@shared/remote/allow-list'
import { createValidators } from '../validate'

const validators = createValidators('darwin')

function rejects(run: () => unknown): void {
  expect(run).toThrow(expect.objectContaining({ code: 'invalid_params' }))
}

describe("Huli: the requests of a session's MCP panel", () => {
  it('reads a session by its id alone', () => {
    expect(validators['sessions.mcp']({ sessionId: 's1', server: 'x' })).toEqual({
      sessionId: 's1',
    })
    rejects(() => validators['sessions.mcp']({}))
    rejects(() => validators['sessions.mcp']({ sessionId: 'x'.repeat(257) }))
  })

  it('takes a known action on a named server, or a reconnect of every one', () => {
    expect(
      validators['sessions.mcpAct']({ sessionId: 's1', action: 'disable', server: 'plugin:a:b' }),
    ).toEqual({ sessionId: 's1', action: 'disable', server: 'plugin:a:b' })
    expect(
      validators['sessions.mcpAct']({ sessionId: 's1', action: 'reconnect', server: null }),
    ).toEqual({ sessionId: 's1', action: 'reconnect', server: null })
    rejects(() =>
      validators['sessions.mcpAct']({ sessionId: 's1', action: 'enable', server: null }),
    )
    rejects(() => validators['sessions.mcpAct']({ sessionId: 's1', action: 'remove', server: 'a' }))
    rejects(() => validators['sessions.mcpAct']({ sessionId: 's1', action: 'enable' }))
  })

  it('refuses server names that are empty, too long or hold control characters', () => {
    const act = (server: unknown) => validators['sessions.mcpLogin']({ sessionId: 's1', server })
    expect(act('claude.ai Gmail')).toEqual({ sessionId: 's1', server: 'claude.ai Gmail' })
    rejects(() => act(''))
    rejects(() => act('x'.repeat(257)))
    rejects(() => act('a\nb'))
    rejects(() => act('a\u0000'))
    rejects(() => act(['a']))
  })

  it('dismisses a notice named by its session and entry alone', () => {
    const dismiss = validators['sessions.dismissNotice']
    expect(dismiss({ sessionId: 's1', entryId: 'n:mcp:auth:u1', hidden: true })).toEqual({
      sessionId: 's1',
      entryId: 'n:mcp:auth:u1',
    })
    rejects(() => dismiss({ sessionId: 's1' }))
    rejects(() => dismiss({ sessionId: 's1', entryId: '' }))
    rejects(() => dismiss({ sessionId: 's1', entryId: 'x'.repeat(257) }))
    rejects(() => dismiss({ entryId: 'e1' }))
    expect(HOST_METHODS).toContain('sessions.dismissNotice')
  })

  it('reloads one session or every one', () => {
    expect(validators['sessions.reloadPlugins'](undefined)).toEqual({})
    expect(validators['sessions.reloadPlugins']({})).toEqual({})
    expect(validators['sessions.reloadPlugins']({ sessionId: 's1', all: true })).toEqual({
      sessionId: 's1',
    })
    rejects(() => validators['sessions.reloadPlugins']({ sessionId: 1 }))
  })

  it("keeps a server's sign-in to this computer's windows", () => {
    for (const method of ['sessions.mcp', 'sessions.mcpAct', 'sessions.mcpLogin'] as const) {
      expect(HOST_METHODS).toContain(method)
    }
    expect(forbiddenToDevices('sessions.mcpLogin', { sessionId: 's1', server: 'a' })).toBe(true)
    expect(forbiddenToDevices('sessions.mcp', { sessionId: 's1' })).toBe(false)
    expect(
      forbiddenToDevices('sessions.mcpAct', { sessionId: 's1', action: 'reconnect', server: 'a' }),
    ).toBe(false)
  })
})
