// Every row of the Settings page as data: where it is, the catalog keys of its words, how its value
// reads and changes, and what agents may do with it. The page draws its rows' words from here, and
// Kettu's settings tools read the same entries, so a row added to the page is one agents see.

import { isFullAccessMode } from './agents'
import { ELEVATED_MODES } from './computer-use'
import { FEATURE_IDS, featureOn, type FeatureId } from './features'
import { takesAutoCompact } from './auto-compact'
import { IDLE_RELEASE_MODES } from './idle-release'
import { LOCALE_NAMES, LOCALES } from './locale'
import type { Platform } from './platform'
import { takesProfiles } from './provider-profiles'
import { PLUGIN_SETTING_CHARS } from './plugins'
import {
  BACKUP_KEEP_MAX,
  BACKUP_KEEP_MIN,
  isBackupTime,
  isFontFamilyName,
  MAX_FONT_FAMILY_CHARS,
  type UserFontRole,
  NEW_SESSION_LISTS,
  RUNNING_SENDS,
  ZOOM_LEVELS,
  type SidebarPage,
  type RelayChoice,
  type SettingsFile,
  type SettingsPatch,
} from './settings'
import { AUTO_APPROVE_LEVELS } from './risk'
import { SANDBOX_NETWORKS, SANDBOX_TIERS } from './sandbox'
import { RESUME_TEXT_CHARS, STALL_MINUTES } from './supervisor'
import { DEFAULT_IDLE_TERMINAL_MINUTES, IDLE_TERMINAL_MINUTES } from './terminal-idle'
import { SETTLE_DAYS } from './session-tidy'
import { BIN_KEEP_DAYS } from './recycle-bin'
import { TOOL_CALL_VIEWS } from './zen-view'
import { STARTED_LIMIT_MAX, STARTED_LIMIT_MIN, type StartedLimitKey } from './started-sessions'
import type { AgentId, HarnessId } from './thread'
import { PORT_BASE_MAX, PORT_BASE_MIN } from './worktree-ports'
import { WEBHOOK_PORT_MAX, WEBHOOK_PORT_MIN } from './routines'
import { DEFAULT_SHORTCUTS, SHORTCUT_GROUPS, SHORTCUT_IDS, type ShortcutId } from './shortcuts'
import { WORKING_STEP_LIMITS } from './workflow'

export const SETTINGS_SECTIONS = [
  'general',
  'appearance',
  'agents',
  // Huli: manager mode's roster.
  'manager',
  'harnesses',
  'memory',
  'terminal',
  'git',
  'notifications',
  'account',
  'usage',
  'archived',
  // Huli: the recycle bin (回收站).
  'recycle-bin',
  'artifacts',
  'sharing',
  'remote',
  'hosts',
  'browser',
  'devices',
  'computer-use',
  // Huli: the network agents' traffic goes through, the daily backup and the chat apps' bots.
  'agent-network',
  'backup',
  'chat-bridge',
  // Huli: the switches of Kite's optional features.
  'features',
  // Huli: the keys of Kite's shortcuts, and the global screenshot hotkey.
  'shortcuts',
  'advanced',
  'about',
] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/**
 * Where a row is: a section of Settings, or `marketplace` for a plugin's settings, which are on the
 * plugin's own page there.
 */
export type CatalogSection = SettingsSection | 'marketplace'

/**
 * What a row's value is: one the tools may change (a switch, a choice, a number, a text), one they
 * only read (a path, an account's facts), a secret they read only as set or not, a list they count,
 * or an action the user takes on the page.
 */
export type SettingKind =
  'switch' | 'choice' | 'number' | 'text' | 'path' | 'secret' | 'list' | 'info' | 'action'

/**
 * `read`: agents never change it. `change`: as the session's mode allows. `ask`: always asks.
 * `raise`: a number that always asks when raised, and is lowered as the session's mode allows.
 */
export type SettingAccess = 'read' | 'change' | 'ask' | 'raise'

/** `host`: on every host. `desktop`: the desktop app's own, its window's or its computer's. */
export type SettingPart = 'host' | 'desktop'

export type SettingScalar = string | number | boolean | null

/** A key of the settings catalog, or of another namespace as `usage:key`. */
export type TextKey = string

/** A text that differs by system, as Dock and taskbar do; `other` for the rest. */
export type PlatformText = { mac?: TextKey; windows?: TextKey; linux?: TextKey; other: TextKey }

export type EntryText = TextKey | PlatformText

/** How a choice reads: a catalog key, words as they are, or words that differ by system. */
export type OptionLabel =
  | { key: TextKey; params?: Record<string, string> }
  | { text: string }
  | { platform: Partial<Record<'mac' | 'windows' | 'linux', string>> & { other: string } }

export interface SettingOption {
  value: SettingScalar
  label: OptionLabel
}

/** A setting a plugin declares, as the catalog lists it: its words are the plugin's own. */
export interface CatalogPluginSetting {
  key: string
  type: 'boolean' | 'string' | 'select' | 'secret'
  title: string
  description?: string
  options?: readonly { value: string; title: string }[]
}

export interface CatalogPlugin {
  id: string
  /** In the interface language. */
  title: string
  settings: readonly CatalogPluginSetting[]
}

/** What the host knows when it lists its entries: its system, whether it draws a window. */
export interface CatalogContext {
  platform: Platform
  /** The settings' owner is the desktop app, so its window's and computer's rows apply. */
  desktop: boolean
  /** Kettu's cloud services are on. */
  cloud: boolean
  /** The agents of the host, for the rows of each agent's page and the default agent's choice. */
  agents: readonly { id: AgentId; name: string; harnessId: HarnessId }[]
  /** The harnesses of the host, for the rows of each harness's page. */
  harnesses: readonly { id: HarnessId; name: string }[]
  /** The modes each agent's new sessions may start in, by agent; absent before it was used. */
  modes: Readonly<Partial<Record<AgentId, readonly { value: string; name: string }[]>>>
  /** Huli: which optional features are on (Settings > Features); all when absent. */
  features?: Partial<Record<string, boolean>>
  /** The plugins that are installed, with the settings each declares. */
  plugins: readonly CatalogPlugin[]
}

export interface CatalogEntry {
  section: CatalogSection
  /** The row's id on its page, which a search result scrolls to and flashes. */
  row: string
  /** The label of the group the row shows under, when it has one. */
  group?: TextKey
  name: EntryText
  description?: EntryText
  keywords?: TextKey | readonly TextKey[]
  part: SettingPart
  kind: SettingKind
  access?: SettingAccess
  /** For a row that always asks, or asks when raised: what changing it opens up, on the card. */
  warning?: TextKey
  /** Values for its words' placeholders, such as a shortcut's keys, on the host's system. */
  params?(platform: Platform): Record<string, string>
  /**
   * A row of each agent's, harness's or plugin's own page, named by its id. A plugin's row is
   * named `pluginId:key`, one per setting the plugin declares.
   */
  item?: 'agent' | 'harness' | 'plugin'
  /**
   * For a row whose words are the plugin's own: its name and description as they are, in place of
   * the catalog's keys.
   */
  literal?(ctx: CatalogContext, item: string | null): { name: string; description?: string }
  /** Where the page shows the row, when it is not `row` on the section's page. */
  target?(item: string | null): { item: string | null; row: string }
  /** The value lives in the plugin's own record, which the host sets, not in the settings file. */
  store?: 'plugin'
  /** Whether the host has the row; always when absent. */
  on?(ctx: CatalogContext, item: string | null): boolean
  /** Huli: the optional feature the row belongs to, which hides it while turned off. */
  feature?: FeatureId
  options?:
    readonly SettingOption[] | ((ctx: CatalogContext, item: string | null) => SettingOption[])
  /** A number's bounds and the unit it reads in. */
  min?: number
  max?: number
  /** A text's length at most. */
  chars?: number
  check?(value: string): boolean
  /** The value in the settings file; absent for what the host reads elsewhere, as a fact. */
  get?(file: SettingsFile, item: string | null): SettingScalar
  /** The patch that sets the value, for the kinds agents may change. */
  patch?(value: SettingScalar, file: SettingsFile, item: string | null): SettingsPatch
}

const ON_OFF: readonly SettingOption[] = [
  { value: true, label: { key: 'agentSettings.on' } },
  { value: false, label: { key: 'agentSettings.off' } },
]

function choices(
  values: readonly SettingScalar[],
  key: (value: string) => TextKey,
): SettingOption[] {
  return values.map((value) => ({ value, label: { key: key(String(value)) } }))
}

/** The plugin and the setting a plugin row's item names, `pluginId:key`; null when none does. */
export function pluginSettingOf(
  ctx: CatalogContext,
  item: string | null,
): { plugin: CatalogPlugin; setting: CatalogPluginSetting } | null {
  const at = item?.indexOf(':') ?? -1
  if (item === null || at < 0) return null
  const plugin = ctx.plugins.find((each) => each.id === item.slice(0, at))
  const setting = plugin?.settings.find((each) => each.key === item.slice(at + 1))
  return plugin && setting ? { plugin, setting } : null
}

/** A row of the plugin settings: one entry per kind of setting, for the settings that are of it. */
function pluginSetting(
  type: CatalogPluginSetting['type'],
  rest: Pick<CatalogEntry, 'kind'> & Partial<CatalogEntry>,
): CatalogEntry {
  return {
    section: 'marketplace',
    row: 'setting',
    // Never read: `literal` gives the plugin's own words.
    name: 'sections.marketplace',
    part: 'host',
    item: 'plugin',
    store: 'plugin',
    on: (ctx, item) => pluginSettingOf(ctx, item)?.setting.type === type,
    literal: (ctx, item) => {
      const found = pluginSettingOf(ctx, item)
      return {
        name: found?.setting.title ?? '',
        ...(found?.setting.description ? { description: found.setting.description } : {}),
      }
    },
    target: (item) => ({
      item: item?.slice(0, item.indexOf(':')) ?? null,
      row: `setting-${item?.slice(item.indexOf(':') + 1) ?? ''}`,
    }),
    ...rest,
  }
}

const isAgent = (ctx: CatalogContext, item: string | null): boolean =>
  ctx.agents.some((agent) => agent.id === item)
const isHarness = (ctx: CatalogContext, item: string | null): boolean =>
  ctx.harnesses.some((harness) => harness.id === item)

/** A switch of the file's own: true while the value is. */
function flag<S extends keyof SettingsPatch>(
  section: S,
  key: string,
  read: (file: SettingsFile) => boolean,
): Pick<CatalogEntry, 'kind' | 'options' | 'get' | 'patch'> {
  return {
    kind: 'switch',
    options: ON_OFF,
    get: (file) => read(file),
    patch: (value) => ({ [section]: { [key]: value === true } }) as SettingsPatch,
  }
}

/** A face of the user's own for one kind of text; empty goes back to the theme's. */
function userFont(role: UserFontRole): CatalogEntry {
  return {
    section: 'appearance',
    row: `font-${role}`,
    group: 'appearance.groups.fonts',
    name: `appearance.fonts.${role}.name`,
    description: `appearance.fonts.${role}.description`,
    keywords: 'appearance.fonts.keywords',
    part: 'desktop',
    access: 'change',
    kind: 'text',
    chars: MAX_FONT_FAMILY_CHARS,
    check: (value) => value === '' || isFontFamilyName(value),
    get: (file) => file.appearance.fonts[role] ?? null,
    patch: (value, file) => {
      const fonts = { ...file.appearance.fonts }
      if (value === '' || value === null) delete fonts[role]
      else fonts[role] = String(value)
      return { appearance: { fonts } }
    },
  }
}

/** Whether the sidebar lists a page; its place among the others is set in the list only. */
function sidebarPage(page: SidebarPage): CatalogEntry {
  return {
    section: 'appearance',
    row: `sidebar-${page}`,
    group: 'appearance.groups.sidebar',
    name: `appearance.sidebarPages.${page}`,
    description: 'appearance.sidebarPages.description',
    keywords: 'appearance.sidebarPages.keywords',
    part: 'desktop',
    access: 'change',
    kind: 'switch',
    options: ON_OFF,
    get: (file) => !file.appearance.sidebarHidden.includes(page),
    patch: (value, file) => {
      const others = file.appearance.sidebarHidden.filter((hidden) => hidden !== page)
      return { appearance: { sidebarHidden: value === true ? others : [...others, page] } }
    },
  }
}

function pick<S extends keyof SettingsPatch>(
  section: S,
  key: string,
  read: (file: SettingsFile) => SettingScalar,
  options: readonly SettingOption[],
): Pick<CatalogEntry, 'kind' | 'options' | 'get' | 'patch'> {
  return {
    kind: 'choice',
    options,
    get: (file) => read(file),
    patch: (value) => ({ [section]: { [key]: value } }) as SettingsPatch,
  }
}

/** Huli: the groups of Settings > Features, in the page's order. */
export const FEATURE_GROUPS = ['work', 'agents', 'connections'] as const
export type FeatureGroup = (typeof FEATURE_GROUPS)[number]

