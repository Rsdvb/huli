import { describe, expect, it } from 'vitest'
import type { AgentAccount } from '@shared/agent-host'
import { isOutOfCredit } from '../out-of-credit'
import { isProviderQuota, providerName } from './provider-quota'

const chatgpt: AgentAccount = { kind: 'account', label: 'ChatGPT Plus', email: 'a@b.c' }
const gateway: AgentAccount = { kind: 'gateway', label: 'Model provider', email: null }
const apiKey: AgentAccount = { kind: 'api_key', label: 'API key', email: null }
const bedrock: AgentAccount = { kind: 'external', label: 'AWS Bedrock', email: null }

describe('isProviderQuota', () => {
  it("leaves a ChatGPT plan's used-up window to the plan limits", () => {
    expect(isProviderQuota(chatgpt, 'usageLimitExceeded', 'Quota exceeded.')).toBe(false)
    expect(isProviderQuota(null, 'usageLimitExceeded', 'Quota exceeded.')).toBe(false)
  })

  it("takes Codex's quota code, a 402 or a provider's billing words off a plan", () => {
    expect(isProviderQuota(apiKey, 'usageLimitExceeded', 'Quota exceeded.')).toBe(true)
    expect(isProviderQuota(gateway, { httpConnectionFailed: { httpStatusCode: 402 } }, '')).toBe(
      true,
    )
    expect(
      isProviderQuota(
        gateway,
        { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
        'exceeded retry limit, last status: 429 {"error":{"message":"Insufficient Balance"}}',
      ),
    ).toBe(true)
    expect(isProviderQuota(gateway, 'other', 'Arrearage: the account is overdue')).toBe(true)
  })

  it('leaves other failures alone', () => {
    expect(
      isProviderQuota(gateway, { responseTooManyFailedAttempts: { httpStatusCode: 429 } }, ''),
    ).toBe(false)
    expect(isProviderQuota(gateway, 'contextWindowExceeded', 'Context window exceeded')).toBe(false)
    expect(isProviderQuota(gateway, null, 'stream disconnected')).toBe(false)
  })
})

describe('providerName', () => {
  it("names the configured provider by its name, else its id, OpenAI's by default", () => {
    const config = {
      model_provider: 'deepseek',
      model_providers: { deepseek: { name: 'DeepSeek', base_url: 'https://api.deepseek.com' } },
    }
    expect(providerName(config, gateway)).toBe('DeepSeek')
    expect(providerName({ model_provider: 'kimi', model_providers: {} }, gateway)).toBe('kimi')
    expect(providerName({}, apiKey)).toBe('OpenAI')
    expect(providerName(null, apiKey)).toBe('OpenAI')
    expect(providerName(config, bedrock)).toBe('AWS Bedrock')
  })
})

describe('isOutOfCredit', () => {
  it("takes a turn Codex's connection marked as the provider's quota", () => {
    const failure = (data: unknown) => ({
      code: 'agent_error' as const,
      message: 'x',
      data: { data },
    })
    expect(
      isOutOfCredit(failure({ codexErrorInfo: 'usageLimitExceeded', providerQuota: 'DeepSeek' })),
    ).toBe(true)
    expect(isOutOfCredit(failure({ codexErrorInfo: 'usageLimitExceeded' }))).toBe(false)
  })
})
