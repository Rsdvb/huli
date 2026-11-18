// The guards of the agents' network's methods, which `createValidators` takes in. Each returns a
// fresh params object with only the known fields, or throws `invalid_params`.

import type { HostMethod } from '@shared/agent-host'
import { isAgentId } from '@shared/agents'
import {
  isNodeName,
  isSubscriptionName,
  cleanSubscriptionName,
  MAX_LATENCY_NODES,
  SUBSCRIPTION_ID,
  type NodeRef,
} from '@shared/agent-network'
import { invalidParams } from '../errors'
import type { Validators } from '../rpc'
import { isSubscriptionUrl } from './files'

type NetworkMethod = Extract<HostMethod, `agentNetwork.${string}`>

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

function subscriptionId(value: unknown): string {
  if (typeof value !== 'string' || !SUBSCRIPTION_ID.test(value)) {
    throw invalidParams('id must be a subscription id')
  }
  return value
}

function name(value: unknown): string {
  const clean = typeof value === 'string' ? cleanSubscriptionName(value) : value
  if (!isSubscriptionName(clean)) {
    throw invalidParams('name must be 1 to 40 characters, without control characters or "|"')
  }
  return clean
}

function nodeRef(value: unknown, at: string): NodeRef {
  const o = record(value, ['subscription', 'node'])
  if (typeof o.subscription !== 'string' || !SUBSCRIPTION_ID.test(o.subscription)) {
    throw invalidParams(`${at}.subscription must be a subscription id`)
  }
  if (!isNodeName(o.node)) throw invalidParams(`${at}.node must be a node name`)
  return { subscription: o.subscription, node: o.node }
}

export const networkValidators: Pick<Validators, NetworkMethod> = {
  'agentNetwork.status': none,
  'agentNetwork.nodes': none,
  'agentNetwork.addSubscription': (params) => {
    const o = record(params, ['name', 'url'])
    // The address itself is never quoted back: it may carry the provider's token.
    if (!isSubscriptionUrl(o.url)) throw invalidParams('url must be an http or https address')
    return { name: name(o.name), url: o.url }
  },
  'agentNetwork.renameSubscription': (params) => {
    const o = record(params, ['id', 'name'])
    return { id: subscriptionId(o.id), name: name(o.name) }
  },
  'agentNetwork.removeSubscription': (params) => ({
    id: subscriptionId(record(params, ['id']).id),
  }),
  'agentNetwork.refresh': (params) => {
    const o = record(params, ['id'])
    return { id: o.id === null || o.id === undefined ? null : subscriptionId(o.id) }
  },
  'agentNetwork.testLatency': (params) => {
    const o = record(params, ['nodes'])
    if (o.nodes === null || o.nodes === undefined) return { nodes: null }
    if (!Array.isArray(o.nodes) || o.nodes.length > MAX_LATENCY_NODES) {
      throw invalidParams(`nodes must be null or at most ${MAX_LATENCY_NODES} nodes`)
    }
    return { nodes: o.nodes.map((item: unknown, index) => nodeRef(item, `nodes[${index}]`)) }
  },
  'agentNetwork.exitIp': (params) => {
    const o = record(params, ['agentId', 'fresh'])
    if (!isAgentId(o.agentId)) throw invalidParams('agentId must be an agent id')
    if (o.fresh !== undefined && typeof o.fresh !== 'boolean') {
      throw invalidParams('fresh must be a boolean')
    }
    return { agentId: o.agentId, ...(o.fresh === undefined ? {} : { fresh: o.fresh }) }
  },
}
