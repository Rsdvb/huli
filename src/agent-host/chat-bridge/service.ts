// Huli: the chat bridges the user turned on, which the agent host loads only once one is: a
// connection and a conversation per platform, each with its own port to the host, as a paired
// device has. Main gives the credentials and the bound accounts; the bridge tells main how each
// connection is, and asks it to keep an account that sent the binding code. Nothing runs while no
// bridge is on. See tools/huli/README.md (Chat apps).

import {
  CHAT_PLATFORMS,
  credentialsReady,
  OFF_STATUS,
  type ChatAccount,
  type ChatBridgeConfig,
  type ChatBridgeStatus,
  type ChatPlatform,
  type ChatPlatformConfig,
} from '@shared/chat-bridge'
import type { HostEvent } from '@shared/agent-host'
import type { HostToMain } from '@shared/host-control'
import type { PortChannel } from '@shared/port-channel'
import type { FromPort } from '@shared/port-rpc'
import type { PortDevice } from '@shared/remote/device'
import type { AgentId } from '@shared/thread'
import { ChatController, type Attention } from './controller'
import { DingTalkAdapter, DINGTALK_PACE } from './dingtalk'
import { FeishuAdapter, FEISHU_PACE } from './feishu'
import { localHostClient, type HostClient } from './host-client'
import type { Route } from './net'
import type { PaceRules } from './pacing'
import { QqAdapter, QQ_PACE } from './qq'
import { TelegramAdapter, TELEGRAM_PACE } from './telegram'
import type { AdapterEvents, ChatAdapter } from './types'
import { WeComAdapter, WECOM_PACE } from './wecom'
import { t } from '../i18n'

export interface ChatBridgeDeps {
  /** Has the host serve a port of the bridge's own as the device's. */
  serve(channel: PortChannel<FromPort<HostEvent>>, device: PortDevice): void
  /** Where Kite's own requests go now. */
  route(): Route
  send(message: HostToMain): void
  defaultAgent(): AgentId | null
  log(level: 'info' | 'warn' | 'error', message: string): void
}

const PACE: Readonly<Record<ChatPlatform, PaceRules>> = {
  feishu: FEISHU_PACE,
  dingtalk: DINGTALK_PACE,
  wecom: WECOM_PACE,
  qq: QQ_PACE,
  telegram: TELEGRAM_PACE,
}

interface Running {
  key: string
  adapter: ChatAdapter
  controller: ChatController
  host: HostClient
  accounts: ChatAccount[]
}

/** The commands Telegram lists in its menu, in the user's language. */
function commandMenu(): { command: string; description: string }[] {
  return ['list', 's', 'new', 'stop', 'now', 'y', 'n', 'help'].map((command) => ({
    command,
    description: t(`chatBridge.menu.${command}` as 'chatBridge.menu.list'),
  }))
}

export class ChatBridgeService {
  private config: ChatBridgeConfig = { platforms: {}, binding: null }
  private readonly running = new Map<ChatPlatform, Running>()
  private readonly statuses = new Map<ChatPlatform, ChatBridgeStatus>()
  private reported = ''

  constructor(private readonly deps: ChatBridgeDeps) {}

  /** Whether any bridge runs. */
  get active(): boolean {
    return this.running.size > 0
  }

  setConfig(config: ChatBridgeConfig): void {
    this.config = config
    for (const platform of CHAT_PLATFORMS) {
      const wanted = config.platforms[platform]
      const on = wanted?.enabled === true && credentialsReady(platform, wanted.credentials)
      const current = this.running.get(platform)
      const key = on ? JSON.stringify(wanted.credentials) : ''
      if (current && (!on || current.key !== key)) {
        this.stopOne(platform)
      }
      if (!on) {
        this.statuses.set(platform, OFF_STATUS)
        continue
      }
      const kept = this.running.get(platform)
      if (kept) {
        const previous = kept.accounts
        kept.accounts = wanted.accounts
        kept.controller.accountsChanged(previous)
      } else this.startOne(platform, wanted, key)
    }
    this.report()
  }