/** Huli: where each feature's switch shows on Settings > Features. */
export const FEATURE_GROUP: Readonly<Record<FeatureId, FeatureGroup>> = {
  board: 'work',
  manager: 'work',
  bestOfN: 'work',
  routines: 'work',
  github: 'work',
  fileCheckpoints: 'work',
  sessionTidy: 'work',
  sessionMentions: 'work',
  zenView: 'work',
  sandbox: 'agents',
  mcpPanel: 'agents',
  devices: 'agents',
  secrets: 'agents',
  agentTheme: 'agents',
  agentNotify: 'agents',
  webReader: 'agents',
  chatBridge: 'connections',
  portForwarding: 'connections',
  devPreview: 'connections',
  pickElement: 'connections',
  agentSync: 'connections',
}

/** Huli: each shortcut the user may rebind, which agents read but never change. */
const SHORTCUT_ENTRIES = Object.fromEntries(
  SHORTCUT_IDS.map((id) => [
    `shortcuts.${id}`,
    {
      section: 'shortcuts',
      row: id,
      group: `shell:shortcuts.groups.${SHORTCUT_GROUPS[id]}`,
      name: `shell:shortcuts.${id}`,
      keywords: 'shortcuts.keywords',
      part: 'desktop',
      kind: 'info',
      get: (file) => file.keyboard?.shortcuts[id] ?? DEFAULT_SHORTCUTS[id],
    } satisfies CatalogEntry,
  ]),
) as unknown as Record<`shortcuts.${ShortcutId}`, CatalogEntry>

/** Huli: the sections a feature switch hides whole. */
const SECTION_FEATURES: Partial<Record<CatalogSection, FeatureId>> = {
  manager: 'manager',
  'chat-bridge': 'chatBridge',
  devices: 'devices',
}

/** Huli: one switch a feature, which always asks: it reshapes the app the user sees. */
const FEATURE_ENTRIES = Object.fromEntries(
  FEATURE_IDS.map((id) => [
    `features.${id}`,
    {
      section: 'features',
      row: id,
      group: `features.groups.${FEATURE_GROUP[id]}`,
      name: `features.items.${id}.name`,
      description: `features.items.${id}.description`,
      keywords: 'features.keywords',
      part: 'desktop',
      access: 'ask',
      ...flag('features', id, (file) => featureOn(file.features, id)),
    } satisfies CatalogEntry,
  ]),
) as Record<`features.${FeatureId}`, CatalogEntry>
/** A limit on the sessions agents start: raising one lets agents use more of the plan. */
function startedLimit(
  key: StartedLimitKey,
): Pick<CatalogEntry, 'access' | 'warning' | 'kind' | 'min' | 'max' | 'get' | 'patch'> {
  return {
    access: 'raise',
    warning: 'agentSettings.warning.startedLimits',
    kind: 'number',
    min: STARTED_LIMIT_MIN,
    max: STARTED_LIMIT_MAX,
    get: (file) => file.startedSessions[key],
    patch: (value) => ({ startedSessions: { [key]: Number(value) } }),
  }
}

