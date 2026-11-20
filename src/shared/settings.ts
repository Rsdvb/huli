import { DEFAULT_AGENT_NETWORK, type AgentNetworkSettings } from './agent-network'
import type { ComputerUseSettings } from './computer-use'
import type { IdleSessionsSettings } from './idle-release'
import type { LanguageSetting, Locale } from './locale'
import type { MarketServer, MarketSkill } from './marketplace'
import type { DirectAddress } from './remote/protocol'
import { BUILTIN_THEME_ID } from './themes'
import type { AgentId, HarnessId } from './thread'

/** Whether a host's first start has run, so it runs once. */
export interface InitialSetup {
  done: boolean
}

/** The first-run onboarding's steps, in order; Sign in only follows the Kettu account choice. */
export const ONBOARDING_STEPS = ['welcome', 'choose', 'sign-in', 'agents'] as const
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]

/** Where the first-run onboarding stands: a fresh install starts it, an upgraded one skips it. */
export interface OnboardingState {
  done: boolean
  step: OnboardingStep // where an unfinished onboarding resumes
}

/** What New session lists under the input: recent sessions, the latest artifacts, or nothing. */
export const NEW_SESSION_LISTS = ['sessions', 'artifacts', 'off'] as const
export type NewSessionList = (typeof NEW_SESSION_LISTS)[number]

