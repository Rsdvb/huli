// Huli: this computer's agent network as Settings shows it: the host's status, which comes again
// with every change, and the subscriptions' nodes with their last latency, read when Settings
// asks. Only this computer's windows hear of it. Huli's own; see tools/huli/README.md.

import { useEffect } from 'react'
import { create } from 'zustand'
import type {
  AgentNetworkStatus,
  ExitIp,
  NetworkInterfaceView,
  NodeRef,
  NodeView,
} from '@shared/agent-network'
import type { AgentId } from '@shared/thread'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { isWeb } from '@renderer/lib/platform'

/** How often the interfaces are read while something shows their state. */
const INTERFACES_MS = 5_000

interface AgentNetworkState {
  status: AgentNetworkStatus | null
  statusError: string | null
  /** Null until read; empty while the network is not running. */
  nodes: NodeView[] | null
  /** The latest test's round trip by node key; null when it did not answer. */
  delays: Record<string, number | null>
  testing: boolean
  /** The agents whose exit is being checked now. */
  checkingExit: Partial<Record<AgentId, boolean>>
  /** The computer's interfaces as last read; null until read. */
  interfaces: NetworkInterfaceView[] | null
}

export const useAgentNetworkStore = create<AgentNetworkState>()(() => ({
  status: null,
  statusError: null,
  nodes: null,
  delays: {},
  testing: false,
  checkingExit: {},
  interfaces: null,
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
  useAgentNetworkStore.setState((s) => ({
    status,
    statusError: null,
    // The status carries the host's last read, which a newer one asked for here may follow.
    interfaces:
      status.interfaces.length > 0 || s.interfaces === null ? status.interfaces : s.interfaces,
  }))
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

/** The agent's latest exit check, if it had one. */
export function useExitIp(agentId: AgentId): ExitIp | null {
  return useAgentNetworkStore(
    (s) => s.status?.exits.find((exit) => exit.agentId === agentId) ?? null,
  )
}

/** Checks where the agent's traffic leaves from now; the answer lands in the status. */
export async function checkExit(agentId: AgentId): Promise<void> {
  const set = (on: boolean) =>
    useAgentNetworkStore.setState((s) => ({ checkingExit: { ...s.checkingExit, [agentId]: on } }))
  set(true)
  try {
    const exit = await hostAt(null, 'agentNetwork.exitIp', { agentId, fresh: true })
    const status = useAgentNetworkStore.getState().status
    if (status) {
      const exits = [...status.exits.filter((e) => e.agentId !== agentId), exit]
      useAgentNetworkStore.setState({ status: { ...status, exits } })
    }
  } finally {
    set(false)
  }
}

/** Reads the status and the nodes once for whatever shows them. */
export function useAgentNetwork(): void {
  useEffect(() => {
    // A browser reaches its host as a device, which may not ask.
    if (isWeb) return
    void loadAgentNetwork()
    void loadNodes()
    void loadInterfaces().catch(() => {})
  }, [])
}

/** Reads the computer's interfaces again; the host puts a gone or down one's agents on REJECT. */
export async function loadInterfaces(): Promise<void> {
  const { interfaces } = await hostAt(null, 'agentNetwork.interfaces', undefined)
  useAgentNetworkStore.setState({ interfaces })
}

let watchers = 0
let watchTimer: ReturnType<typeof setInterval> | null = null

/**
 * Keeps the interfaces' state live while `active`, reading them every few seconds; however many
 * components ask, one read at a time.
 */
export function useLiveInterfaces(active: boolean): void {
  useEffect(() => {
    if (isWeb || !active) return
    const read = () => void loadInterfaces().catch(() => {})
    if (++watchers === 1) {
      read()
      watchTimer = setInterval(read, INTERFACES_MS)
    }
    return () => {
      if (--watchers === 0 && watchTimer) {
        clearInterval(watchTimer)
        watchTimer = null
      }
    }
  }, [active])
}