const ENTRIES = {
  // ---- General
  'general.language': {
    section: 'general',
    row: 'language',
    group: 'general.groups.input',
    name: 'general.language.name',
    description: 'general.language.description',
    keywords: 'general.language.keywords',
    part: 'desktop',
    access: 'change',
    ...pick('general', 'language', (file) => file.general.language, [
      { value: 'system', label: { key: 'agentSettings.system' } },
      ...LOCALES.map((locale) => ({ value: locale, label: { text: LOCALE_NAMES[locale] } })),
    ]),
  },
  'general.send-key': {
    section: 'general',
    row: 'send-key',
    group: 'general.groups.input',
    name: 'general.sendKey.name',
    description: 'general.sendKey.description',
    keywords: 'general.sendKey.keywords',
    part: 'desktop',
    access: 'change',
    ...pick('general', 'sendKey', (file) => file.general.sendKey, [
      { value: 'enter', label: { text: 'Enter' } },
      {
        value: 'mod-enter',
        label: { platform: { mac: '⌘ Enter', other: 'Ctrl+Enter' } },
      },
    ]),
  },
  'general.running-send': {
    section: 'general',
    row: 'running-send',
    group: 'general.groups.input',
    name: 'general.runningSend.name',
    description: 'general.runningSend.description',
    keywords: 'general.runningSend.keywords',
    part: 'desktop',
    access: 'change',
    ...pick(
      'general',
      'runningSend',
      (file) => file.general.runningSend,
      choices(RUNNING_SENDS, (mode) => `general.runningSend.${mode}`),
    ),
  },
  'general.default-agent': {
    section: 'general',
    row: 'default-agent',
    group: 'general.groups.sessions',
    name: 'general.defaultAgent.name',
    description: 'general.defaultAgent.description',
    part: 'desktop',
    access: 'change',
    kind: 'choice',
    options: (ctx) => [
      { value: null, label: { key: 'general.defaultAgent.askEachTime' } },
      ...ctx.agents
        .filter((agent) => agent.id !== 'fake-agent')
        .map((agent) => ({ value: agent.id, label: { text: agent.name } })),
    ],
    get: (file) => file.general.defaultAgent,
    patch: (value) => ({ general: { defaultAgent: value as AgentId | null } }),
  },
  'general.new-session-list': {
    section: 'general',
    row: 'new-session-list',
    group: 'general.groups.sessions',
    name: 'general.newSessionList.name',
    description: 'general.newSessionList.description',
    keywords: 'general.newSessionList.keywords',
    part: 'desktop',
    access: 'change',
    ...pick(
      'general',
      'newSessionList',
      (file) => file.general.newSessionList,
      choices(NEW_SESSION_LISTS, (list) => `general.newSessionList.${list}`),
    ),
  },
  'general.restore': {
    section: 'general',
    row: 'restore',
    group: 'general.groups.sessions',
    name: 'general.restore.name',
    description: 'general.restore.description',
    part: 'desktop',
    access: 'change',
    ...flag('general', 'restoreLastSession', (file) => file.general.restoreLastSession),
  },
  'general.confirm-quit': {
    section: 'general',
    row: 'confirm-quit',
    group: 'general.groups.sessions',
    name: 'general.confirmQuit.name',
    description: 'general.confirmQuit.description',
    keywords: 'general.confirmQuit.keywords',
    part: 'desktop',
    access: 'change',
    ...flag('general', 'confirmQuitWhileRunning', (file) => file.general.confirmQuitWhileRunning),
  },
  'general.session-titles': {
    section: 'general',
    row: 'session-titles',
    group: 'general.groups.sessions',
    name: 'general.sessionTitles.name',
    description: 'general.sessionTitles.description',
    keywords: 'general.sessionTitles.keywords',
    part: 'host',
    access: 'change',
    ...flag('general', 'sessionTitles', (file) => file.general.sessionTitles),
  },
  'general.prompt-suggestions': {
    section: 'general',
    row: 'prompt-suggestions',
    group: 'general.groups.sessions',
    name: 'general.promptSuggestions.name',
    description: 'general.promptSuggestions.description',
    keywords: 'general.promptSuggestions.keywords',
    part: 'host',
    access: 'change',
    ...flag('general', 'promptSuggestions', (file) => file.general.promptSuggestions),
  },
  // Huli: the suggestions of agents without their own, which cost a request of the plan each turn.
  'general.other-agent-suggestions': {
    section: 'general',
    row: 'other-agent-suggestions',
    group: 'general.groups.sessions',
    name: 'general.otherAgentSuggestions.name',
    description: 'general.otherAgentSuggestions.description',
    keywords: 'general.otherAgentSuggestions.keywords',
    part: 'host',
    access: 'change',
    ...flag('general', 'otherAgentSuggestions', (file) => file.general.otherAgentSuggestions),
  },
  'general.agent-passwords': {
    section: 'general',
    row: 'agent-passwords',
    group: 'general.groups.sessions',
    name: 'general.agentPasswords.name',
    description: 'general.agentPasswords.description',
    keywords: 'general.agentPasswords.keywords',
    part: 'host',
    access: 'ask',
    warning: 'agentSettings.warning.passwords',
    ...flag('general', 'agentPasswords', (file) => file.general.agentPasswords),
  },
  'general.light-model': {
    section: 'general',
    row: 'light-model',
    group: 'general.groups.sessions',
    name: 'general.lightModel.name',
    description: 'general.lightModel.description',
    keywords: 'general.lightModel.keywords',
    part: 'host',
    kind: 'info',
  },
  'general.background': {
    section: 'general',
    row: 'background',
    group: 'general.groups.sessions',
    name: 'general.background.name',
    description: {
      mac: 'general.background.descriptionMac',
      windows: 'general.background.descriptionWindows',
      other: 'general.background.descriptionLinux',
    },
    keywords: 'general.background.keywords',
    part: 'desktop',
    access: 'change',
    ...flag('general', 'background', (file) => file.general.background),
  },
  // Huli: no idle sleep while agents work.
  'general.keep-awake': {
    section: 'general',
    row: 'keep-awake',
    group: 'general.groups.sessions',
    name: 'general.keepAwake.name',
    description: 'general.keepAwake.description',
    keywords: 'general.keepAwake.keywords',
    part: 'desktop',
    access: 'change',
    ...flag('general', 'keepAwake', (file) => file.general.keepAwake),
  },
  'general.outline-summaries': {
    section: 'general',
    row: 'outline-summaries',
    group: 'general.groups.thread',
    name: 'general.outlineSummaries.name',
    description: 'general.outlineSummaries.description',
    keywords: 'general.outlineSummaries.keywords',
    part: 'desktop',
    access: 'change',
    ...flag('thread', 'outlineSummaries', (file) => file.thread.outlineSummaries),
  },
  'general.tool-calls': {
    section: 'general',
    row: 'tool-calls',
    group: 'general.groups.thread',
    name: 'general.toolCalls.name',
    description: 'general.toolCalls.description',
    keywords: 'general.toolCalls.keywords',
    part: 'desktop',
    access: 'change',
    feature: 'zenView',
    ...pick(
      'thread',
      'toolCalls',
      (file) => file.thread.toolCalls,
      choices(TOOL_CALL_VIEWS, (view) => `general.toolCalls.${view}`),
    ),
  },
  'general.open-at-login': {
    section: 'general',
    row: 'open-at-login',
    group: 'general.groups.startup',
    name: 'general.openAtLogin.name',
    description: 'general.openAtLogin.description',
    keywords: 'general.openAtLogin.keywords',
    part: 'desktop',
    access: 'change',
    ...flag('general', 'openAtLogin', (file) => file.general.openAtLogin),
  },
  'general.cloud': {
    section: 'general',
    row: 'cloud',
    group: 'general.groups.cloud',
    name: 'general.cloud.name',
    description: 'general.cloud.note',
    keywords: 'general.cloud.keywords',
    part: 'desktop',
    access: 'ask',
    warning: 'agentSettings.warning.cloud',
    ...flag('cloud', 'enabled', (file) => file.cloud.enabled),
  },
  'general.other-connections': {
    section: 'general',
    row: 'other-connections',
    group: 'general.groups.cloud',
    name: 'general.others.name',
    description: 'general.others.description',
    keywords: 'general.others.keywords',
    part: 'desktop',
    kind: 'info',
  },

  // ---- Appearance
  'appearance.theme': {
    section: 'appearance',
    row: 'theme',
    group: 'appearance.groups.theme',
    name: 'appearance.theme.name',
    keywords: 'appearance.theme.keywords',
    part: 'desktop',
    kind: 'info',
  },
  'appearance.color-mode': {
    section: 'appearance',
    row: 'color-mode',
    group: 'appearance.groups.theme',
    name: 'appearance.colorMode.name',
    keywords: 'appearance.colorMode.keywords',
    part: 'desktop',
    access: 'change',
    ...pick(
      'appearance',
      'theme',
      (file) => file.appearance.theme,
      choices(['system', 'light', 'dark'], (mode) => `appearance.colorMode.${mode}`),
    ),
  },
  'appearance.zoom': {
    section: 'appearance',
    row: 'zoom',
    group: 'appearance.groups.scale',
    name: 'appearance.zoom.name',
    description: 'appearance.zoom.description',
    params: (platform) =>
      platform === 'darwin'
        ? { zoomIn: '⌘=', zoomOut: '⌘-' }
        : { zoomIn: 'Ctrl+=', zoomOut: 'Ctrl+-' },
    keywords: 'appearance.zoom.keywords',
    part: 'desktop',
    access: 'change',
    ...pick(
      'appearance',
      'zoom',
      (file) => file.appearance.zoom,
      ZOOM_LEVELS.map((zoom) => ({ value: zoom, label: { text: `${Math.round(zoom * 100)}%` } })),
    ),
  },
  'appearance.text-size': {
    section: 'appearance',
    row: 'text-size',
    group: 'appearance.groups.scale',
    name: 'appearance.textSize.name',
    description: 'appearance.textSize.description',
    keywords: 'appearance.textSize.keywords',
    part: 'desktop',
    access: 'change',
    ...pick(
      'appearance',
      'textSize',
      (file) => file.appearance.textSize,
      choices(['small', 'default', 'large'], (size) => `appearance.textSize.${size}`),
    ),
  },
  'appearance.font-ui': userFont('ui'),
  'appearance.font-prose': userFont('prose'),
  'appearance.font-code': userFont('code'),
  'appearance.sidebar-hover': {
    section: 'appearance',
    row: 'sidebar-hover',
    group: 'appearance.groups.sidebar',
    name: 'appearance.sidebarHover.name',
    description: 'appearance.sidebarHover.description',
    keywords: 'appearance.sidebarHover.keywords',
    part: 'desktop',
    access: 'change',
    ...flag('appearance', 'sidebarHover', (file) => file.appearance.sidebarHover),
  },
  'appearance.sidebar-overview': sidebarPage('overview'),
  'appearance.sidebar-artifacts': sidebarPage('artifacts'),
  'appearance.sidebar-routines': sidebarPage('routines'),
  'appearance.sidebar-marketplace': sidebarPage('marketplace'),
  'appearance.sidebar-usage': sidebarPage('usage'),
  'appearance.effort-control': {
    section: 'appearance',
    row: 'effort-control',
    group: 'appearance.groups.modelMenu',
    name: 'appearance.effortControl.name',
    description: 'appearance.effortControl.description',
    keywords: 'appearance.effortControl.keywords',
    part: 'desktop',
    access: 'change',
    ...pick(
      'appearance',
      'effortControl',
      (file) => file.appearance.effortControl,
      choices(['dial', 'segments'], (style) => `appearance.effortControl.${style}`),
    ),
  },
  'appearance.reduce-motion': {
    section: 'appearance',
    row: 'reduce-motion',
    group: 'appearance.groups.motion',
    name: 'appearance.reduceMotion.name',
    description: {
      mac: 'appearance.reduceMotion.description',
      other: 'appearance.reduceMotion.descriptionOther',
    },
    keywords: 'appearance.reduceMotion.keywords',
    part: 'desktop',
    access: 'change',
    ...pick(
      'appearance',
      'reduceMotion',
      (file) => file.appearance.reduceMotion,
      choices(['system', 'always'], (mode) => `appearance.reduceMotion.${mode}`),
    ),
  },

  // ---- Notifications
  'notifications.preview': {
    section: 'notifications',
    row: 'preview',
    name: 'notifications.groups.preview',
    description: 'notifications.test',
    part: 'desktop',
    kind: 'action',
  },
  'notifications.island': {
    section: 'notifications',
    row: 'island',
    name: 'notifications.island.name',
    description: 'notifications.island.description',
    keywords: 'notifications.island.keywords',
    part: 'desktop',
    access: 'change',
    on: (ctx) => ctx.desktop && ctx.platform === 'darwin',
    ...flag('notifications', 'island', (file) => file.notifications.island),
  },
  // Huli: what the island shows beside the notch; the page's own menu also offers turning it off.
  'notifications.island-sides': {
    section: 'notifications',
    row: 'island-sides',
    name: 'notifications.islandSides.name',
    description: 'notifications.islandSides.description',
    keywords: 'notifications.islandSides.keywords',
    part: 'desktop',
    access: 'change',
    on: (ctx) => ctx.desktop && ctx.platform === 'darwin',
    ...pick(
      'notifications',
      'islandSides',
      (file) => file.notifications.islandSides,
      choices(['auto', 'notch'], (mode) => `notifications.islandSides.${mode}`),
    ),
  },
  'notifications.permission': {
    section: 'notifications',
    row: 'permission',
    group: 'notifications.groups.when',
    name: 'notifications.permission.name',
    description: 'notifications.permission.description',
    keywords: 'notifications.permission.keywords',
    part: 'desktop',
    access: 'change',
    ...flag('notifications', 'permission', (file) => file.notifications.permission),
  },
  'notifications.turn-ended': {
    section: 'notifications',
    row: 'turn-ended',
    group: 'notifications.groups.when',
    name: 'notifications.turnEnded.name',
    description: 'notifications.turnEnded.description',
    part: 'desktop',
    access: 'change',
    ...flag('notifications', 'turnEnded', (file) => file.notifications.turnEnded),
  },
  'notifications.agent-notes': {
    section: 'notifications',
    feature: 'agentNotify',
    row: 'agent-notes',
    group: 'notifications.groups.when',
    name: 'notifications.agentNotes.name',
    description: 'notifications.agentNotes.description',
    keywords: 'notifications.agentNotes.keywords',
    part: 'desktop',
    access: 'change',
    ...flag('notifications', 'agentNotes', (file) => file.notifications.agentNotes),
  },
  'notifications.routines': {
    section: 'notifications',
    feature: 'routines',
    row: 'routines',
    group: 'notifications.groups.when',
    name: 'notifications.routines.name',
    description: 'notifications.routines.description',
    keywords: 'notifications.routines.keywords',
    part: 'desktop',
    access: 'change',
    ...flag('notifications', 'routines', (file) => file.notifications.routines),
  },
  'notifications.error': {
    section: 'notifications',
    row: 'error',
    group: 'notifications.groups.when',
    name: 'notifications.error.name',
    description: 'notifications.error.description',
    part: 'desktop',
    access: 'change',
    ...flag('notifications', 'error', (file) => file.notifications.error),
  },
  'notifications.updates': {
    section: 'notifications',
    row: 'updates',
    group: 'notifications.groups.when',
    name: 'notifications.updates.name',
    description: 'notifications.updates.description',
    keywords: 'notifications.updates.keywords',
    part: 'desktop',
    access: 'change',
    on: (ctx) => ctx.desktop,
    ...flag('notifications', 'updates', (file) => file.notifications.updates),
  },
  'notifications.plan-limits': {
    section: 'notifications',
    row: 'plan-limits',
    group: 'notifications.groups.when',
    name: 'notifications.planLimits.name',
    description: 'notifications.planLimits.description',
    keywords: 'notifications.planLimits.keywords',
    part: 'desktop',
    access: 'change',
    on: (ctx) => ctx.desktop,
    ...flag('notifications', 'planLimits', (file) => file.notifications.planLimits),
  },
  'notifications.sound': {
    section: 'notifications',
    row: 'sound',
    group: 'notifications.groups.how',
    name: 'notifications.sound.name',
    description: 'notifications.sound.description',
    part: 'desktop',
    access: 'change',
    ...flag('notifications', 'sound', (file) => file.notifications.sound),
  },
  'notifications.badge': {
    section: 'notifications',
    row: 'badge',
    group: 'notifications.groups.how',
    name: { mac: 'notifications.badge.nameDock', other: 'notifications.badge.nameTaskbar' },
    description: 'notifications.badge.description',
    keywords: 'notifications.badge.keywords',
    part: 'desktop',
    access: 'change',
    on: (ctx) => ctx.desktop && ctx.platform !== 'linux',
    ...flag('notifications', 'badge', (file) => file.notifications.badge),
  },
  // Which notices a plugin's channel gets is set on the plugin's page, so the list only points there.
  'notifications.plugin-channels': {
    section: 'notifications',
    row: 'plugin-channels',
    group: 'notifications.groups.alsoSent',
    name: 'notifications.groups.alsoSent',
    description: 'notifications.alsoSent.description',
    keywords: 'notifications.alsoSent.keywords',
    part: 'host',
    kind: 'list',
    on: (ctx) => ctx.plugins.length > 0,
  },

  // ---- Account
  'account.account': {
    section: 'account',
    row: 'account',
    name: 'account.name',
    description: 'account.description',
    keywords: 'account.keywords',
    part: 'desktop',
    kind: 'info',
    on: (ctx) => ctx.desktop && ctx.cloud,
  },
  'account.plan': {
    section: 'account',
    row: 'plan',
    name: 'account.plan.name',
    description: 'account.plan.description',
    keywords: 'account.plan.keywords',
    part: 'desktop',
    kind: 'info',
    on: (ctx) => ctx.desktop && ctx.cloud,
  },
  'account.devices': {
    section: 'account',
    row: 'devices',
    name: 'account.devices.name',
    description: 'account.devices.description',
    keywords: 'account.devices.keywords',
    part: 'desktop',
    kind: 'info',
    on: (ctx) => ctx.desktop && ctx.cloud,
  },
  'account.storage': {
    section: 'account',
    row: 'storage',
    name: 'account.storage.name',
    description: 'account.storage.description',
    keywords: 'account.storage.keywords',
    part: 'desktop',
    kind: 'info',
    on: (ctx) => ctx.desktop && ctx.cloud,
  },
  'account.points': {
    section: 'account',
    row: 'points',
    name: 'account.points.name',
    description: 'account.points.description',
    keywords: 'account.points.keywords',
    part: 'desktop',
    kind: 'info',
    on: (ctx) => ctx.desktop && ctx.cloud,
  },
  'account.subscription': {
    section: 'account',
    row: 'subscription',
    name: 'account.subscription.name',
    description: 'account.subscription.description',
    keywords: 'account.subscription.keywords',
    part: 'desktop',
    kind: 'info',
    on: (ctx) => ctx.desktop && ctx.cloud,
  },

  // ---- Hosts
  'hosts.hosts': {
    section: 'hosts',
    row: 'hosts',
    name: 'sections.hosts',
    description: 'pages.hosts',
    keywords: 'hosts.keywords',
    part: 'desktop',
    kind: 'list',
  },
  'hosts.add-host': {
    section: 'hosts',
    row: 'add-host',
    name: 'hosts.add.button',
    keywords: 'hosts.keywords',
    part: 'desktop',
    kind: 'action',
  },
  'hosts.this-computer': {
    section: 'hosts',
    row: 'this-computer',
    name: 'hosts.self.label',
    part: 'desktop',
    kind: 'info',
  },
  'hosts.account-hosts': {
    section: 'hosts',
    row: 'account-hosts',
    group: 'hosts.account.group',
    name: 'hosts.account.group',
    description: 'hosts.account.description',
    keywords: 'hosts.account.keywords',
    part: 'desktop',
    kind: 'list',
    on: (ctx) => ctx.desktop && ctx.cloud,
  },
  // The web client's own page: the host that served it, and this browser's name there.
  'hosts.web-host': {
    section: 'hosts',
    row: 'host',
    name: 'sections.hosts',
    description: 'pages.hostsWeb',
    keywords: 'hosts.keywords',
    part: 'desktop',
    kind: 'info',
    on: () => false,
  },
  'hosts.device-name': {
    section: 'hosts',
    row: 'device-name',
    name: 'hosts.page.name',
    part: 'desktop',
    kind: 'info',
    on: () => false,
  },
  'hosts.forget': {
    section: 'hosts',
    row: 'forget',
    name: 'hosts.web.forget.name',
    description: 'hosts.web.forget.description',
    keywords: 'hosts.web.forget.keywords',
    part: 'desktop',
    kind: 'action',
    on: () => false,
  },
  'hosts.others': {
    section: 'hosts',
    row: 'others',
    group: 'hosts.web.others.name',
    name: 'hosts.web.others.name',
    description: 'hosts.web.others.description',
    keywords: 'hosts.web.others.keywords',
    part: 'desktop',
    kind: 'list',
    on: () => false,
  },

  // ---- Browser
  'browser.bring-sign-ins': {
    section: 'browser',
    row: 'bring-sign-ins',
    group: 'browser.groups.signIns',
    name: 'browser.signIns.name',
    description: 'browser.signIns.description',
    keywords: 'browser.signIns.keywords',
    part: 'desktop',
    kind: 'action',
  },
  'browser.brought-sites': {
    section: 'browser',
    row: 'bring-sign-ins',
    group: 'browser.groups.signIns',
    name: 'agentSettings.lists.broughtSites',
    keywords: 'browser.signIns.keywords',
    part: 'desktop',
    kind: 'list',
  },
  'browser.open-links-in': {
    section: 'browser',
    row: 'open-links-in',
    group: 'browser.groups.links',
    name: 'browser.openLinksIn.name',
    description: 'browser.openLinksIn.description',
    params: (platform) => ({ mod: platform === 'darwin' ? '⌘' : 'Ctrl' }),
    keywords: 'browser.openLinksIn.keywords',
    part: 'desktop',
    access: 'change',
    ...pick('thread', 'openLinksIn', (file) => file.thread.openLinksIn, [
      { value: 'browser', label: { key: 'browser.openLinksIn.defaultBrowser' } },
      { value: 'session', label: { key: 'browser.openLinksIn.session' } },
      { value: 'ask', label: { key: 'browser.openLinksIn.ask' } },
    ]),
  },
  'browser.confirm-links': {
    section: 'browser',
    row: 'confirm-links',
    group: 'browser.groups.links',
    name: 'browser.confirmLinks.name',
    description: 'browser.confirmLinks.description',
    keywords: 'browser.confirmLinks.keywords',
    part: 'desktop',
    access: 'change',
    ...flag('thread', 'confirmLinks', (file) => file.thread.confirmLinks),
  },
  'browser.remembered-sites': {
    section: 'browser',
    row: 'remembered-sites',
    group: 'browser.groups.links',
    name: 'browser.rememberedSites.name',
    description: 'browser.rememberedSites.description',
    keywords: 'browser.rememberedSites.keywords',
    part: 'desktop',
    kind: 'list',
    get: (file) => Object.keys(file.thread.alwaysOpenIn).length,
  },
  // Huli: Moli for background web reading, downloaded only from here or its feature's switch.
  'browser.web-reader': {
    section: 'browser',
    row: 'web-reader',
    group: 'browser.groups.webReader',
    name: 'browser.webReader.name',
    description: 'browser.webReader.description',
    keywords: 'browser.webReader.keywords',
    part: 'desktop',
    kind: 'action',
  },
  'browser.clear-data': {
    section: 'browser',
    row: 'clear-data',
    group: 'browser.groups.siteData',
    name: 'browser.clearData.name',
    description: 'browser.clearData.description',
    keywords: 'browser.clearData.keywords',
    part: 'desktop',
    kind: 'action',
  },
  'browser.profiles': {
    section: 'browser',
    row: 'profiles',
    group: 'browser.groups.siteData',
    name: 'browser.profiles.name',
    description: 'browser.profiles.description',
    keywords: 'browser.profiles.keywords',
    part: 'desktop',
    access: 'change',
    ...pick('browserProfiles', 'mode', (file) => file.browserProfiles.mode, [
      { value: 'shared', label: { key: 'browser.profiles.shared' } },
      { value: 'worktree', label: { key: 'browser.profiles.worktree' } },
      { value: 'session', label: { key: 'browser.profiles.session' } },
    ]),
  },
  'browser.saved-states': {
    section: 'browser',
    row: 'saved-states',
    group: 'browser.groups.savedStates',
    name: 'browser.savedStates.name',
    description: 'browser.savedStates.description',
    keywords: 'browser.savedStates.keywords',
    part: 'desktop',
    kind: 'list',
  },
  'browser.allowed-sites': {
    section: 'browser',
    row: 'allowed-sites',
    group: 'browser.groups.allowedSites',
    name: 'browser.allowedSites.name',
    description: 'browser.allowedSites.description',
    keywords: 'browser.allowedSites.keywords',
    part: 'desktop',
    kind: 'list',
  },

  // ---- Mobile devices
  'devices.allowed-devices': {
    section: 'devices',
    row: 'allowed-devices',
    group: 'devices.groups.allowed',
    name: 'devices.allowed.name',
    description: 'devices.allowed.description',
    keywords: 'devices.allowed.keywords',
    part: 'desktop',
    kind: 'list',
  },

  // ---- Computer use
  'computer-use.enabled': {
    section: 'computer-use',
    row: 'enabled',
    group: 'computer.groups.use',
    name: 'computer.enabled.name',
    description: 'computer.enabled.description',
    keywords: 'computer.enabled.keywords',
    part: 'desktop',
    access: 'ask',
    warning: 'agentSettings.warning.computer',
    ...flag('computerUse', 'enabled', (file) => file.computerUse.enabled),
  },
  'computer-use.pause-on-use': {
    section: 'computer-use',
    row: 'pause-on-use',
    group: 'computer.groups.use',
    name: 'computer.pauseOnUse.name',
    description: 'computer.pauseOnUse.description',
    keywords: 'computer.pauseOnUse.keywords',
    part: 'desktop',
    access: 'change',
    ...flag('computerUse', 'pauseOnUse', (file) => file.computerUse.pauseOnUse),
  },
  // Huli: the foreground once an action is not delivered in the background.
  'computer-use.allow-foreground': {
    section: 'computer-use',
    row: 'allow-foreground',
    group: 'computer.groups.use',
    name: 'computer.allowForeground.name',
    description: 'computer.allowForeground.description',
    keywords: 'computer.allowForeground.keywords',
    part: 'desktop',
    access: 'ask',
    warning: 'agentSettings.warning.computerForeground',
    ...flag('computerUse', 'allowForeground', (file) => file.computerUse.allowForeground),
  },
  // Huli: apps run as administrator. Agents read it and never change it: only the user widens
  // it, after a dialog that says what an agent outside a sandbox could do with it.
  'computer-use.elevated': {
    section: 'computer-use',
    row: 'elevated',
    group: 'computer.groups.use',
    name: 'computer.elevated.name',
    description: 'computer.elevated.description',
    keywords: 'computer.elevated.keywords',
    part: 'desktop',
    access: 'read',
    on: (ctx) => ctx.desktop && ctx.platform === 'win32',
    kind: 'choice',
    options: choices(ELEVATED_MODES, (mode) => `computer.elevated.mode.${mode}`),
    get: (file) => file.computerUse.elevated,
  },
  'computer-use.stop-shortcut': {
    section: 'computer-use',
    row: 'stop-shortcut',
    group: 'computer.groups.use',
    name: 'computer.stopShortcut.name',
    description: 'computer.stopShortcut.description',
    keywords: 'computer.stopShortcut.keywords',
    part: 'desktop',
    kind: 'info',
    get: (file) => file.computerUse.stopShortcut || null,
  },
  'computer-use.accessibility': {
    section: 'computer-use',
    row: 'accessibility',
    group: 'computer.groups.permissions',
    name: 'computer.accessibility.name',
    description: 'computer.accessibility.description',
    keywords: 'computer.enabled.keywords',
    part: 'desktop',
    kind: 'action',
    on: (ctx) => ctx.desktop && ctx.platform === 'darwin',
  },
  'computer-use.screen-recording': {
    section: 'computer-use',
    row: 'screen-recording',
    group: 'computer.groups.permissions',
    name: 'computer.screenRecording.name',
    description: 'computer.screenRecording.description',
    keywords: 'computer.enabled.keywords',
    part: 'desktop',
    kind: 'action',
    on: (ctx) => ctx.desktop && ctx.platform === 'darwin',
  },
  'computer-use.windows': {
    section: 'computer-use',
    row: 'windows',
    group: 'computer.groups.permissions',
    name: 'computer.windows.name',
    description: 'computer.windows.description',
    part: 'desktop',
    kind: 'info',
    on: (ctx) => ctx.desktop && ctx.platform === 'win32',
  },
  'computer-use.desktop': {
    section: 'computer-use',
    row: 'desktop',
    group: 'computer.groups.permissions',
    name: 'computer.desktop.name',
    part: 'desktop',
    kind: 'info',
    on: (ctx) => ctx.desktop && ctx.platform === 'linux',
  },
  'computer-use.allowed-apps': {
    section: 'computer-use',
    row: 'no-allowed-apps',
    group: 'computer.groups.allowedApps',
    name: 'computer.groups.allowedApps',
    description: 'computer.allowedApps.description',
    keywords: 'computer.allowedApps.keywords',
    part: 'desktop',
    kind: 'list',
    get: (file) => file.computerUse.allowedApps.length,
  },

  // ---- Agents
  'agents.agents': {
    section: 'agents',
    row: 'agents',
    group: 'agents.groups.list',
    name: 'sections.agents',
    description: 'pages.agents',
    keywords: 'agents.keywords',
    part: 'host',
    kind: 'list',
  },
  'agents.add-agent': {
    section: 'agents',
    row: 'add-agent',
    group: 'agents.groups.list',
    name: 'agents.add.button',
    keywords: 'agents.add.keywords',
    part: 'host',
    kind: 'action',
  },
  'agents.account': {
    section: 'agents',
    row: 'account',
    name: 'agentSettings.agent.account',
    keywords: 'agents.keywords',
    part: 'host',
    kind: 'info',
    item: 'agent',
    on: isAgent,
  },
  'agents.enabled': {
    section: 'agents',
    row: 'enabled',
    name: 'agents.enable.name',
    description: 'agents.enable.on',
    part: 'host',
    access: 'ask',
    warning: 'agentSettings.warning.agentOff',
    item: 'agent',
    on: isAgent,
    kind: 'switch',
    options: ON_OFF,
    get: (file, item) => !file.disabledAgents.includes(item as AgentId),
    patch: (value, file, item) => {
      const others = file.disabledAgents.filter((id) => id !== item)
      return { disabledAgents: value === true ? others : [...others, item as AgentId] }
    },
  },
  'agents.start-mode': {
    section: 'agents',
    row: 'start-mode',
    name: 'agents.startMode.name',
    description: 'agents.startMode.description',
    part: 'host',
    access: 'ask',
    warning: 'agentSettings.warning.startMode',
    item: 'agent',
    on: (ctx, item) => isAgent(ctx, item) && ctx.modes[item as AgentId] !== undefined,
    kind: 'choice',
    options: (ctx, item) => [
      { value: null, label: { key: 'agentSettings.agent.followAgent' } },
      ...(ctx.modes[item as AgentId] ?? []).map((mode) => ({
        value: mode.value,
        label: { text: mode.name },
      })),
    ],
    get: (file, item) => file.startModes[item as AgentId] ?? null,
    patch: (value, _, item) => ({ startModes: { [item as AgentId]: value as string | null } }),
  },
  'agents.kettu-mcp': {
    section: 'agents',
    row: 'mcp-servers',
    name: 'agentSettings.agent.kettuMcp',
    description: 'agents.mcpServers.description',
    part: 'host',
    access: 'ask',
    warning: 'agentSettings.warning.kettuMcp',
    item: 'agent',
    on: isAgent,
    kind: 'switch',
    options: ON_OFF,
    get: (file, item) => !file.mcp.kettu.off.includes(item as AgentId),
    patch: (value, file, item) => {
      const others = file.mcp.kettu.off.filter((id) => id !== item)
      return { mcp: { kettu: { off: value === true ? others : [...others, item as AgentId] } } }
    },
  },
  'agents.api-key': {
    section: 'agents',
    row: 'api-key',
    name: 'agents.key.row',
    part: 'host',
    kind: 'secret',
    item: 'agent',
    on: isAgent,
  },
  // Huli: the agent's API provider profiles, for an agent whose sessions take them.
  'agents.profiles': {
    section: 'agents',
    row: 'profiles',
    name: 'agents.profiles.group',
    description: 'agents.profiles.hint',
    part: 'host',
    kind: 'list',
    item: 'agent',
    on: (ctx, item) => isAgent(ctx, item) && takesProfiles(item as AgentId),
  },
  'agents.favorite-models': {
    section: 'agents',
    row: 'favorite-models',
    name: 'agents.favorites.name',
    description: 'agents.favorites.description',
    keywords: 'agents.favorites.keywords',
    part: 'host',
    kind: 'list',
    item: 'agent',
    on: isAgent,
  },
  'agents.auto-compact': {
    section: 'agents',
    row: 'auto-compact',
    name: 'agents.autoCompact.name',
    description: 'agents.autoCompact.catalog',
    part: 'host',
    kind: 'info',
    item: 'agent',
    on: (ctx, item) => ctx.agents.some((a) => a.id === item && takesAutoCompact(a.id)),
  },
  'agents.prompt-cache': {
    section: 'agents',
    row: 'prompt-cache',
    name: 'agents.claudeSettings.cache.name',
    description: 'agents.claudeSettings.cache.description',
    part: 'host',
    kind: 'info',
    item: 'agent',
    on: (ctx, item) => ctx.agents.some((a) => a.id === item && a.harnessId === 'claude-code'),
  },
  'agents.config-folder': {
    section: 'agents',
    row: 'config',
    name: 'agents.config.folder',
    part: 'host',
    kind: 'path',
    item: 'agent',
    on: isAgent,
    get: (file, item) =>
      file.addedAgents.find((agent) => agent.id === item)?.configDir ??
      file.agents[item as HarnessId]?.configDir ??
      null,
  },
  'agents.remove': {
    section: 'agents',
    row: 'remove',
    name: 'agents.remove.name',
    description: 'agents.remove.description',
    part: 'host',
    kind: 'action',
    item: 'agent',
    on: isAgent,
  },
  'agents.idle-release': {
    section: 'agents',
    row: 'idle-release',
    group: 'agents.idle.group',
    name: 'agents.idle.release.name',
    description: 'agents.idle.release.description',
    keywords: 'agents.idle.keywords',
    part: 'host',
    access: 'change',
    ...pick(
      'idleSessions',
      'release',
      (file) => file.idleSessions.release,
      choices(IDLE_RELEASE_MODES, (mode) => `agents.idle.release.${mode}`),
    ),
  },
  'agents.idle-fallback': {
    section: 'agents',
    row: 'idle-release',
    group: 'agents.idle.group',
    name: 'agents.idle.fallback.title',
    keywords: 'agents.idle.keywords',
    part: 'host',
    kind: 'info',
    on: () => false,
  },
  // Huli: 省流量: every agent's auto-compact at once, and the offer of a handoff.
  'agents.compact-preset': {
    section: 'agents',
    row: 'compact-preset',
    group: 'agents.traffic.group',
    name: 'agents.traffic.compact.name',
    description: 'agents.traffic.compact.description',
    keywords: 'agents.traffic.compact.keywords',
    part: 'host',
    kind: 'info',
  },
  'agents.handoff-offer': {
    section: 'agents',
    row: 'handoff-offer',
    group: 'agents.traffic.group',
    name: 'agents.traffic.handoff.name',
    description: 'agents.traffic.handoff.description',
    keywords: 'agents.traffic.handoff.keywords',
    part: 'desktop',
    access: 'change',
    ...flag('thread', 'handoffOffer', (file) => file.thread.handoffOffer),
  },
  'agents.lower-priority': {
    section: 'agents',
    row: 'lower-priority',
    group: 'agents.priority.group',
    name: 'agents.priority.name',
    description: {
      windows: 'agents.priority.descriptionWindows',
      other: 'agents.priority.description',
    },
    keywords: 'agents.priority.keywords',
    part: 'host',
    access: 'change',
    ...flag('general', 'lowerAgentPriority', (file) => file.general.lowerAgentPriority),
  },
  // Huli: which requests the host allows by itself. Agents read it and never change it, since a
  // change would widen what they may do without asking.
  'agents.auto-approve': {
    section: 'agents',
    row: 'auto-approve',
    group: 'agents.autoApprove.group',
    name: 'agents.autoApprove.name',
    description: 'agents.autoApprove.description',
    keywords: 'agents.autoApprove.keywords',
    part: 'host',
    access: 'read',
    kind: 'choice',
    options: choices(AUTO_APPROVE_LEVELS, (level) => `agents.autoApprove.level.${level}`),
    get: (file) => file.permissions.autoApprove,
  },
  // Huli: the sandbox new sessions start in. Agents read it and never change it: a change would
  // loosen what holds them back, and only the user picks a tier.
  'agents.sandbox': {
    section: 'agents',
    feature: 'sandbox',
    row: 'sandbox',
    group: 'agents.sandbox.group',
    name: 'agents.sandbox.name',
    description: 'agents.sandbox.description',
    keywords: 'agents.sandbox.keywords',
    part: 'host',
    access: 'read',
    kind: 'choice',
    options: choices(SANDBOX_TIERS, (tier) => `agents.sandbox.tier.${tier}.name`),
    get: (file) => file.sandbox.tier,
  },
  'agents.sandbox-network': {
    section: 'agents',
    feature: 'sandbox',
    row: 'sandbox-network',
    group: 'agents.sandbox.group',
    name: 'agents.sandbox.network.name',
    description: 'agents.sandbox.network.description',
    keywords: 'agents.sandbox.keywords',
    part: 'host',
    access: 'read',
    kind: 'choice',
    options: choices(SANDBOX_NETWORKS, (network) => `agents.sandbox.network.${network}`),
    get: (file) => file.sandbox.network,
  },
  'agents.sandbox-git': {
    section: 'agents',
    feature: 'sandbox',
    row: 'sandbox-git',
    group: 'agents.sandbox.group',
    name: 'agents.sandbox.git.name',
    description: 'agents.sandbox.git.description',
    keywords: 'agents.sandbox.keywords',
    part: 'host',
    access: 'read',
    kind: 'switch',
    options: ON_OFF,
    get: (file) => file.sandbox.gitWritable,
  },
  'agents.sandbox-auto-approve': {
    section: 'agents',
    feature: 'sandbox',
    row: 'sandbox-auto-approve',
    group: 'agents.sandbox.group',
    name: 'agents.sandbox.autoApprove.name',
    description: 'agents.sandbox.autoApprove.description',
    keywords: 'agents.sandbox.keywords',
    part: 'host',
    access: 'read',
    kind: 'switch',
    options: ON_OFF,
    get: (file) => file.sandbox.autoApproveEdits,
  },
  'agents.started-working': {
    section: 'agents',
    row: 'started-working',
    group: 'agents.started.group',
    name: 'agents.started.working.name',
    description: 'agents.started.working.description',
    keywords: 'agents.started.keywords',
    part: 'host',
    ...startedLimit('working'),
  },
  'agents.started-daily': {
    section: 'agents',
    row: 'started-daily',
    group: 'agents.started.group',
    name: 'agents.started.daily.name',
    description: 'agents.started.daily.description',
    keywords: 'agents.started.keywords',
    part: 'host',
    ...startedLimit('daily'),
  },
  'agents.started-reports': {
    section: 'agents',
    row: 'started-reports',
    group: 'agents.started.group',
    name: 'agents.started.reports.name',
    description: 'agents.started.reports.description',
    keywords: 'agents.started.keywords',
    part: 'host',
    ...startedLimit('reports'),
  },
  'agents.workflow-auto': {
    section: 'agents',
    row: 'workflow-auto',
    group: 'agents.workflow.auto.group',
    name: 'agents.workflow.auto.group',
    description: 'agents.workflow.auto.note',
    keywords: 'agents.workflow.keywords',
    part: 'host',
    kind: 'list',
  },
  'agents.workflow-suggest': {
    section: 'agents',
    row: 'workflow-suggest',
    group: 'agents.workflow.group',
    name: 'agents.workflow.suggest.name',
    description: 'agents.workflow.suggest.description',
    keywords: 'agents.workflow.keywords',
    part: 'host',
    kind: 'info',
  },
  'agents.workflow-steps': {
    section: 'agents',
    row: 'workflow-steps',
    group: 'agents.workflow.group',
    name: 'agents.workflow.steps.name',
    description: 'agents.workflow.steps.description',
    keywords: 'agents.workflow.keywords',
    part: 'host',
    access: 'change',
    ...pick(
      'workflow',
      'maxWorkingSteps',
      (file) => file.workflow.maxWorkingSteps,
      WORKING_STEP_LIMITS.map((n) => ({ value: n, label: { text: String(n) } })),
    ),
  },

  // ---- Manager mode (Huli): its roster and choices, the user's alone; agents never change them.
  'manager.scope': {
    section: 'manager',
    row: 'scope',
    group: 'manager.groups.scope',
    name: 'manager.scope.name',
    description: 'manager.scope.description',
    keywords: 'manager.keywords',
    part: 'desktop',
    kind: 'info',
  },
  'manager.project': {
    section: 'manager',
    row: 'project',
    group: 'manager.groups.scope',
    name: 'manager.project.name',
    description: 'manager.project.description',
    keywords: 'manager.keywords',
    part: 'desktop',
    kind: 'info',
  },
  'manager.suggestion': {
    section: 'manager',
    row: 'suggestion',
    group: 'manager.groups.manager',
    name: 'manager.suggestion.name',
    description: 'manager.suggestion.description',
    keywords: 'manager.keywords',
    part: 'desktop',
    kind: 'info',
  },
  'manager.roster': {
    section: 'manager',
    row: 'roster',
    group: 'manager.groups.roster',
    name: 'manager.groups.roster',
    description: 'manager.notes.roster',
    keywords: 'manager.keywords',
    part: 'desktop',
    kind: 'list',
  },
  'manager.auto-review': {
    section: 'manager',
    row: 'auto-review',
    group: 'manager.groups.review',
    name: 'manager.autoReview.name',
    description: 'manager.autoReview.description',
    keywords: 'manager.keywords',
    part: 'desktop',
    kind: 'info',
  },
  'manager.rounds': {
    section: 'manager',
    row: 'rounds',
    group: 'manager.groups.review',
    name: 'manager.rounds.name',
    description: 'manager.rounds.description',
    keywords: 'manager.keywords',
    part: 'desktop',
    kind: 'info',
  },
  'manager.approvals': {
    section: 'manager',
    row: 'approvals',
    group: 'manager.groups.review',
    name: 'manager.approvals.name',
    description: 'manager.approvals.description',
    keywords: 'manager.keywords',
    part: 'desktop',
    kind: 'info',
  },
  'manager.concurrent': {
    section: 'manager',
    row: 'concurrent',
    group: 'manager.groups.limits',
    name: 'manager.concurrent.name',
    description: 'manager.concurrent.description',
    keywords: 'manager.keywords',
    part: 'desktop',
    kind: 'info',
  },
  'manager.turns': {
    section: 'manager',
    row: 'turns',
    group: 'manager.groups.limits',
    name: 'manager.turns.name',
    description: 'manager.turns.description',
    keywords: 'manager.keywords',
    part: 'desktop',
    kind: 'info',
  },
  'manager.budget': {
    section: 'manager',
    row: 'budget',
    group: 'manager.groups.limits',
    name: 'manager.budget.name',
    description: 'manager.budget.description',
    keywords: 'manager.keywords',
    part: 'desktop',
    kind: 'info',
  },
  'manager.after-restart': {
    section: 'manager',
    row: 'after-restart',
    group: 'manager.groups.limits',
    name: 'manager.afterRestart.name',
    description: 'manager.afterRestart.description',
    keywords: 'manager.keywords',
    part: 'desktop',
    kind: 'info',
  },

  // ---- Harnesses
  'harnesses.installed': {
    section: 'harnesses',
    row: 'installed',
    group: 'harnesses.groups.installed',
    name: 'sections.harnesses',
    description: 'pages.harnesses',
    keywords: 'harnesses.keywords',
    part: 'host',
    kind: 'list',
  },
  'harnesses.environment': {
    section: 'harnesses',
    row: 'environment',
    name: 'agents.environment.reload',
    keywords: 'agents.environment.keywords',
    part: 'host',
    kind: 'action',
  },
  'harnesses.program': {
    section: 'harnesses',
    row: 'program',
    name: 'agentSettings.harness.program',
    part: 'host',
    kind: 'path',
    item: 'harness',
    on: isHarness,
    get: (file, item) => file.agents[item as HarnessId]?.binaryPath ?? null,
  },
  'harnesses.auto-update': {
    section: 'harnesses',
    row: 'auto-update',
    name: 'harnesses.autoUpdate.name',
    description: 'harnesses.autoUpdate.on',
    part: 'host',
    access: 'change',
    item: 'harness',
    on: isHarness,
    kind: 'switch',
    options: ON_OFF,
    get: (file, item) => file.agents[item as HarnessId]?.autoUpdate !== false,
    patch: (value, _, item) => ({
      agents: { [item as HarnessId]: { autoUpdate: value === true } },
    }),
  },
  'harnesses.install': {
    section: 'harnesses',
    row: 'install',
    name: 'agentSettings.harness.install',
    part: 'host',
    kind: 'action',
    item: 'harness',
    on: isHarness,
  },

  // ---- Memory
  'memory.enabled': {
    section: 'memory',
    row: 'enabled',
    name: 'memory.switch.name',
    description: 'memory.switch.on',
    keywords: ['memory.keywords', 'memory.switch.keywords'],
    part: 'host',
    kind: 'info',
  },
  'memory.entries': {
    section: 'memory',
    row: 'search',
    name: 'agentSettings.lists.memory',
    keywords: 'memory.keywords',
    part: 'host',
    kind: 'list',
  },

  // ---- Usage
  'usage.from-computer': {
    section: 'usage',
    row: 'from-computer',
    group: 'usage:settings.groups.sources',
    name: 'usage:settings.fromComputer.name',
    description: 'usage:settings.fromComputer.description',
    keywords: 'usage:settings.fromComputer.keywords',
    part: 'host',
    access: 'change',
    ...flag('usage', 'fromComputer', (file) => file.usage.fromComputer),
  },
  'usage.logs': {
    section: 'usage',
    row: 'from-computer',
    group: 'usage:settings.groups.logs',
    name: 'usage:settings.groups.logs',
    keywords: 'usage:settings.groups.logs',
    part: 'host',
    kind: 'list',
  },
  'usage.sidebar': {
    section: 'usage',
    row: 'sidebar',
    group: 'usage:settings.groups.display',
    name: 'usage:settings.sidebar.name',
    description: 'usage:settings.sidebar.description',
    part: 'desktop',
    access: 'change',
    ...pick(
      'usage',
      'sidebar',
      (file) => file.usage.sidebar,
      choices(['today', 'cost', 'limit', 'off'], (end) => `usage:settings.sidebar.${end}`),
    ),
  },
  'usage.clear-record': {
    section: 'usage',
    row: 'clear-record',
    group: 'usage:settings.groups.danger',
    name: 'usage:settings.clear.name',
    description: 'usage:settings.clear.description',
    part: 'host',
    kind: 'action',
  },

  // ---- Git
  'git.git': {
    section: 'git',
    row: 'git',
    group: 'git.groups.tools',
    name: 'git.git.name',
    description: 'git.git.description',
    part: 'host',
    kind: 'info',
  },
  'git.gh': {
    section: 'git',
    row: 'gh',
    group: 'git.groups.tools',
    name: 'git.gh.name',
    description: 'git.gh.description',
    keywords: 'git.gh.keywords',
    part: 'host',
    kind: 'info',
  },
  'git.fetch': {
    section: 'git',
    row: 'fetch',
    group: 'git.groups.sync',
    name: 'git.fetch.name',
    description: 'git.fetch.description',
    part: 'host',
    access: 'change',
    ...flag('git', 'backgroundFetch', (file) => file.git.backgroundFetch),
  },
  'git.worktree-root': {
    section: 'git',
    row: 'worktree-root',
    group: 'git.groups.worktrees',
    name: 'git.worktreeRoot.name',
    description: 'git.worktreeRoot.description',
    keywords: 'git.worktreeRoot.keywords',
    part: 'host',
    kind: 'path',
    get: (file) => file.git.worktreeRoot,
  },
  // Huli: where the port blocks of worktree sessions start.
  'git.worktree-ports': {
    section: 'git',
    row: 'worktree-ports',
    group: 'git.groups.worktrees',
    name: 'git.worktreePorts.name',
    description: 'git.worktreePorts.description',
    keywords: 'git.worktreePorts.keywords',
    part: 'host',
    access: 'change',
    kind: 'number',
    min: PORT_BASE_MIN,
    max: PORT_BASE_MAX,
    get: (file) => file.git.portBase,
    patch: (value) => ({ git: { portBase: Number(value) } }),
  },

  // ---- Archived
  'archived.sessions': {
    section: 'archived',
    row: 'archived',
    group: 'archived.group',
    name: 'sections.archived',
    description: 'pages.archived',
    keywords: 'archived.keywords',
    part: 'host',
    kind: 'list',
  },

  // ---- Recycle bin
  'recycle-bin.items': {
    section: 'recycle-bin',
    row: 'recycle-bin',
    group: 'recycleBin.group',
    name: 'sections.recycle-bin',
    description: 'pages.recycle-bin',
    keywords: 'recycleBin.keywords',
    part: 'host',
    kind: 'list',
  },

  // ---- Artifacts
  'artifacts.page-permissions': {
    section: 'artifacts',
    row: 'page-permissions',
    group: 'artifacts.group',
    name: 'sections.artifacts',
    description: 'pages.artifacts',
    keywords: 'artifacts.keywords',
    part: 'host',
    kind: 'list',
  },

  // ---- Sharing
  'sharing.kettu': {
    section: 'sharing',
    row: 'kettu',
    group: 'sharing.groups.kettu',
    name: 'sharing.kettu.name',
    description: 'sharing.kettu.signedOut',
    keywords: 'sharing.kettu.keywords',
    part: 'desktop',
    kind: 'info',
    on: (ctx) => ctx.desktop && ctx.cloud,
  },
  'sharing.auto': {
    section: 'sharing',
    row: 'auto',
    group: 'sharing.groups.kettu',
    name: 'sharing.auto.name',
    description: 'sharing.auto.description',
    keywords: 'sharing.auto.keywords',
    part: 'desktop',
    kind: 'info',
    on: (ctx) => ctx.desktop && ctx.cloud,
  },
  'sharing.kettu-storage': {
    section: 'sharing',
    row: 'kettu-storage',
    group: 'sharing.groups.kettu',
    name: 'sharing.kettu.storage',
    keywords: 'sharing.kettu.keywords',
    part: 'desktop',
    kind: 'info',
    on: (ctx) => ctx.desktop && ctx.cloud,
  },
  'sharing.published': {
    section: 'sharing',
    row: 'published-empty',
    group: 'sharing.groups.published',
    name: 'sharing.groups.published',
    keywords: 'sharing.published.keywords',
    part: 'desktop',
    kind: 'list',
  },
  'sharing.cloudflare': {
    section: 'sharing',
    row: 'cloudflare',
    group: 'sharing.groups.account',
    name: 'sharing.account.name',
    description: 'sharing.account.description',
    keywords: 'sharing.account.keywords',
    part: 'desktop',
    kind: 'secret',
  },

  // ---- Terminal
  'terminal.shell': {
    section: 'terminal',
    row: 'shell',
    group: 'terminal.groups.shell',
    name: 'terminal.shell.name',
    description: {
      windows: 'terminal.shell.descriptionWindows',
      other: 'terminal.shell.description',
    },
    part: 'host',
    kind: 'path',
    get: (file) => file.terminal.shellPath ?? null,
  },
  'terminal.idle-agent': {
    section: 'terminal',
    row: 'idle-agent',
    group: 'terminal.groups.agents',
    name: 'terminal.idleAgent.name',
    description: 'terminal.idleAgent.description',
    keywords: 'terminal.idleAgent.keywords',
    part: 'host',
    access: 'change',
    ...pick(
      'terminal',
      'idleAgentMinutes',
      (file) => file.terminal.idleAgentMinutes ?? DEFAULT_IDLE_TERMINAL_MINUTES,
      IDLE_TERMINAL_MINUTES.map((minutes) => ({
        value: minutes,
        label:
          minutes === 0
            ? { key: 'terminal.idleAgent.off' }
            : { key: 'terminal.idleAgent.after', params: { count: String(minutes) } },
      })),
    ),
  },
  'terminal.font-family': {
    section: 'terminal',
    row: 'font-family',
    group: 'terminal.groups.display',
    name: 'terminal.fontFamily.name',
    description: 'terminal.fontFamily.description',
    keywords: 'terminal.fontFamily.keywords',
    part: 'desktop',
    access: 'change',
    kind: 'text',
    chars: MAX_FONT_FAMILY_CHARS,
    check: (value) => value === '' || isFontFamilyName(value),
    get: (file) => file.terminal.fontFamily ?? null,
    patch: (value) => ({
      terminal: { fontFamily: value === '' || value === null ? null : String(value) },
    }),
  },
  'terminal.font-size': {
    section: 'terminal',
    row: 'font-size',
    group: 'terminal.groups.display',
    name: 'terminal.fontSize.name',
    description: 'terminal.fontSize.description',
    part: 'desktop',
    access: 'change',
    ...pick(
      'terminal',
      'fontSize',
      (file) => file.terminal.fontSize,
      [12, 13, 14].map((size) => ({ value: size, label: { text: `${size}` } })),
    ),
  },

  // ---- Remote access
  'remote.remote': {
    section: 'remote',
    row: 'remote',
    name: 'remote.switch',
    description: 'pages.remote',
    keywords: 'remote.keywords',
    part: 'host',
    access: 'ask',
    warning: 'agentSettings.warning.remote',
    ...flag('remote', 'enabled', (file) => file.remote.enabled),
  },
  'remote.host-name': {
    section: 'remote',
    row: 'host-name',
    name: 'remote.hostName.name',
    description: 'remote.hostName.description',
    part: 'host',
    access: 'change',
    kind: 'text',
    chars: 64,
    get: (file) => file.remote.name,
    patch: (value) => ({ remote: { name: value === '' || value === null ? null : String(value) } }),
  },
  'remote.devices': {
    section: 'remote',
    row: 'add-device',
    group: 'remote.devices.group',
    name: 'remote.devices.group',
    keywords: 'remote.keywords',
    part: 'host',
    kind: 'list',
  },
  'remote.add-device': {
    section: 'remote',
    row: 'add-device',
    group: 'remote.devices.group',
    name: 'remote.devices.add',
    keywords: 'remote.keywords',
    part: 'host',
    kind: 'action',
  },
  'remote.direct': {
    section: 'remote',
    row: 'direct',
    group: 'remote.direct.group',
    name: 'remote.direct.name',
    description: 'remote.direct.descriptionFree',
    keywords: 'remote.direct.keywords',
    part: 'host',
    access: 'ask',
    warning: 'agentSettings.warning.direct',
    kind: 'switch',
    options: ON_OFF,
    get: (file) => file.remote.direct.enabled,
    patch: (value) => ({ remote: { direct: { enabled: value === true } } }),
  },
  'remote.direct-port': {
    section: 'remote',
    row: 'direct-port',
    group: 'remote.direct.group',
    name: 'remote.direct.port.name',
    description: 'remote.direct.port.description',
    keywords: 'remote.direct.keywords',
    part: 'host',
    access: 'ask',
    warning: 'agentSettings.warning.direct',
    kind: 'number',
    min: 1024,
    max: 65535,
    get: (file) => file.remote.direct.port,
    patch: (value) => ({ remote: { direct: { port: Number(value) } } }),
  },
  'remote.direct-found': {
    section: 'remote',
    row: 'direct-found',
    group: 'remote.direct.group',
    name: 'remote.direct.found.name',
    description: 'remote.direct.found.description',
    keywords: 'remote.direct.keywords',
    part: 'host',
    kind: 'list',
  },
  'remote.direct-own': {
    section: 'remote',
    row: 'direct-own',
    group: 'remote.direct.group',
    name: 'remote.direct.own.name',
    description: 'remote.direct.own.description',
    keywords: 'remote.direct.keywords',
    part: 'host',
    kind: 'list',
    get: (file) => file.remote.direct.addresses.length,
  },
  'remote.terminal': {
    section: 'remote',
    row: 'terminal',
    group: 'remote.groups.permissions',
    name: 'remote.terminal.name',
    description: 'remote.terminal.description',
    keywords: 'remote.terminal.keywords',
    part: 'host',
    access: 'ask',
    warning: 'agentSettings.warning.terminal',
    ...flag('remote', 'terminal', (file) => file.remote.terminal),
  },
  'remote.discoverable': {
    section: 'remote',
    row: 'discoverable',
    group: 'remote.groups.permissions',
    name: 'remote.discoverable.name',
    description: 'remote.discoverable.description',
    keywords: 'remote.discoverable.keywords',
    part: 'host',
    access: 'ask',
    warning: 'agentSettings.warning.discoverable',
    on: (ctx) => ctx.cloud,
    ...flag('remote', 'discoverable', (file) => file.remote.discoverable),
  },
  'remote.relay': {
    section: 'remote',
    row: 'relay',
    group: 'remote.groups.relay',
    name: 'remote.relay.group',
    description: 'remote.relay.groupDescription',
    keywords: 'remote.relay.keywords',
    part: 'host',
    access: 'ask',
    warning: 'agentSettings.warning.relay',
    kind: 'choice',
    // Your own relay is chosen once its check passed, which Use this relay runs.
    options: (ctx) =>
      choices(
        ctx.cloud ? ['kettu', 'own', 'off'] : ['own', 'off'],
        (value) => `remote.relay.choice.${value}.name`,
      ),
    get: (file) => file.remote.relay,
    patch: (value) => ({ remote: { relay: value as RelayChoice } }),
  },
  'remote.relay-regions': {
    section: 'remote',
    row: 'relay-regions',
    group: 'remote.groups.relay',
    name: 'remote.relay.regions',
    description: 'remote.relay.regionsDescription',
    keywords: 'remote.relay.keywords',
    part: 'host',
    kind: 'info',
    on: (ctx) => ctx.cloud,
  },
  'remote.reset': {
    section: 'remote',
    row: 'reset-environment',
    group: 'remote.groups.danger',
    name: 'remote.reset.name',
    description: 'remote.reset.description',
    keywords: 'remote.reset.keywords',
    part: 'host',
    kind: 'action',
  },

  // ---- Plugins
  'plugins.switch': pluginSetting('boolean', {
    access: 'change',
    kind: 'switch',
    options: ON_OFF,
  }),
  'plugins.choice': pluginSetting('select', {
    access: 'change',
    kind: 'choice',
    options: (ctx, item) =>
      (pluginSettingOf(ctx, item)?.setting.options ?? []).map((option) => ({
        value: option.value,
        label: { text: option.title },
      })),
  }),
  'plugins.text': pluginSetting('string', {
    access: 'change',
    kind: 'text',
    chars: PLUGIN_SETTING_CHARS,
  }),
  'plugins.secret': pluginSetting('secret', { kind: 'secret' }),

  // ---- Advanced
  'advanced.proxy': {
    section: 'advanced',
    row: 'proxy',
    group: 'advanced.groups.network',
    name: 'advanced.proxy.name',
    description: 'advanced.proxy.description',
    keywords: 'advanced.proxy.keywords',
    part: 'host',
    access: 'ask',
    warning: 'agentSettings.warning.proxy',
    kind: 'text',
    chars: 2048,
    // A proxy with a password is set on the page, so none goes through an agent or its thread.
    check: (value) => value === '' || !hasCredentials(value),
    get: (file) => (file.proxy.mode === 'custom' ? withoutPassword(file.proxy.url) : ''),
    patch: (value, file) => {
      const url = typeof value === 'string' ? value.trim() : ''
      if (url === '') return { proxy: { mode: 'environment' } }
      const noProxy = file.proxy.mode === 'custom' ? file.proxy.noProxy : ''
      return { proxy: { mode: 'custom', url, noProxy } }
    },
  },
  // Huli: the loopback port routines' webhooks listen on.
  'advanced.webhook-port': {
    section: 'advanced',
    row: 'webhook-port',
    group: 'advanced.groups.network',
    name: 'advanced.webhookPort.name',
    description: 'advanced.webhookPort.description',
    keywords: 'advanced.webhookPort.keywords',
    part: 'host',
    access: 'ask',
    kind: 'number',
    min: WEBHOOK_PORT_MIN,
    max: WEBHOOK_PORT_MAX,
    get: (file) => file.webhooks.port,
    patch: (value) => ({ webhooks: { port: Number(value) } }),
  },
  'advanced.report': {
    section: 'advanced',
    row: 'report',
    group: 'advanced.groups.data',
    name: 'advanced.report.name',
    description: 'advanced.report.description',
    keywords: 'advanced.report.keywords',
    part: 'host',
    kind: 'action',
  },
  'advanced.logs': {
    section: 'advanced',
    row: 'logs',
    group: 'advanced.groups.data',
    name: 'advanced.logs.name',
    description: 'advanced.logs.description',
    keywords: 'advanced.logs.keywords',
    part: 'desktop',
    kind: 'action',
  },
  'advanced.record-steps': {
    section: 'advanced',
    row: 'record-steps',
    group: 'advanced.groups.data',
    name: 'advanced.record.name',
    description: 'advanced.record.description',
    keywords: 'advanced.record.keywords',
    part: 'desktop',
    kind: 'action',
  },
  'advanced.detailed-records': {
    section: 'advanced',
    row: 'detailed-records',
    group: 'advanced.groups.data',
    name: 'advanced.detailedRecords.name',
    description: 'advanced.detailedRecords.description',
    keywords: 'advanced.detailedRecords.keywords',
    part: 'desktop',
    kind: 'info',
    get: (file) => file.diagnostics.verboseUntil !== null,
  },
  'advanced.debug-mode': {
    section: 'advanced',
    row: 'debug-mode',
    group: 'advanced.groups.data',
    name: 'advanced.debugMode.name',
    description: 'advanced.debugMode.description',
    keywords: 'advanced.debugMode.keywords',
    part: 'desktop',
    kind: 'action',
  },
  'advanced.data-folder': {
    section: 'advanced',
    row: 'data-folder',
    group: 'advanced.groups.data',
    name: 'advanced.dataFolder.name',
    description: 'advanced.dataFolder.description',
    part: 'host',
    kind: 'path',
  },
  'advanced.remove-sessions': {
    section: 'advanced',
    row: 'remove-sessions',
    group: 'advanced.groups.danger',
    name: 'advanced.removeSessions.name',
    description: 'advanced.removeSessions.description',
    keywords: 'advanced.removeSessions.keywords',
    part: 'host',
    kind: 'action',
  },

  // ---- About
  'about.update': {
    section: 'about',
    row: 'update',
    group: 'about.groups.updates',
    name: 'about.updates.name',
    keywords: 'about.updates.keywords',
    part: 'host',
    kind: 'info',
  },
  'about.automatic': {
    section: 'about',
    row: 'automatic',
    group: 'about.groups.updates',
    name: 'about.automatic.name',
    description: 'about.automatic.description',
    part: 'desktop',
    access: 'change',
    ...pick(
      'updates',
      'automatic',
      (file) => file.updates.automatic,
      choices(['download', 'restart', 'notify', 'off'], (mode) => `about.automatic.${mode}`),
    ),
  },
  'about.source': {
    section: 'about',
    row: 'source',
    group: 'about.groups.updates',
    name: 'about.source.name',
    description: 'about.source.autoDetail',
    keywords: 'about.source.keywords',
    part: 'desktop',
    access: 'ask',
    warning: 'agentSettings.warning.source',
    // Huli: Kite updates from its own channel alone, so the page has no such row.
    on: () => false,
    ...pick(
      'updates',
      'source',
      (file) => file.updates.source,
      choices(['auto', 'github'], (source) => `about.source.${source}`),
    ),
  },
  'about.issues': {
    section: 'about',
    row: 'issues',
    group: 'about.groups.contact',
    name: 'about.issues.name',
    description: 'about.issues.description',
    keywords: 'about.issues.keywords',
    part: 'host',
    kind: 'action',
  },
  'about.github': {
    section: 'about',
    row: 'github',
    name: 'about.github.name',
    keywords: 'about.github.keywords',
    part: 'host',
    kind: 'action',
  },

  // ---- Huli: Kite's own rows; see tools/huli/README.md.
  'agents.reset-environment': {
    section: 'agents',
    row: 'reset-environment',
    name: 'agents.resetEnv.name',
    description: 'agents.resetEnv.description',
    keywords: 'agents.resetEnv.keywords',
    part: 'host',
    kind: 'action',
    item: 'agent',
    on: isAgent,
  },
  'general.agent-history': {
    section: 'general',
    row: 'agent-history',
    group: 'agentHistory:row.group',
    name: 'agentHistory:row.name',
    description: 'agentHistory:row.description',
    keywords: 'agentHistory:row.keywords',
    part: 'desktop',
    kind: 'action',
  },
  'general.resume-after-limit': {
    section: 'general',
    row: 'resume-after-limit',
    group: 'general.groups.sessions',
    name: 'general.resumeAfterLimit.name',
    description: 'general.resumeAfterLimit.description',
    keywords: 'general.resumeAfterLimit.keywords',
    part: 'host',
    access: 'change',
    ...flag('supervisor', 'resumeAfterLimit', (file) => file.supervisor.resumeAfterLimit),
  },
  'general.resume-text': {
    section: 'general',
    row: 'resume-text',
    group: 'general.groups.sessions',
    name: 'general.resumeText.name',
    description: 'general.resumeText.description',
    keywords: 'general.resumeText.keywords',
    part: 'host',
    access: 'change',
    kind: 'text',
    chars: RESUME_TEXT_CHARS,
    get: (file) => file.supervisor.resumeText,
    patch: (value) => ({ supervisor: { resumeText: value === null ? '' : String(value).trim() } }),
  },
  'general.stall-minutes': {
    section: 'general',
    row: 'stall-minutes',
    group: 'general.groups.sessions',
    name: 'general.stallMinutes.name',
    description: 'general.stallMinutes.description',
    keywords: 'general.stallMinutes.keywords',
    part: 'host',
    access: 'change',
    ...pick(
      'supervisor',
      'stallMinutes',
      (file) => file.supervisor.stallMinutes,
      STALL_MINUTES.map((minutes) => ({
        value: minutes,
        label:
          minutes === 0
            ? { key: 'general.stallMinutes.off' }
            : { key: 'general.stallMinutes.after', params: { count: String(minutes) } },
      })),
    ),
  },
  'general.auto-settle': {
    section: 'general',
    row: 'auto-settle',
    group: 'general.groups.sessions',
    name: 'general.autoSettle.name',
    description: 'general.autoSettle.description',
    keywords: 'general.autoSettle.keywords',
    part: 'host',
    access: 'change',
    feature: 'sessionTidy',
    ...flag('tidy', 'autoSettle', (file) => file.tidy.autoSettle),
  },
  'general.settle-days': {
    section: 'general',
    row: 'settle-days',
    group: 'general.groups.sessions',
    name: 'general.settleDays.name',
    description: 'general.settleDays.description',
    keywords: 'general.settleDays.keywords',
    part: 'host',
    access: 'change',
    feature: 'sessionTidy',
    ...pick(
      'tidy',
      'idleDays',
      (file) => file.tidy.idleDays,
      SETTLE_DAYS.map((days) => ({
        value: days,
        label: { key: 'general.settleDays.after', params: { count: String(days) } },
      })),
    ),
  },
  'general.settle-merged': {
    section: 'general',
    row: 'settle-merged',
    group: 'general.groups.sessions',
    name: 'general.settleMerged.name',
    description: 'general.settleMerged.description',
    keywords: 'general.settleMerged.keywords',
    part: 'host',
    access: 'change',
    feature: 'sessionTidy',
    ...flag('tidy', 'merged', (file) => file.tidy.merged),
  },
  // Huli: how long the recycle bin keeps what was deleted; a shorter keep asks, as it loses data.
  'general.bin-keep-days': {
    section: 'general',
    row: 'bin-keep-days',
    group: 'general.groups.recycleBin',
    name: 'general.binKeepDays.name',
    description: 'general.binKeepDays.description',
    keywords: 'general.binKeepDays.keywords',
    part: 'host',
    access: 'ask',
    ...pick('recycleBin', 'keepDays', (file) => file.recycleBin.keepDays, [
      ...BIN_KEEP_DAYS.map((days) => ({
        value: days,
        label: { key: 'general.binKeepDays.days', params: { count: String(days) } },
      })),
      { value: null, label: { key: 'general.binKeepDays.never' } },
    ]),
  },
  'account.huli-this-computer': {
    section: 'account',
    row: 'huli-this-computer',
    name: 'huliAccount:thisComputer.name',
    description: 'huliAccount:thisComputer.description',
    keywords: 'huliAccount:thisComputer.keywords',
    part: 'desktop',
    kind: 'info',
  },
  'account.huli-computers': {
    section: 'account',
    row: 'huli-computers',
    group: 'huliAccount:computers.name',
    name: 'huliAccount:computers.name',
    description: 'huliAccount:computers.description',
    keywords: 'huliAccount:computers.keywords',
    part: 'desktop',
    kind: 'list',
  },
  'account.huli-devices': {
    section: 'account',
    row: 'huli-devices',
    group: 'huliAccount:devices.name',
    name: 'huliAccount:devices.name',
    description: 'huliAccount:devices.description',
    keywords: 'huliAccount:devices.keywords',
    part: 'desktop',
    kind: 'list',
  },
  'advanced.storage': {
    section: 'advanced',
    row: 'storage',
    group: 'advanced.groups.data',
    name: 'advanced.storage.name',
    description: 'advanced.storage.description',
    keywords: 'advanced.storage.keywords',
    part: 'host',
    kind: 'info',
  },
  'advanced.backup': {
    section: 'advanced',
    row: 'backup',
    group: 'advanced.groups.data',
    name: 'advanced.backup.name',
    description: 'advanced.backup.description',
    keywords: 'backup.enabled.keywords',
    part: 'desktop',
    kind: 'action',
  },
  'agent-network.enabled': {
    section: 'agent-network',
    row: 'enabled',
    group: 'network.groups.main',
    name: 'network.enabled.name',
    description: 'network.enabled.description',
    keywords: 'network.enabled.keywords',
    part: 'host',
    kind: 'info',
  },
  'agent-network.status': {
    section: 'agent-network',
    row: 'status',
    group: 'network.groups.main',
    name: 'network.status.name',
    part: 'host',
    kind: 'info',
  },
  'agent-network.interface': {
    section: 'agent-network',
    row: 'interface',
    group: 'network.groups.main',
    name: 'network.interface.name',
    description: 'network.interface.description',
    keywords: 'network.interface.keywords',
    part: 'host',
    kind: 'info',
  },
  'agent-network.subscriptions': {
    section: 'agent-network',
    row: 'subscriptions',
    group: 'network.groups.subscriptions',
    name: 'network.groups.subscriptions',
    description: 'network.subscriptions.emptyHint',
    keywords: 'network.subscriptions.keywords',
    part: 'host',
    kind: 'list',
  },
  'agent-network.default-node': {
    section: 'agent-network',
    row: 'default-node',
    group: 'network.groups.default',
    name: 'network.default.name',
    description: 'network.default.description',
    keywords: 'network.default.keywords',
    part: 'host',
    kind: 'info',
  },
  'agent-network.interfaces': {
    section: 'agent-network',
    row: 'interfaces',
    group: 'network.groups.interfaces',
    name: 'network.groups.interfaces',
    description: 'network.interfaces.description',
    keywords: 'network.interfaces.keywords',
    part: 'host',
    kind: 'list',
  },
  'agent-network.agents': {
    section: 'agent-network',
    row: 'agents',
    group: 'network.groups.agents',
    name: 'network.choice.name',
    description: 'network.choice.description',
    keywords: 'network.choice.keywords',
    part: 'host',
    kind: 'list',
  },
  'backup.enabled': {
    section: 'backup',
    row: 'enabled',
    group: 'backup.groups.schedule',
    name: 'backup.enabled.name',
    description: 'backup.enabled.description',
    keywords: 'backup.enabled.keywords',
    part: 'desktop',
    access: 'change',
    ...flag('backup', 'enabled', (file) => file.backup.enabled),
  },
  'backup.time': {
    section: 'backup',
    row: 'time',
    group: 'backup.groups.schedule',
    name: 'backup.time.name',
    description: 'backup.time.description',
    keywords: 'backup.time.keywords',
    part: 'desktop',
    access: 'change',
    kind: 'text',
    chars: 5,
    check: isBackupTime,
    get: (file) => file.backup.time,
    patch: (value) => ({ backup: { time: String(value) } }),
  },
  'backup.keep': {
    section: 'backup',
    row: 'keep',
    group: 'backup.groups.schedule',
    name: 'backup.keep.name',
    description: 'backup.keep.description',
    keywords: 'backup.keep.keywords',
    part: 'desktop',
    access: 'change',
    kind: 'number',
    min: BACKUP_KEEP_MIN,
    max: BACKUP_KEEP_MAX,
    get: (file) => file.backup.keep,
    patch: (value) => ({ backup: { keep: Number(value) } }),
  },
  'backup.status': {
    section: 'backup',
    row: 'status',
    group: 'backup.groups.schedule',
    name: 'backup.status.name',
    keywords: 'backup.status.keywords',
    part: 'desktop',
    kind: 'info',
  },
  'backup.folder': {
    section: 'backup',
    row: 'folder',
    group: 'backup.groups.folder',
    name: 'backup.folder.name',
    description: 'backup.folder.description',
    keywords: 'backup.folder.keywords',
    part: 'desktop',
    kind: 'path',
    get: (file) => file.backup.folder,
  },
  'backup.restore': {
    section: 'backup',
    row: 'restore',
    group: 'backup.groups.restore',
    name: 'backup.restore.name',
    description: 'backup.restore.description',
    keywords: 'backup.restore.keywords',
    part: 'desktop',
    kind: 'action',
  },
  'chat-bridge.feishu': {
    section: 'chat-bridge',
    row: 'feishu',
    group: 'chatBridge.platforms.feishu',
    name: 'chatBridge.platforms.feishu',
    description: 'chatBridge.connection.description',
    keywords: 'chatBridge.keywords',
    part: 'desktop',
    kind: 'info',
  },
  'chat-bridge.feishu-accounts': {
    section: 'chat-bridge',
    row: 'feishu-accounts',
    group: 'chatBridge.platforms.feishu',
    name: 'chatBridge.accounts.name',
    description: 'chatBridge.accounts.description',
    keywords: 'chatBridge.keywords',
    part: 'desktop',
    kind: 'list',
  },
  'chat-bridge.dingtalk': {
    section: 'chat-bridge',
    row: 'dingtalk',
    group: 'chatBridge.platforms.dingtalk',
    name: 'chatBridge.platforms.dingtalk',
    description: 'chatBridge.connection.description',
    keywords: 'chatBridge.keywords',
    part: 'desktop',
    kind: 'info',
  },
  'chat-bridge.dingtalk-accounts': {
    section: 'chat-bridge',
    row: 'dingtalk-accounts',
    group: 'chatBridge.platforms.dingtalk',
    name: 'chatBridge.accounts.name',
    description: 'chatBridge.accounts.description',
    keywords: 'chatBridge.keywords',
    part: 'desktop',
    kind: 'list',
  },
  'chat-bridge.wecom': {
    section: 'chat-bridge',
    row: 'wecom',
    group: 'chatBridge.platforms.wecom',
    name: 'chatBridge.platforms.wecom',
    description: 'chatBridge.connection.description',
    keywords: 'chatBridge.keywords',
    part: 'desktop',
    kind: 'info',
  },
  'chat-bridge.wecom-accounts': {
    section: 'chat-bridge',
    row: 'wecom-accounts',
    group: 'chatBridge.platforms.wecom',
    name: 'chatBridge.accounts.name',
    description: 'chatBridge.accounts.description',
    keywords: 'chatBridge.keywords',
    part: 'desktop',
    kind: 'list',
  },
  'chat-bridge.qq': {
    section: 'chat-bridge',
    row: 'qq',
    group: 'chatBridge.platforms.qq',
    name: 'chatBridge.platforms.qq',
    description: 'chatBridge.connection.description',
    keywords: 'chatBridge.keywords',
    part: 'desktop',
    kind: 'info',
  },
  'chat-bridge.qq-accounts': {
    section: 'chat-bridge',
    row: 'qq-accounts',
    group: 'chatBridge.platforms.qq',
    name: 'chatBridge.accounts.name',
    description: 'chatBridge.accounts.description',
    keywords: 'chatBridge.keywords',
    part: 'desktop',
    kind: 'list',
  },
  'chat-bridge.telegram': {
    section: 'chat-bridge',
    row: 'telegram',
    group: 'chatBridge.platforms.telegram',
    name: 'chatBridge.platforms.telegram',
    description: 'chatBridge.connection.description',
    keywords: 'chatBridge.keywords',
    part: 'desktop',
    kind: 'info',
  },
  'chat-bridge.telegram-accounts': {
    section: 'chat-bridge',
    row: 'telegram-accounts',
    group: 'chatBridge.platforms.telegram',
    name: 'chatBridge.accounts.name',
    description: 'chatBridge.accounts.description',
    keywords: 'chatBridge.keywords',
    part: 'desktop',
    kind: 'list',
  },
  ...FEATURE_ENTRIES,
  ...SHORTCUT_ENTRIES,
  'shortcuts.screenshot': {
    section: 'shortcuts',
    row: 'screenshot',
    group: 'shortcuts.groups.global',
    name: 'shortcuts.screenshot.name',
    description: 'shortcuts.screenshot.description',
    keywords: 'shortcuts.screenshot.keywords',
    part: 'desktop',
    kind: 'info',
    get: (file) => file.keyboard?.screenshot ?? null,
  },
  'shortcuts.fixed': {
    section: 'shortcuts',
    row: 'fixed',
    group: 'shortcuts.groups.fixed',
    name: 'shortcuts.fixed.name',
    description: 'shortcuts.fixed.description',
    keywords: 'shortcuts.keywords',
    part: 'desktop',
    kind: 'info',
  },
  'features.computer-use': {
    section: 'features',
    row: 'computer-use',
    group: 'features.groups.agents',
    name: 'features.computerUse.name',
    description: 'features.computerUse.description',
    keywords: 'features.keywords',
    part: 'desktop',
    kind: 'action',
  },
  // Huli: Kettu's next-message suggestions keep their switch in General; this row leads there.
  'features.prompt-suggestions': {
    section: 'features',
    row: 'prompt-suggestions',
    group: 'features.groups.work',
    name: 'features.promptSuggestions.name',
    description: 'features.promptSuggestions.description',
    keywords: 'general.promptSuggestions.keywords',
    part: 'desktop',
    kind: 'action',
  },
  // Huli: administrator use lives on computer use's page; this row says how it stands and leads there.
  'features.computer-elevated': {
    section: 'features',
    row: 'computer-elevated',
    group: 'features.groups.agents',
    name: 'features.computerElevated.name',
    description: 'features.computerElevated.description',
    keywords: 'computer.elevated.keywords',
    part: 'desktop',
    on: (ctx) => ctx.desktop && ctx.platform === 'win32',
    kind: 'action',
  },
} as const satisfies Record<string, CatalogEntry>

