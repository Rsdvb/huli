// How the app words the link to the computer: its state, the route it took, what went wrong.

import type { LinkState } from '@shared/remote/link'
import type { DirectAddress } from '@shared/remote/protocol'
import { routeKind, type CurrentRoute } from './connection'
import type { RoutePick } from './store'

/** `off`: not connected for a while, the computer likely off or Huli not running there. */
export type LinkTone = 'ok' | 'busy' | 'down' | 'off'

/** The link's state in words and a tone, once `unreachable` (see host.tsx) as 连不上. */
export function linkStatusOf(
  state: LinkState,
  unreachable: boolean,
): { text: string; tone: LinkTone } {
  if (unreachable && state.kind !== 'connected' && state.kind !== 'stopped') {
    return { text: '连不上', tone: 'off' }
  }
  return linkStatus(state)
}

/** The computer's OS: as it said, else guessed from the names Windows and macOS give by default. */
export function platformOf(
  saved: { platform?: string; name?: string } | null | undefined,
  live?: string,
): string | undefined {
  const known = live ?? saved?.platform
  if (known) return known
  const name = saved?.name ?? ''
  if (/^(DESKTOP|LAPTOP)-[A-Z0-9]+$/i.test(name)) return 'win32'
  if (/(MacBook|iMac|Mac mini|Mac Studio|Mac Pro|\.local$)/i.test(name)) return 'darwin'
  return undefined
}

export function linkStatus(state: LinkState): { text: string; tone: LinkTone } {
  switch (state.kind) {
    case 'connected':
      return { text: '已连接', tone: 'ok' }
    case 'connecting':
      return { text: '正在连接…', tone: 'busy' }
    case 'reconnecting':
      return { text: '正在重新连接…', tone: 'busy' }
    case 'stopped':
      return { text: '已断开', tone: 'down' }
  }
}

/** A sentence for the home screen while the link is not up; null while it is. */
export function linkProblem(state: LinkState): string | null {
  switch (state.kind) {
    case 'connected':
      return null
    case 'connecting':
      return '正在连接电脑…'
    case 'reconnecting':
      return '正在重新连接…'
    case 'stopped':
      return state.reason === 'update_client'
        ? '这个 App 版本太旧，请更新。'
        : state.reason === 'update_host'
          ? '电脑上的纸鸢版本太旧，请先更新电脑端。'
          : '这台手机已被电脑移除。'
  }
}

export const ROUTE_NAMES = { tailscale: 'Tailscale', lan: '局域网', other: '直连' } as const

/** A link's route in words: the kind of address, or 中转 through Kite Cloud's relay. */
export function routeName(route: CurrentRoute): string {
  return route.kind === 'relay' ? '中转' : ROUTE_NAMES[routeKind(route.address)]
}

/** The ways the user can pick to reach a computer, as Settings lists them. */
export const ROUTE_PICKS = [
  { pick: null, title: '自动', subtitle: '哪条快走哪条，断了自动换' },
  { pick: 'direct', title: '只走直连', subtitle: 'Tailscale 或局域网，不经过中转' },
  { pick: 'relay', title: '只走中转', subtitle: '经 Kite Cloud 中转，Tailscale 不稳时用' },
] as const satisfies readonly { pick: RoutePick | null; title: string; subtitle: string }[]

/** What the 连接 and 地址 groups say of how the phone reaches a computer, by the way picked. */
export function routesNote(relay: boolean, pick: RoutePick | null = null): string {
  if (pick === 'relay') {
    return '只经 Kite Cloud 中转，不试 Tailscale 和局域网地址；手机也要登录 Kite Cloud。内容在两端之间端到端加密，中转服务器也看不到。'
  }
  if (pick === 'direct') {
    return '只试 Tailscale 和局域网地址，连上哪个用哪个，都连不上时不经中转。内容在两端之间端到端加密。'
  }
  return relay
    ? '手机先试 Tailscale 地址，再试局域网地址，连上哪个用哪个；都连不上时经 Kite Cloud 中转。内容在两端之间端到端加密，中转服务器也看不到。'
    : '手机先试 Tailscale 地址，再试局域网地址，连上哪个用哪个。内容在两端之间端到端加密，不经过任何中转服务器。'
}

export function hostPort(address: DirectAddress): string {
  return address.host.includes(':')
    ? `[${address.host}]:${address.port}`
    : `${address.host}:${address.port}`
}

export function osName(platform: string | undefined): string {
  switch (platform) {
    case 'win32':
      return 'Windows'
    case 'darwin':
      return 'macOS'
    case 'linux':
      return 'Linux'
    default:
      return platform ?? '电脑'
  }
}