  private platformConfig(platform: ChatPlatform): ChatPlatformConfig | undefined {
    return this.config.platforms[platform]
  }

  private startOne(platform: ChatPlatform, config: ChatPlatformConfig, key: string): void {
    const device: PortDevice = {
      id: `chat-${platform}`,
      name: t(`chatBridge.platform.${platform}`),
      imageRefs: true,
    }
    const host = localHostClient((channel) =>
      this.deps.serve(channel as PortChannel<FromPort<HostEvent>>, device),
    )
    const log = (level: 'info' | 'warn' | 'error', message: string) =>
      this.deps.log(level, `chat ${platform}: ${message}`)
    const controller = new ChatController({
      platform,
      host,
      config: () => this.platformConfig(platform),
      binding: () => this.config.binding,
      bind: (code, account) =>
        this.deps.send({ type: 'host:chat-bridge-bind', platform, code, account }),
      defaultAgent: () => this.deps.defaultAgent(),
      pace: PACE[platform],
      log,
    })
    const events: AdapterEvents = {
      message: (message) => void controller.message(message),
      action: (action) => void controller.action(action),
      status: (state, problem, detail) => {
        const before = this.statuses.get(platform) ?? OFF_STATUS
        const now = Date.now()
        this.statuses.set(platform, {
          ...before,
          state,
          ...(state === 'connected'
            ? { connectedAt: now, problem: null, detail: null }
            : problem
              ? { problem, detail: detail ?? null, errorAt: now }
              : {}),
        })
        this.report()
      },
      botName: (name) => {
        const before = this.statuses.get(platform) ?? OFF_STATUS
        this.statuses.set(platform, { ...before, botName: name.slice(0, 64) })
        this.report()
      },
      log,
    }
    const route = (url: URL) => this.deps.route()(url)
    const adapter = this.adapterFor(platform, config.credentials, route, events)
    controller.attach(adapter)
    this.running.set(platform, { key, adapter, controller, host, accounts: config.accounts })
    this.statuses.set(platform, { ...OFF_STATUS, state: 'connecting' })
    adapter.start()
  }

  private adapterFor(
    platform: ChatPlatform,
    credentials: Record<string, string>,
    route: Route,
    events: AdapterEvents,
  ): ChatAdapter {
    switch (platform) {
      case 'feishu':
        return new FeishuAdapter(credentials, route, events)
      case 'dingtalk':
        return new DingTalkAdapter(credentials, route, events)
      case 'wecom':
        return new WeComAdapter(credentials, route, events)
      case 'qq':
        return new QqAdapter(credentials, route, events)
      case 'telegram':
        return new TelegramAdapter(credentials, route, events, commandMenu)
    }
  }

  private stopOne(platform: ChatPlatform): void {
    const running = this.running.get(platform)
    if (!running) return
    this.running.delete(platform)
    running.adapter.stop()
    running.controller.stop()
    running.host.close()
  }

  /** Tells main each bridge's state, when it changed. */
  private report(): void {
    const statuses = Object.fromEntries(
      CHAT_PLATFORMS.map((platform) => [platform, this.statuses.get(platform) ?? OFF_STATUS]),
    ) as Record<ChatPlatform, ChatBridgeStatus>
    const json = JSON.stringify(statuses)
    if (json === this.reported) return
    this.reported = json
    this.deps.send({ type: 'host:chat-bridge-status', statuses })
  }

  /** The host's attention, as main hears it, for each bridge's accounts. */
  attention(attention: Attention): void {
    for (const running of this.running.values()) void running.controller.attention(attention)
  }

  stop(): void {
    for (const platform of [...this.running.keys()]) this.stopOne(platform)
    for (const platform of CHAT_PLATFORMS) this.statuses.set(platform, OFF_STATUS)
    this.report()
  }
}