export interface SettingsFile {
  version: 1
  agentRegistrationVersion?: 1
  /** Set once direct connections were turned on for a host that already had remote access on. */
  remoteDirectVersion?: 1
  initialSetup: InitialSetup
  general: {
    language: LanguageSetting
    defaultAgent: AgentId | null // null: pick one on the New session screen each time
    sendKey: 'enter' | 'mod-enter' // the other key inserts a newline
    restoreLastSession: boolean
    newSessionList: NewSessionList // what New session lists under the input
    confirmQuitWhileRunning: boolean
    openAtLogin: boolean // start at login, so routines keep their schedule
    background: boolean // keep running with the tray icon after the last window closes
    sessionTitles: boolean // a small model titles a session its agent leaves untitled
    claudeTestEntrypoint: boolean
    claudeTestEntrypointLabel: string
    // By Claude Code agent; an agent without an entry runs with no fallback and no budget.
    // Replaced whole.
    claudeRuns: Partial<Record<AgentId, ClaudeRunSettings>>
    promptSuggestions: boolean // Claude Code's sessions predict the next prompt for the composer
  }
  thread: {
    outlineSummaries: boolean // a small model titles the outline's messages
    confirmLinks: boolean // ask before opening a site that has no `alwaysOpenIn` entry
    openLinksIn: OpenLinksIn // where a click on a link in a reply opens it
    // By site: its registrable domain, or the whole host when that is the domain. Replaced whole.
    alwaysOpenIn: Record<string, LinkDestination>
  }
  appearance: {
    theme: 'system' | 'light' | 'dark' // the color mode, which picks a theme's variant
    colorTheme: string // an installed theme's id, or BUILTIN_THEME_ID
    textSize: 'small' | 'default' | 'large' // the composer: 14, 15 or 16 px; thread prose a pixel less
    reduceMotion: 'system' | 'always'
    zoom: ZoomLevel // Chromium's page zoom of the whole window
    sidebarHover: boolean // pointing at the toggle of a collapsed sidebar shows it over the page
  }
  notifications: {
    permission: boolean
    turnEnded: boolean
    error: boolean
    routines: boolean // a routine's run ended, or its routines paused at a plan limit
    limits: boolean // a plan window crossed 90% used or ran out: a toast, and a notification away
    sound: boolean
    badge: boolean // the Dock icon on macOS, the taskbar button on Windows
  }
  // Keyed by harness: the program picked for it, and its default agent's folder and visibility.
  // configDir: a folder picked before agents could be added, which the default agent keeps.
  // autoUpdate: false when Kettu's own install no longer follows the Registry's versions by itself.
  agents: Partial<
    Record<
      HarnessId,
      {
        binaryPath?: string
        configDir?: string
        hidden?: true
        enabled?: boolean
        uninstalled?: true
        autoUpdate?: false
      }
    >
  >
  addedAgents: AddedAgent[] // in the order they were added
  disabledAgents: AgentId[] // turned off: never started, kept with everything they have
  proxy: ProxySettings
  terminal: {
    shellPath?: string // picked in a native dialog; the platform default when absent
    fontSize: 12 | 13 | 14
    fontFamily?: string // an installed face tried before the theme's code font
  }
  // worktreeRoot: where sessions' worktrees go; null puts them beside each project.
  git: { backgroundFetch: boolean; worktreeRoot: string | null }
  mcp: { kettu: { off: AgentId[] } } // the agents whose sessions get no Kettu MCP server
  // What the Marketplace installed that Kettu keeps and hands to agents; keys live apart.
  marketplace: { mcp: MarketServer[]; skills: MarketSkill[] }
  // The permission mode each agent's new sessions start in; an agent with none starts as its own.
  startModes: Partial<Record<AgentId, string>>
  // When idle Claude Code sessions let their agent go; outOfView and inView in minutes.
  idleSessions: IdleSessionsSettings
  // source: where updates come from; GitHub only never reaches Kettu's download service.
  updates: { automatic: 'download' | 'restart' | 'notify' | 'off'; source: 'auto' | 'github' }
  privacy: { hideAccount: boolean } // kept so older files still parse; loading turns it off
  // Detailed records are on until this time (ms since the epoch); null when off.
  diagnostics: { verboseUntil: number | null }
  usage: {
    fromComputer: boolean // read the agents' own logs
    sidebar: 'today' | 'cost' | 'limit' | 'off' // what the sidebar's Usage row shows at its end
    limits: 'used' | 'left' // plan limits as the share used or the share left
  }
  remote: {
    enabled: boolean // paired devices may connect to this computer; keeps Kettu in the background
    name: string | null // the name devices show for this computer; null for the system's
    // Held on while remote access is and the relay is off, when devices have no other way.
    direct: DirectSettings
    terminal: boolean // devices may use this computer's terminals, which run any command
    relay: boolean // Use the Kettu relay, while this computer is signed in to a Kettu account
    // Devices of the same Kettu account find this computer on the relay and ask to be added.
    discoverable: boolean
  }
  // Agents using this computer's desktop apps; a paired device can neither see nor change it.
  computerUse: ComputerUseSettings
  // Huli: agents' network through a node of the user's subscriptions; a paired device can neither
  // see nor change it. The subscriptions' addresses are the agent host's, never in this file.
  agentNetwork: AgentNetworkSettings
  // Kettu's own services: the account, relay, push, sharing to Kettu and problem reports. Off is
  // the self-hosted mode, in which no process of this computer reaches them.
  cloud: { enabled: boolean }
  onboarding: OnboardingState
  // Huli: the daily backup of this computer's data folder; see tools/huli/README.md.
  backup: BackupSettings
}

/**
 * Huli: the daily backup. `time` is the local time of day it runs, `keep` how many backups the
 * folder holds, and `folder` one picked in a native dialog; null for the default in Documents.
 */
export interface BackupSettings {
  enabled: boolean
  time: string
  keep: number
  folder: string | null
}

/** Huli: how many backups the folder may be set to keep. */
export const BACKUP_KEEP_MIN = 1
export const BACKUP_KEEP_MAX = 60

/** Huli: a local time of day as `HH:MM`, 24-hour. */
export function isBackupTime(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
}

export function isBackupKeep(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= BACKUP_KEEP_MIN &&
    value <= BACKUP_KEEP_MAX
  )
}