export type SettingId = keyof typeof ENTRIES

export const CATALOG: Readonly<Record<SettingId, CatalogEntry>> = ENTRIES

export function isSettingId(value: unknown): value is SettingId {
  return typeof value === 'string' && Object.hasOwn(ENTRIES, value)
}

/** Whether agents may change a row at all, as the mode allows or always asking. */
export function changeable(entry: CatalogEntry): boolean {
  return (
    (entry.access === 'change' || entry.access === 'ask' || entry.access === 'raise') &&
    (entry.patch !== undefined || entry.store === 'plugin') &&
    (entry.kind === 'switch' ||
      entry.kind === 'choice' ||
      entry.kind === 'number' ||
      entry.kind === 'text')
  )
}

/** Whether changing a row from one value to another asks the user in every mode, Full access too. */
export function asksAlways(entry: CatalogEntry, from: SettingScalar, to: SettingScalar): boolean {
  if (entry.access === 'ask') return true
  if (entry.access !== 'raise') return false
  return typeof to === 'number' && (typeof from !== 'number' || to > from)
}

/** A row's search words, as one key or several. */
export function keywordKeys(entry: CatalogEntry): readonly TextKey[] {
  return entry.keywords === undefined
    ? []
    : typeof entry.keywords === 'string'
      ? [entry.keywords]
      : entry.keywords
}

