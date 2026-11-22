import { describe, expect, it } from 'vitest'
import type { ChatBinding, ChatPlatformConfig } from '@shared/chat-bridge'
import { admit, BindingGuard, MAX_BINDING_MISSES } from './access'

const NOW = 1_700_000_000_000

function config(overrides: Partial<ChatPlatformConfig> = {}): ChatPlatformConfig {
  return {
    enabled: true,
    credentials: { token: '123:abc' },
    accounts: [{ id: '42', name: 'Owner', chatId: null, boundAt: NOW - 1000 }],
    ...overrides,
  }
}

const binding: ChatBinding = { platform: 'telegram', code: '480213', expiresAt: NOW + 60_000 }
const direct = (id: string) => ({ platform: 'telegram' as const, id, direct: true })

describe('admit', () => {
  it('lets a bound account through in its own chat', () => {
    const outcome = admit(config(), null, new BindingGuard(), direct('42'), '/list', NOW)
    expect(outcome).toEqual({ kind: 'account', account: config().accounts[0] })
  })

  it('answers nobody else, whatever they send', () => {
    const guard = new BindingGuard()
    for (const text of ['/list', 'hello', '/y', '']) {
      expect(admit(config(), null, guard, direct('7'), text, NOW)).toEqual({ kind: 'drop' })
    }
  })

  it('ignores a bound account in a group, where others would read the answers', () => {
    const sender = { platform: 'telegram' as const, id: '42', direct: false }
    expect(admit(config(), binding, new BindingGuard(), sender, '/list', NOW)).toEqual({
      kind: 'drop',
    })
  })

  it('answers nothing while the bridge is off', () => {
    const off = config({ enabled: false })
    expect(admit(off, null, new BindingGuard(), direct('42'), '/list', NOW)).toEqual({
      kind: 'drop',
    })
    expect(admit(undefined, null, new BindingGuard(), direct('42'), '/list', NOW)).toEqual({
      kind: 'drop',
    })
  })

  it('binds a new account that sends the code', () => {
    const guard = new BindingGuard()
    expect(admit(config(), binding, guard, direct('7'), '480213', NOW)).toEqual({
      kind: 'bind',
      code: '480213',
    })
    expect(admit(config(), binding, guard, direct('8'), ' 480-213 ', NOW).kind).toBe('bind')
    expect(admit(config(), binding, guard, direct('9'), '/start 480213', NOW).kind).toBe('bind')
    expect(admit(config(), binding, guard, direct('9'), '/bind 480213', NOW).kind).toBe('bind')
    expect(admit(config(), binding, guard, direct('9'), '４８０２１３', NOW).kind).toBe('bind')
  })

  it('takes no code in a group', () => {
    const sender = { platform: 'telegram' as const, id: '7', direct: false }
    expect(admit(config(), binding, new BindingGuard(), sender, '480213', NOW).kind).toBe('drop')
  })

  it('takes no code once it expired, or for another platform', () => {
    const guard = new BindingGuard()
    expect(admit(config(), binding, guard, direct('7'), '480213', binding.expiresAt).kind).toBe(
      'drop',
    )
    const feishu = { ...binding, platform: 'feishu' as const }
    expect(admit(config(), feishu, guard, direct('7'), '480213', NOW).kind).toBe('drop')
  })

  it('takes no code without a binding under way', () => {
    expect(admit(config(), null, new BindingGuard(), direct('7'), '480213', NOW).kind).toBe('drop')
  })

  it('stops taking codes after a few wrong ones, even the right one', () => {
    const guard = new BindingGuard()
    for (let i = 0; i < MAX_BINDING_MISSES; i++) {
      expect(admit(config(), binding, guard, direct(`x${i}`), `00000${i}`, NOW).kind).toBe('drop')
    }
    expect(admit(config(), binding, guard, direct('7'), '480213', NOW).kind).toBe('drop')
    // A new code starts the count again.
    const next = { ...binding, code: '111222' }
    expect(admit(config(), next, guard, direct('7'), '111222', NOW).kind).toBe('bind')
  })

  it('does not count ordinary messages as guesses', () => {
    const guard = new BindingGuard()
    for (let i = 0; i < MAX_BINDING_MISSES * 3; i++) {
      admit(config(), binding, guard, direct('7'), 'hello, who are you?', NOW)
    }
    expect(admit(config(), binding, guard, direct('7'), '480213', NOW).kind).toBe('bind')
  })

  it('binds no more accounts than a bridge keeps', () => {
    const accounts = Array.from({ length: 10 }, (_, i) => ({
      id: `a${i}`,
      name: '',
      chatId: null,
      boundAt: NOW,
    }))
    const full = config({ accounts })
    expect(admit(full, binding, new BindingGuard(), direct('7'), '480213', NOW).kind).toBe('drop')
  })

  it('never binds by an empty id', () => {
    const outcome = admit(config({ accounts: [] }), null, new BindingGuard(), direct(''), 'x', NOW)
    expect(outcome.kind).toBe('drop')
  })
})
