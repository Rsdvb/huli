// Huli: the addresses a container's "only the model" network lets through: the services each
// harness calls for its model and its sign-in, as their docs name them, checked on 2026-11-22,
// and the hosts of the base-address variables Kite hands the agent, such as a custom endpoint.
// A harness not listed, with no such variable, gets none, and its session does not start in that
// network: the user picks another.

import type { HarnessId } from '@shared/agents'
import type { Env } from '../find-command'

const HARNESS_HOSTS: Partial<Record<HarnessId, readonly string[]>> = {
  gemini: [
    'generativelanguage.googleapis.com',
    'cloudcode-pa.googleapis.com',
    'oauth2.googleapis.com',
    'www.googleapis.com',
    'accounts.google.com',
  ],
  qwen: ['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'chat.qwen.ai', 'portal.qwen.ai'],
  kimi: ['api.moonshot.cn', 'api.moonshot.ai', 'api.kimi.com', 'auth.kimi.com'],
  glm: ['open.bigmodel.cn', 'api.z.ai'],
  grok: ['api.x.ai'],
  copilot: ['api.githubcopilot.com', '*.githubcopilot.com', 'api.github.com', 'github.com'],
  codebuddy: ['codebuddy.ai', '*.codebuddy.ai', 'copilot.tencent.com'],
  auggie: ['*.augmentcode.com'],
  droid: ['api.factory.ai', 'app.factory.ai'],
  qoder: ['qoder.com', '*.qoder.com'],
}

/** Variables whose value is a service's base address. */
const BASE_VARIABLE = /(?:BASE_URL|API_BASE|API_URL|ENDPOINT|API_HOST)$/i

const RULE = /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d{1,5})?$/

/** A base address as a rule: its host, and its port where it is not the scheme's. */
function ruleOf(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const rule = (url.port ? `${url.hostname}:${url.port}` : url.hostname).toLowerCase()
  return RULE.test(rule) ? rule : null
}

export function modelHosts(harness: HarnessId, env: Env): string[] {
  const fromEnv = Object.entries(env).flatMap(([name, value]) =>
    BASE_VARIABLE.test(name) && value ? (ruleOf(value) ?? []) : [],
  )
  return [...new Set([...(HARNESS_HOSTS[harness] ?? []), ...fromEnv])]
}