/** The text for the host's system: Dock on macOS, taskbar elsewhere. */
export function platformKey(text: EntryText, platform: Platform): TextKey {
  if (typeof text === 'string') return text
  if (platform === 'darwin') return text.mac ?? text.other
  if (platform === 'win32') return text.windows ?? text.other
  if (platform === 'linux') return text.linux ?? text.other
  return text.other
}

/** An option label's words for the host's system, when they are not a catalog key. */
export function optionWords(label: OptionLabel, platform: Platform): string | null {
  if ('text' in label) return label.text
  if ('platform' in label) {
    const key = platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'linux'
    return label.platform[key] ?? label.platform.other
  }
  return null
}

/** The choices a row takes now, static or from the host's agents. */
export function optionsOf(
  entry: CatalogEntry,
  ctx: CatalogContext,
  item: string | null,
): SettingOption[] {
  if (!entry.options) return []
  return typeof entry.options === 'function' ? entry.options(ctx, item) : [...entry.options]
}

/** The words of a row whose plugin wrote them; undefined for a row that has the catalog's. */
export function literalWords(
  entry: CatalogEntry,
  ctx: CatalogContext,
  item: string | null,
): { name: string; description?: string } | undefined {
  return entry.literal?.(ctx, item)
}

/** Where the page shows a row: its section's page, or the item's page with the row on it. */
export function rowTarget(
  entry: CatalogEntry,
  item: string | null,
): { item: string | null; row: string } {
  return entry.target ? entry.target(item) : { item, row: entry.row }
}