/** Devices connecting over TCP on the same network or a VPN, without the relay. */
export interface DirectSettings {
  enabled: boolean
  // Picked at random the first time direct connections turn on, then kept, so firewall rules and
  // forwarded ports stay valid.
  port: number | null
  addresses: DirectAddress[] // the owner's own, such as a forwarded port, listed before the found
}

/** Where a link opens: the system's default browser, or the session's page in Kettu's browser. */
export type LinkDestination = 'browser' | 'session'
export type OpenLinksIn = LinkDestination | 'ask'

export const MAX_FONT_FAMILY_CHARS = 100

/** One face name, safe to put in quotes in a CSS font stack: no quotes, separators or controls. */
export function isFontFamilyName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_FONT_FAMILY_CHARS &&
    value === value.trim() &&
    !/[\p{Cc}"'`\\;,{}()<>]/u.test(value)
  )
}

/** The most sites the "Always open" choice remembers. */
export const MAX_LINK_SITES = 500

// Lowercase labels of letters, digits and hyphens, or an IPv6 address in brackets.
const LINK_SITE = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/

/** Whether a host can be remembered for "Always open", as the URL parser writes hosts. */
export function isLinkSite(site: string): boolean {
  return site.length <= 253 && LINK_SITE.test(site)
}

/** An agent added beside a harness's default one, with a configuration folder of its own. */
export interface AddedAgent {
  id: AgentId // `<harness>~<slug>`, see `addedAgentId`
  name: string
  configDir: string // Kettu's own new folder, or one picked in a native dialog
  created: boolean // Kettu made the folder, so removing the agent offers to move it to the trash
  color?: AgentColor // the dot on its mark; absent in files from before it, see `agentColor`
}

/** The colors of the dot that sets an added agent's mark apart from its harness's default. */
export const AGENT_COLORS = ['teal', 'violet', 'amber', 'rose', 'green', 'slate'] as const
export type AgentColor = (typeof AGENT_COLORS)[number]

export function isAgentColor(value: unknown): value is AgentColor {
  return (AGENT_COLORS as readonly unknown[]).includes(value)
}

/** An added agent's dot: its own color, else one by its place in the list; null for a default agent. */
export function agentColor(agents: readonly AddedAgent[], id: AgentId): AgentColor | null {
  const index = agents.findIndex((agent) => agent.id === id)
  if (index < 0) return null
  return agents[index]!.color ?? AGENT_COLORS[index % AGENT_COLORS.length]!
}

/** The color a new agent gets: the first no other added agent has, else the first. */
export function nextAgentColor(agents: readonly AddedAgent[]): AgentColor {
  const taken = new Set(agents.map((agent) => agentColor(agents, agent.id)))
  return AGENT_COLORS.find((color) => !taken.has(color)) ?? AGENT_COLORS[0]
}

/** The longest name an added agent may have. */
export const AGENT_NAME_CHARS = 40

/** The variable that moves each harness's configuration folder, for those that carry agents. */
export const CONFIG_VARIABLES: Partial<Record<HarnessId, string>> = {
  'claude-code': 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  deepseek: 'DSH_HOME',
  codebuddy: 'CODEBUDDY_CONFIG_DIR',
}

/** Chrome's page zoom steps from 80% to 150%. */
export const ZOOM_LEVELS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const
export type ZoomLevel = (typeof ZOOM_LEVELS)[number]
export type ZoomStep = -1 | 0 | 1

export type ProxySettings =
  { mode: 'environment' } | { mode: 'custom'; url: string; noProxy: string }

export const CLAUDE_TEST_ENTRYPOINT_LABEL_CHARS = 1024

/** Any text goes into CLAUDE_CODE_ENTRYPOINT as it is, short of a NUL, which no environment can hold. */
export function isClaudeTestEntrypointLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= CLAUDE_TEST_ENTRYPOINT_LABEL_CHARS &&
    !value.includes('\0')
  )
}

