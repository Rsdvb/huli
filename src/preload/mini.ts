// Huli: the mini window's preload: the reads it shares with the window, three of the agent host's
// methods, and its own calls, exposed as window.kettu so the shared settings, theme and language
// code runs unchanged. Main takes from its page only these channels.

import { contextBridge } from 'electron'
import type { HostEvent } from '@shared/agent-host'
import { hostRequestLimit } from '@shared/host-request-limits'
import { isLocale, type Locale } from '@shared/locale'
import { MINI_HOST_METHODS, type MiniWindowApi } from '@shared/mini-window'
import { hostTransport, invoke, send, subscribe } from './ipc'
import { PortClient } from './port-client'

const agents = new PortClient<HostEvent>({
  label: 'agent host',
  methods: MINI_HOST_METHODS,
  transport: hostTransport('agent-host'),
  lazy: false,
  limitMs: hostRequestLimit,
})

function systemLocale(): Locale {
  const prefix = '--kettu-system-locale='
  const value = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
  return isLocale(value) ? value : 'en'
}

const api: MiniWindowApi = {
  platform: process.platform,
  client: 'desktop',
  systemLocale: systemLocale(),
  settings: {
    get: () => invoke('settings:get'),
    onChanged: subscribe('settings:changed'),
  },
  themes: {
    get: () => invoke('themes:get'),
    onChanged: subscribe('themes:changed'),
  },
  agents: {
    request: (method, params) => agents.request(method, params),
    onEvent: (listener) => agents.onEvent(listener),
    onConnection: (listener) => agents.onConnection(listener),
  } as MiniWindowApi['agents'],
  mini: {
    onTarget: subscribe('mini:target'),
    showSession: () => send('mini:show-session'),
    close: () => send('mini:close'),
  },
}

contextBridge.exposeInMainWorld('kettu', api)