/** A row's id as the tools name it: `section.row`, with `:item` for an agent's or a harness's. */
export function toolId(id: SettingId, item: string | null): string {
  return item === null ? id : `${id}:${item}`
}

export function parseToolId(value: string): { id: SettingId; item: string | null } | null {
  const at = value.indexOf(':')
  const id = at < 0 ? value : value.slice(0, at)
  const item = at < 0 ? null : value.slice(at + 1)
  if (!isSettingId(id)) return null
  const entry = CATALOG[id]
  if ((entry.item === undefined) !== (item === null)) return null
  if (item !== null && item.length === 0) return null
  return { id, item }
}

/** Whether the host has the row: its part applies there, and it is on for its system and item. */
export function present(entry: CatalogEntry, ctx: CatalogContext, item: string | null): boolean {
  if (entry.part === 'desktop' && !ctx.desktop) return false
  const feature = entry.feature ?? SECTION_FEATURES[entry.section]
  if (feature && !featureOn(ctx.features, feature)) return false
  return entry.on?.(ctx, item) ?? true
}

/** Every row the host has, each agent's and each harness's once per item. */
export function presentRows(ctx: CatalogContext): { id: SettingId; item: string | null }[] {
  const rows: { id: SettingId; item: string | null }[] = []
  for (const id of Object.keys(ENTRIES) as SettingId[]) {
    const entry = CATALOG[id]
    const items =
      entry.item === 'agent'
        ? ctx.agents.map((agent) => agent.id as string)
        : entry.item === 'harness'
          ? ctx.harnesses.map((harness) => harness.id as string)
          : entry.item === 'plugin'
            ? ctx.plugins.flatMap((plugin) =>
                plugin.settings.map((setting) => `${plugin.id}:${setting.key}`),
              )
            : [null]
    for (const item of items) if (present(entry, ctx, item)) rows.push({ id, item })
  }
  return rows
}