/** How a Claude Code agent's sessions run: a model for when the main one is overloaded, and a cap. */
export interface ClaudeRunSettings {
  fallbackModel: string | null
  budgetUsd: number | null // what one run may spend; null for no limit
  budgetAllSessions: boolean // false: the budget holds for routine runs only
}

export const CLAUDE_RUN_DEFAULTS: ClaudeRunSettings = {
  fallbackModel: null,
  budgetUsd: null,
  budgetAllSessions: false,
}

export const CLAUDE_BUDGET_MAX_USD = 10_000
const CLAUDE_MODEL_CHARS = 256

/** A model id as Claude Code takes one: one word, since a comma or a space would make it a list. */
export function isClaudeFallbackModel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= CLAUDE_MODEL_CHARS &&
    /^[^\s,]+$/.test(value)
  )
}

export function isClaudeBudgetUsd(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= CLAUDE_BUDGET_MAX_USD
  )
}

export const DEFAULT_SETTINGS: SettingsFile = {
  version: 1,
  agentRegistrationVersion: 1,
  remoteDirectVersion: 1,
  initialSetup: { done: false },
  general: {
    language: 'system',
    defaultAgent: null,
    sendKey: 'enter',
    restoreLastSession: true,
    newSessionList: 'sessions',
    confirmQuitWhileRunning: true,
    openAtLogin: false,
    background: false,
    sessionTitles: true,
    claudeTestEntrypoint: false,
    claudeTestEntrypointLabel: 'huli-test',
    claudeRuns: {},
    promptSuggestions: true,
  },
  thread: { outlineSummaries: true, confirmLinks: true, openLinksIn: 'browser', alwaysOpenIn: {} },
  appearance: {
    theme: 'system',
    colorTheme: BUILTIN_THEME_ID,
    textSize: 'default',
    reduceMotion: 'system',
    zoom: 1.1,
    sidebarHover: true,
  },
  notifications: {
    permission: true,
    turnEnded: true,
    error: true,
    routines: true,
    limits: true,
    sound: false,
    badge: true,
  },
  agents: {},
  addedAgents: [],
  disabledAgents: [],
  proxy: { mode: 'environment' },
  terminal: { fontSize: 13 },
  git: { backgroundFetch: false, worktreeRoot: null },
  mcp: { kettu: { off: [] } },
  marketplace: { mcp: [], skills: [] },
  startModes: {},
  idleSessions: { release: 'auto', outOfView: 5, inView: 30, limit: null },
  updates: { automatic: 'download', source: 'auto' },
  privacy: { hideAccount: false },
  diagnostics: { verboseUntil: null },
  usage: { fromComputer: false, sidebar: 'today', limits: 'used' },
  remote: {
    enabled: false,
    name: null,
    direct: { enabled: true, port: null, addresses: [] },
    terminal: false,
    // Huli Cloud's own relay, used only while Huli Cloud is on and signed in; the account's phones
    // and browsers may ask to be added through it, which the owner still allows here each time.
    relay: true,
    discoverable: true,
  },
  computerUse: { enabled: false, allowedApps: [], pauseOnUse: true, stopShortcut: '' },
  agentNetwork: DEFAULT_AGENT_NETWORK,
  // Personal fork: the self-hosted mode, in which nothing reaches Kettu's services; paired devices
  // connect directly over the network or a VPN such as Tailscale.
  cloud: { enabled: false },
  onboarding: { done: false, step: 'welcome' },
  backup: { enabled: true, time: '03:00', keep: 7, folder: null },
}

/** The zoom one step in (1) or out (-1), held at the ends; 0 returns to the default. */
export function stepZoom(zoom: ZoomLevel, step: ZoomStep): ZoomLevel {
  if (step === 0) return DEFAULT_SETTINGS.appearance.zoom
  const at = ZOOM_LEVELS.indexOf(zoom) + step
  return ZOOM_LEVELS[Math.min(Math.max(at, 0), ZOOM_LEVELS.length - 1)]!
}

