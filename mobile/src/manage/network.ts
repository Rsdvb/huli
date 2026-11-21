// The computer's agent network as the phone sees it: names, counts, choices and exits from
// `agentNetwork.deviceStatus`, which never carries a subscription's link. The phone picks the
// default node and each agent's node or network interface; the subscriptions stay the computer's
// to change.

import type {
  AgentNetworkChoice,
  AgentNetworkDeviceStatus,
  AgentNetworkState,
  ExitIp,
  NodeRef,
} from '@shared/agent-network'
import { useCallback, useEffect, useRef } from 'react'
import { useFocusEffect } from 'expo-router'
import type { HostLink } from '@shared/remote/link'
import type { AgentId } from '@shared/thread'
import { admin } from '../admin'
import { call, useRead, type Read } from './kit'

export type NetworkStatus = AgentNetworkDeviceStatus

/** What the default node, or one agent, is set to here. */
export type NetworkPick = 'default' | AgentNetworkChoice | null

export const STATE_TEXT: Record<AgentNetworkState, string> = {
  off: '已关闭',
  starting: '正在启动',
  running: '运行中',
  error: '未运行',
}

export const PROBLEM_TEXT = {
  missing: '电脑上的纸鸢没有带 mihomo，用节点的 Agent 都无法联网。',
  interface: '电脑没有找到物理网卡，用节点的 Agent 都无法联网。',
  start: 'mihomo 没能启动，用节点的 Agent 都无法联网。纸鸢会再试。',
  exited: 'mihomo 已停止，在它重新运行之前，用节点的 Agent 都无法联网。',
} as const

/** Every page that shows the network, told to read it again. */
const readers = new Set<() => void>()
let soon: ReturnType<typeof setTimeout>[] = []

function stopSoon(): void {
  for (const timer of soon) clearTimeout(timer)
  soon = []
}

/**
 * The network as the computer has it. Every page that shows it reads it again after a pick on any
 * of them (reloadSoon), and on coming back into view, since the computer tells no phone of a change
 * made on it.
 */
export function useNetworkStatus(): Read<NetworkStatus> {
  const read = useRead('agent-network', (link) =>
    call(link, 'agentNetwork.deviceStatus', undefined),
  )
  const { reload } = read
  useEffect(() => {
    const hear = () => void reload()
    readers.add(hear)
    return () => {
      readers.delete(hear)
      if (readers.size === 0) stopSoon()
    }
  }, [reload])
  // The first focus is the mount, which reads already.
  const shown = useRef(false)
  useFocusEffect(
    useCallback(() => {
      if (shown.current) void reload()
      shown.current = true
    }, [reload]),
  )
  return read
}

/** A node's key, as the latency results are kept by. */
export function nodeKey(ref: NodeRef): string {
  return `${ref.subscription}:${ref.node}`
}

/** A node named with its subscription, or marked gone when the computer no longer has it. */
export function nodeName(status: NetworkStatus, ref: NodeRef): string {
  const sub = status.subscriptions.find((s) => s.id === ref.subscription)
  const known = status.nodes.some((n) => n.subscription === ref.subscription && n.node === ref.node)
  const name = sub ? `${sub.name} | ${ref.node}` : ref.node
  // Nodes are listed only while the network runs; until then a node is not known to be gone.
  return known || status.state !== 'running' ? name : `${name}（已不存在）`
}

/** An interface an agent is bound to, with its state on the computer. */
export function interfaceText(status: NetworkStatus, name: string): string {
  const found = status.interfaces.find((item) => item.name === name)
  if (status.interfaces.length === 0 || found?.up) return `网卡：${name}`
  return found ? `网卡：${name}（未连接）` : `网卡：${name}（已不存在）`
}

/** The default way out in words: a node, an interface, or none. */
export function defaultText(status: NetworkStatus): string {
  const chosen = status.defaultNode
  if (!chosen) return '无：不联网'
  return 'interface' in chosen ? interfaceText(status, chosen.interface) : nodeName(status, chosen)
}

/** An agent's choice in words. */
export function choiceText(status: NetworkStatus, choice: AgentNetworkChoice | 'default'): string {
  if (choice === 'system') return '系统网络'
  if (choice === 'default')
    return status.defaultNode ? `跟随默认（${defaultText(status)}）` : '跟随默认'
  if ('interface' in choice) return interfaceText(status, choice.interface)
  return nodeName(status, choice)
}

export function agentChoice(
  status: NetworkStatus,
  agentId: AgentId,
): AgentNetworkChoice | 'default' {
  return status.agents.find((a) => a.agentId === agentId)?.choice ?? 'default'
}

export function agentExit(status: NetworkStatus, agentId: AgentId): ExitIp | null {
  return status.exits.find((e) => e.agentId === agentId) ?? null
}

const REGIONS: Record<string, string> = {
  CN: '中国',
  HK: '中国香港',
  MO: '中国澳门',
  TW: '中国台湾',
  JP: '日本',
  KR: '韩国',
  SG: '新加坡',
  US: '美国',
  CA: '加拿大',
  GB: '英国',
  DE: '德国',
  FR: '法国',
  NL: '荷兰',
  RU: '俄罗斯',
  AU: '澳大利亚',
  IN: '印度',
  TR: '土耳其',
  MY: '马来西亚',
  TH: '泰国',
  VN: '越南',
  PH: '菲律宾',
  ID: '印度尼西亚',
  AR: '阿根廷',
  BR: '巴西',
}

/** A country or region's name from its ISO code; Hermes may lack Intl.DisplayNames. */
export function regionName(code: string): string {
  if (REGIONS[code]) return REGIONS[code]
  try {
    if (typeof Intl.DisplayNames === 'function') {
      return new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(code) ?? code
    }
  } catch {
    // An engine without region names: the code itself says it.
  }
  return code
}

/** Where the agent's traffic last left from, or why it could not get out; null when unchecked. */
export function exitText(exit: ExitIp | null): string | null {
  if (!exit) return null
  if (exit.failure === 'unsupported') return '无法检测出口：系统代理不是 HTTP 代理'
  const via = { node: '节点出口', interface: '网卡出口', system: '系统网络出口' }[exit.via]
  if (!exit.ip) return `${via}：无法连接`
  return exit.country ? `${via} ${exit.ip}（${regionName(exit.country)}）` : `${via} ${exit.ip}`
}

/** A latency in words: the round trip, a node that did not answer, or nothing when untested. */
export function delayText(delay: number | null | undefined): string | undefined {
  if (delay === undefined || delay === null) return undefined
  return delay > 0 ? `${delay} ms` : '超时'
}

/** Sets the default node (`target` default) or one agent's choice on the computer. */
export async function setPick(
  link: HostLink,
  target: 'default' | AgentId,
  pick: NetworkPick,
): Promise<void> {
  if (target === 'default') {
    // A computer of this version takes an interface as the default too.
    const node = pick === null || pick === 'default' || pick === 'system' ? null : pick
    await admin(link, 'settings.setDefaultNode', { node })
    return
  }
  await admin(link, 'settings.setAgentNetwork', {
    agentId: target,
    choice: pick === 'default' || pick === null ? null : pick,
  })
}

/**
 * Has every page that shows the network read it again now and twice more, as the computer checks
 * the exits after a node change. A later change starts over; the reads stop once no page is left.
 */
export function reloadSoon(): void {
  stopSoon()
  const tell = () => {
    for (const reader of readers) reader()
  }
  tell()
  soon = [3_000, 9_000].map((ms) => setTimeout(tell, ms))
}
