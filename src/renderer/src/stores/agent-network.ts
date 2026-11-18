// Huli: this computer's agent network as Settings shows it: the host's status, which comes again
// with every change, and the subscriptions' nodes with their last latency, read when Settings
// asks. Only this computer's windows hear of it. Huli's own; see tools/huli/README.md.

import { useEffect } from 'react'
import { create } from 'zustand'
import type { AgentNetworkStatus, NodeRef, NodeView } from '@shared/agent-network'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { isWeb } from '@renderer/lib/platform'

interface AgentNetworkState {
  status: AgentNetworkStatus | null
  statusError: string | null
  /** Null until read; empty while the network is not running. */
  nodes: NodeView[] | null
  /** The latest test's round trip by node key; null when it did not answer. */
  delays: Record<string, number | null>
  testing: boolean
}

export const useAgentNetworkStore = create<AgentNetworkState>()(() => ({
  status: null,
  statusError: null,
  nodes: null,
  delays: {},
  testing: false,
}))

/** A node's key in `delays` and in a select's values. */
export function nodeKey(ref: NodeRef): string {
  return `${ref.subscription}:${ref.node}`
}

/** The node a key names; subscription ids hold no colon, so the first one ends it. */
export function nodeOfKey(key: string): NodeRef | null {
  const at = key.indexOf(':')
  return at > 0 ? { subscription: key.slice(0, at), node: key.slice(at + 1) } : null
}

export function receiveAgentNetwork(status: AgentNetworkStatus): void {
  const before = useAgentNetworkStore.getState().status
  useAgentNetworkStore.setState({ status, statusError: null })
  // The nodes change with the subscriptions and whether mihomo runs.
  const shape = (s: AgentNetworkStatus | null) =>
    s ? JSON.stringify([s.state, s.subscriptions.map((sub) => [sub.id, sub.name, sub.nodes])]) : ''
  if (shape(before) !== shape(status)) void loadNodes()
}

export async function loadAgentNetwork(): Promise<void> {
  try {
    receiveAgentNetwork(await hostAt(null, 'agentNetwork.status', undefined))
  } catch (error) {
    useAgentNetworkStore.setState({ statusError: errorMessage(error) })
  }
}

export async function loadNodes(): Promise<void> {
  try {
    const { nodes } = await hostAt(null, 'agentNetwork.nodes', undefined)
    useAgentNetworkStore.setState({ nodes })
  } catch {
    useAgentNetworkStore.setState({ nodes: [] })
  }
}

/** Tests the nodes named, or every node; the results land in `delays`. */
export async function testLatency(nodes: NodeRef[] | null): Promise<void> {
  useAgentNetworkStore.setState({ testing: true })
  try {
    const { results } = await hostAt(null, 'agentNetwork.testLatency', { nodes })
    const delays = { ...useAgentNetworkStore.getState().delays }
    for (const result of results) delays[nodeKey(result)] = result.delay
    useAgentNetworkStore.setState({ delays })
  } finally {
    useAgentNetworkStore.setState({ testing: false })
  }
}

/** Reads the status and the nodes once for whatever shows them. */
export function useAgentNetwork(): void {
  useEffect(() => {
    // A browser reaches its host as a device, which may not ask.
    if (isWeb) return
    void loadAgentNetwork()
    void loadNodes()
  }, [])
}