/**
 * A change from the renderer. Sections merge key by key; `proxy` is replaced whole.
 * Executable paths and configuration folders can only be cleared here (`null`); setting one goes
 * through a native dialog in main, so the renderer never sends a path to a program or folder.
 */
export interface SettingsPatch {
  general?: Partial<SettingsFile['general']>
  thread?: Partial<SettingsFile['thread']>
  appearance?: Partial<SettingsFile['appearance']>
  notifications?: Partial<SettingsFile['notifications']>
  agents?: Partial<
    Record<
      HarnessId,
      {
        binaryPath?: null
        configDir?: null
        hidden?: boolean
        enabled?: boolean
        uninstalled?: boolean
        autoUpdate?: boolean
      }
    >
  >
  proxy?: ProxySettings
  terminal?: {
    shellPath?: null
    fontSize?: SettingsFile['terminal']['fontSize']
    fontFamily?: string | null // null goes back to the theme's code font
  }
  git?: Partial<SettingsFile['git']>
  mcp?: { kettu: { off: AgentId[] } } // the list is replaced whole
  marketplace?: { mcp?: MarketServer[]; skills?: MarketSkill[] } // each list is replaced whole
  disabledAgents?: AgentId[] // replaced whole
  startModes?: Partial<Record<AgentId, string | null>> // merged by agent; null clears one
  idleSessions?: Partial<SettingsFile['idleSessions']>
  updates?: Partial<SettingsFile['updates']>
  privacy?: Partial<SettingsFile['privacy']>
  diagnostics?: Partial<SettingsFile['diagnostics']>
  computerUse?: Partial<SettingsFile['computerUse']> // allowedApps is replaced whole
  agentNetwork?: Partial<SettingsFile['agentNetwork']> // agents is replaced whole
  cloud?: Partial<SettingsFile['cloud']>
  onboarding?: Partial<OnboardingState>
  usage?: Partial<SettingsFile['usage']>
  remote?: {
    enabled?: boolean
    name?: string | null
    // `port` from 1024: below it a port may need privileges; the list is replaced whole.
    direct?: { enabled?: boolean; port?: number; addresses?: DirectAddress[] }
    terminal?: boolean
    relay?: boolean
    discoverable?: boolean
  }
  // Huli: the folder can only be cleared here, back to the default; one is picked in main's dialog.
  backup?: {
    enabled?: boolean
    time?: string
    keep?: number
    folder?: null
  }
}

/** The part of the settings the agent host receives. */
export interface HostSettings {
  locale: Locale // the language of the text the host writes for the user
  initialSetupDone: boolean // the first start has run, so the host does not offer it again
  agents: SettingsFile['agents']
  addedAgents: AddedAgent[]
  disabledAgents: AgentId[]
  proxy: ProxySettings
  git: SettingsFile['git']
  mcp: SettingsFile['mcp']
  marketplace: SettingsFile['marketplace']
  startModes: SettingsFile['startModes']
  idleSessions: SettingsFile['idleSessions']
  usage: { fromComputer: boolean }
  sessionTitles: boolean // write a title for a session its agent leaves untitled
  claudeTestEntrypoint: string | null
  claudeRuns: SettingsFile['general']['claudeRuns']
  promptSuggestions: boolean // Claude Code's sessions predict the user's next prompt
  defaultAgent: AgentId | null // the agent new sessions start with, which answers artifacts' questions
  computerUse: ComputerUseSettings
  agentNetwork: AgentNetworkSettings
  // Kettu's download service may be asked, as for the harness compatibility manifest: off in
  // Local mode and with GitHub only as the download source.
  downloadService: boolean
}

/** The part of the settings the terminal host receives. */
export interface TerminalSettings {
  shellPath: string | null
  fontSize: SettingsFile['terminal']['fontSize']
  allowDevices: boolean // `remote.terminal`: paired devices' ports may use the terminals
}
