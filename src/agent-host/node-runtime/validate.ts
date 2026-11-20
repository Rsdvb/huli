// Huli: the guards of Kite's own Node.js methods, which `createValidators` takes in. Each returns a
// fresh params object with only the known fields, or throws `invalid_params`. A paired device may
// call them all: what it can do is install, update or remove Kite's own copy, from nodejs.org or
// its mirror alone, and choose it.

import { NODE_CHOICES, type HostMethod, type NodeChoice } from '@shared/agent-host'
import { invalidParams } from '../errors'
import type { Validators } from '../rpc'

type NodeMethod = Extract<HostMethod, `environment.${string}`>

function record(params: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw invalidParams('params must be an object')
  }
  const extra = Object.keys(params).find((key) => !keys.includes(key))
  if (extra !== undefined) throw invalidParams(`Unknown param "${extra}"`)
  return params as Record<string, unknown>
}

function none(params: unknown): void {
  if (params === undefined || params === null) return
  record(params, [])
}

export const nodeRuntimeValidators: Pick<Validators, NodeMethod> = {
  'environment.installNode': none,
  'environment.cancelNodeInstall': none,
  'environment.removeNode': none,
  'environment.setNodeChoice': (params) => {
    const { choice } = record(params, ['choice'])
    if (!NODE_CHOICES.includes(choice as NodeChoice)) {
      throw invalidParams(`choice must be ${NODE_CHOICES.join(' or ')}`)
    }
    return { choice: choice as NodeChoice }
  },
}