/** Whether a start mode is Full access, which a row that sets one names on its card. */
export function namesFullAccess(value: SettingScalar): boolean {
  return typeof value === 'string' && isFullAccessMode(value)
}

/**
 * A value the agent gave, as the row takes it, or why not: a choice must be one of its values, a
 * switch true or false, a number whole and within bounds, a text within its length and check.
 */
export function coerce(
  entry: CatalogEntry,
  ctx: CatalogContext,
  item: string | null,
  value: unknown,
): { value: SettingScalar } | { error: string } {
  switch (entry.kind) {
    case 'switch': {
      if (value === true || value === 'on' || value === 'true') return { value: true }
      if (value === false || value === 'off' || value === 'false') return { value: false }
      return { error: 'takes true or false' }
    }
    case 'choice': {
      const options = optionsOf(entry, ctx, item)
      const found = options.find(
        (option) =>
          option.value === value ||
          (value !== null && typeof option.value === 'number' && Number(value) === option.value) ||
          (option.value === null && (value === 'null' || value === undefined)),
      )
      if (found) return { value: found.value }
      return {
        error: `takes one of ${options.map((option) => JSON.stringify(option.value)).join(', ')}`,
      }
    }
    case 'number': {
      const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
      if (
        typeof number !== 'number' ||
        !Number.isInteger(number) ||
        (entry.min !== undefined && number < entry.min) ||
        (entry.max !== undefined && number > entry.max)
      ) {
        return { error: `takes a whole number from ${entry.min} to ${entry.max}` }
      }
      return { value: number }
    }
    case 'text': {
      if (value === null) return { value: '' }
      if (typeof value !== 'string') return { error: 'takes a text' }
      const text = value.trim()
      if (entry.chars !== undefined && text.length > entry.chars) {
        return { error: `takes at most ${entry.chars} characters` }
      }
      if (entry.check && !entry.check(text)) return { error: 'does not take that text' }
      return { value: text }
    }
    default:
      return { error: 'cannot be changed by agents' }
  }
}

/** Two values read the same, as a change that would leave a row as it is. */
export function sameValue(a: SettingScalar, b: SettingScalar): boolean {
  return a === b || ((a === null || a === '') && (b === null || b === ''))
}

/** Merges patches in order, the later winning key by key, lists and `proxy` replaced whole. */
export function mergePatches(patches: readonly SettingsPatch[]): SettingsPatch {
  const merged: Record<string, unknown> = {}
  for (const patch of patches) {
    for (const [section, value] of Object.entries(patch)) {
      const held = merged[section]
      merged[section] =
        isRecord(held) && isRecord(value) && section !== 'proxy' ? deepMerge(held, value) : value
    }
  }
  return merged as SettingsPatch
}

/** Whether a URL carries a user name or password. */
export function hasCredentials(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(url.trim())
}

/** A URL with any password in it hidden. */
function withoutPassword(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^:/?#@]*):[^/?#@]*@/i, '$1:•••@')
}

/** Whether agents may change the row now: a proxy that has a password they may not. */
export function lockedNow(id: SettingId, file: SettingsFile): boolean {
  return id === 'advanced.proxy' && file.proxy.mode === 'custom' && hasCredentials(file.proxy.url)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a }
  for (const [key, value] of Object.entries(b)) {
    const held = out[key]
    out[key] = isRecord(held) && isRecord(value) ? deepMerge(held, value) : value
  }
  return out
}
