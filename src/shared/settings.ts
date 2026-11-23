import { DEFAULT_AGENT_NETWORK, type AgentNetworkSettings } from './agent-network'
import type { ComputerUseSettings } from './computer-use'
import type { IdleSessionsSettings } from './idle-release'
import type { LanguageSetting, Locale } from './locale'
import { DEFAULT_MANAGER_SETTINGS, type ManagerSettings } from './manager'
import type { MarketServer, MarketSkill } from './marketplace'
import { DEFAULT_FEATURES, type FeatureSettings } from './features'
import type { DirectAddress } from './remote/protocol'
import type { AutoApprove } from './risk'
import { DEFAULT_SANDBOX_SETTINGS, type SandboxSettings } from './sandbox'
import { DEFAULT_SUPERVISOR, type SupervisorSettings } from './supervisor'
import { DEFAULT_TIDY, type TidySettings } from './session-tidy'
import type { ToolCallView } from './zen-view'
import { BUILTIN_THEME_ID } from './themes'
import type { AgentId, HarnessId } from './thread'
import { DEFAULT_PORT_BASE } from './worktree-ports'
import { DEFAULT_WORKING_STEPS, type WorkingStepLimit } from './workflow'
import { DEFAULT_WEBHOOK_PORT } from './routines'
import type { ShortcutBindings } from './shortcuts'

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

/**
 * The model the requests Kettu makes itself ask: session titles, branch names, outline titles,
 * commit messages and problem report drafts. `small`: a small model of the task's agent, else the
 * session's; `session`: the session's agent and model; `pinned`: one agent and model for all.
 */
export type LightModel =
  { mode: 'small' } | { mode: 'session' } | { mode: 'pinned'; agentId: AgentId; model: string }

/** A pinned model's id at most, in characters. */
export const LIGHT_MODEL_CHARS = 200

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
    lightModel: LightModel // replaced whole
    // Huli: the agent host runs below normal priority, and so does every program it starts.
    lowerAgentPriority: boolean
    // Huli: no idle sleep while a session's turn runs or waits on the user, or a routine runs.
    keepAwake: boolean
  }
  thread: {
    outlineSummaries: boolean // a small model titles the outline's messages
    confirmLinks: boolean // ask before opening a site that has no `alwaysOpenIn` entry
    openLinksIn: OpenLinksIn // where a click on a link in a reply opens it
    // By site: its registrable domain, or the whole host when that is the domain. Replaced whole.
    alwaysOpenIn: Record<string, LinkDestination>
    // Huli: how much of a turn's work a session shows unless it has its own choice (简洁视图).
    toolCalls: ToolCallView
  }
  appearance: {
    theme: 'system' | 'light' | 'dark' // the color mode, which picks a theme's variant
    colorTheme: string // an installed theme's id, or BUILTIN_THEME_ID
    textSize: 'small' | 'default' | 'large' // the composer: 14, 15 or 16 px; thread prose a pixel less
    reduceMotion: 'system' | 'always'
    zoom: ZoomLevel // Chromium's page zoom of the whole window
    sidebarHover: boolean // pointing at the toggle of a collapsed sidebar shows it over the page
    sidebarOrder: SidebarPage[] // every page once, as the sidebar lists them; replaced whole
    sidebarHidden: SidebarPage[] // pages the sidebar leaves out; replaced whole
    fonts: UserFonts // replaced whole; a role left out keeps the theme's face
  }
  notifications: {
    permission: boolean
    turnEnded: boolean
    error: boolean
    routines: boolean // a routine's run ended, or its routines paused at a plan limit
    updates: boolean // Kettu's new version downloaded, or waiting for a step of the user's
    planLimits: boolean // a plan limit window at 90%, used up, or reset after it was used up
    sound: boolean
    badge: boolean // the Dock icon on macOS, the taskbar button on Windows
    // macOS: the notch island shows what needs the user, in place of the notifications of the
    // kinds it shows, while it runs
    island: boolean
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
  // worktreeRoot: where sessions' worktrees go; null puts them beside each project. Huli:
  // portBase: the first port of the blocks worktree sessions hold (KITE_PORT).
  git: { backgroundFetch: boolean; worktreeRoot: string | null; portBase: number }
  mcp: { kettu: { off: AgentId[] } } // the agents whose sessions get no Kettu MCP server
  // What the Marketplace installed that Kettu keeps and hands to agents; keys live apart.
  marketplace: { mcp: MarketServer[]; skills: MarketSkill[] }
  // The permission mode each agent's new sessions start in; an agent with none starts as its own.
  startModes: Partial<Record<AgentId, string>>
  // When idle Claude Code sessions let their agent go; outOfView and inView in minutes.
  idleSessions: IdleSessionsSettings
  // Huli: a turn a plan limit stopped goes on once the plan resets; a silent turn is flagged.
  supervisor: SupervisorSettings
  // Huli: the rules that settle sessions out of the active list by themselves (会话整理).
  tidy: TidySettings
  // Huli: the loopback port routines' webhooks listen on, while one of them uses its webhook.
  webhooks: { port: number }
  // How many workflow step sessions work at once across every task.
  workflow: { maxWorkingSteps: WorkingStepLimit }
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
  // Huli: this computer's keys: the shortcuts the user rebound, each one left out at its default,
  // and the global screenshot hotkey (off while null); see shared/shortcuts.ts.
  keyboard: { shortcuts: ShortcutBindings; screenshot: string | null }
  // Huli: which permission requests the host allows once by itself, for a project that keeps the
  // default; a project may choose its own. Agents never change it.
  permissions: { autoApprove: AutoApprove }
  // Huli: manager mode's roster, review loop, approvals and limits; a project may have its own.
  manager: ManagerSettings
  // Huli: the sandbox a session of a project that keeps the default starts in, and whether a
  // sandboxed session's edits inside its project need no asking. Agents never change it.
  sandbox: SandboxSettings
  // Huli: Settings > Features, which optional features are on; see src/shared/features.ts.
  features: FeatureSettings
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

/** The text the user may draw in a face of their own: the interface, replies and code. */
/** The pages under New session in the sidebar, in their default order. */
export const SIDEBAR_PAGES = ['overview', 'artifacts', 'routines', 'marketplace', 'usage'] as const
export type SidebarPage = (typeof SIDEBAR_PAGES)[number]

export function isSidebarPage(value: unknown): value is SidebarPage {
  return (SIDEBAR_PAGES as readonly unknown[]).includes(value)
}

/** The known pages of a stored list, each once; anything else, such as a later version's, dropped. */
export function readSidebarPages(value: unknown): SidebarPage[] {
  return Array.isArray(value) ? [...new Set<unknown>(value)].filter(isSidebarPage) : []
}

/** A stored order, with each page it lacks put back after the page it follows by default. */
export function readSidebarOrder(value: unknown): SidebarPage[] {
  const order = readSidebarPages(value)
  SIDEBAR_PAGES.forEach((page, i) => {
    if (order.includes(page)) return
    const before = i === 0 ? -1 : order.indexOf(SIDEBAR_PAGES[i - 1]!)
    order.splice(before + 1, 0, page)
  })
  return order
}

export const USER_FONT_ROLES = ['ui', 'prose', 'code'] as const
export type UserFontRole = (typeof USER_FONT_ROLES)[number]
/** A face installed on the computer by role, each drawn before the theme's, which fills in. */
export type UserFonts = Partial<Record<UserFontRole, string>>

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
    lightModel: { mode: 'small' },
    lowerAgentPriority: true,
    keepAwake: true,
  },
  thread: {
    outlineSummaries: true,
    confirmLinks: true,
    openLinksIn: 'browser',
    alwaysOpenIn: {},
    toolCalls: 'all',
  },
  appearance: {
    theme: 'system',
    colorTheme: BUILTIN_THEME_ID,
    textSize: 'default',
    reduceMotion: 'system',
    zoom: 1.1,
    sidebarHover: true,
    sidebarOrder: [...SIDEBAR_PAGES],
    sidebarHidden: [],
    fonts: {},
  },
  notifications: {
    permission: true,
    turnEnded: true,
    error: true,
    routines: true,
    updates: true,
    planLimits: true,
    sound: false,
    badge: true,
    island: true,
  },
  agents: {},
  addedAgents: [],
  disabledAgents: [],
  proxy: { mode: 'environment' },
  terminal: { fontSize: 13 },
  git: { backgroundFetch: false, worktreeRoot: null, portBase: DEFAULT_PORT_BASE },
  mcp: { kettu: { off: [] } },
  marketplace: { mcp: [], skills: [] },
  startModes: {},
  idleSessions: { release: 'auto', outOfView: 5, inView: 30, limit: null },
  supervisor: DEFAULT_SUPERVISOR,
  tidy: { ...DEFAULT_TIDY },
  webhooks: { port: DEFAULT_WEBHOOK_PORT },
  workflow: { maxWorkingSteps: DEFAULT_WORKING_STEPS },
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
  computerUse: {
    enabled: false,
    allowedApps: [],
    pauseOnUse: true,
    stopShortcut: '',
    allowForeground: true,
    elevated: 'off',
  },
  agentNetwork: DEFAULT_AGENT_NETWORK,
  // Personal fork: the self-hosted mode, in which nothing reaches Kettu's services; paired devices
  // connect directly over the network or a VPN such as Tailscale.
  cloud: { enabled: false },
  onboarding: { done: false, step: 'welcome' },
  backup: { enabled: true, time: '03:00', keep: 7, folder: null },
  keyboard: { shortcuts: {}, screenshot: null },
  permissions: { autoApprove: 'off' },
  manager: DEFAULT_MANAGER_SETTINGS,
  sandbox: { ...DEFAULT_SANDBOX_SETTINGS },
  features: { ...DEFAULT_FEATURES },
}

/** The zoom one step in (1) or out (-1), held at the ends; 0 returns to the default. */
export function stepZoom(zoom: ZoomLevel, step: ZoomStep): ZoomLevel {
  if (step === 0) return DEFAULT_SETTINGS.appearance.zoom
  const at = ZOOM_LEVELS.indexOf(zoom) + step
  return ZOOM_LEVELS[Math.min(Math.max(at, 0), ZOOM_LEVELS.length - 1)]!
}

/**
 * Changes to a kept list, applied to the list the settings owner holds when the patch arrives:
 * `put` adds an entry or replaces the one with its id, in place, and `remove` drops ids. Removes
 * apply first.
 */
export interface ListEdit<T> {
  put?: T[]
  remove?: string[]
}

export function applyListEdit<T extends { id: string }>(
  list: readonly T[],
  edit: ListEdit<T>,
): T[] {
  const removed = new Set(edit.remove)
  const next = list.filter((item) => !removed.has(item.id))
  for (const item of edit.put ?? []) {
    const at = next.findIndex((other) => other.id === item.id)
    if (at < 0) next.push(item)
    else next[at] = item
  }
  return next
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
  // Each list is replaced whole, then its edit is applied; an edit is for a client that must not
  // overwrite what another changed meanwhile.
  marketplace?: {
    mcp?: MarketServer[]
    skills?: MarketSkill[]
    mcpEdit?: ListEdit<MarketServer>
    skillsEdit?: ListEdit<MarketSkill>
  }
  disabledAgents?: AgentId[] // replaced whole
  startModes?: Partial<Record<AgentId, string | null>> // merged by agent; null clears one
  idleSessions?: Partial<SettingsFile['idleSessions']>
  supervisor?: Partial<SettingsFile['supervisor']>
  tidy?: Partial<SettingsFile['tidy']>
  webhooks?: Partial<SettingsFile['webhooks']>
  workflow?: Partial<SettingsFile['workflow']>
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
  permissions?: Partial<SettingsFile['permissions']>
  manager?: ManagerSettings // replaced whole
  sandbox?: Partial<SandboxSettings>
  features?: Partial<FeatureSettings>
  // Huli: the shortcuts replaced whole.
  keyboard?: Partial<SettingsFile['keyboard']>
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
  // Huli: absent from a parent older than it, which leaves the defaults.
  supervisor?: SettingsFile['supervisor']
  // Huli: the rules that settle sessions by themselves; absent from a parent older than them.
  tidy?: SettingsFile['tidy']
  // Huli: routines' webhook port; absent from a parent older than it, which leaves the default.
  webhooks?: SettingsFile['webhooks']
  workflow: SettingsFile['workflow']
  usage: { fromComputer: boolean }
  sessionTitles: boolean // write a title for a session its agent leaves untitled
  claudeTestEntrypoint: string | null
  claudeRuns: SettingsFile['general']['claudeRuns']
  promptSuggestions: boolean // Claude Code's sessions predict the user's next prompt
  lightModel: LightModel // which model Kettu's own requests ask
  defaultAgent: AgentId | null // the agent new sessions start with, which answers artifacts' questions
  computerUse: ComputerUseSettings
  agentNetwork: AgentNetworkSettings
  // Kettu's download service may be asked, as for the harness compatibility manifest: off in
  // Local mode and with GitHub only as the download source.
  downloadService: boolean
  // Huli: the requests the host allows by itself in a project that keeps the default; absent from
  // a parent older than it, which allows none.
  autoApprove?: AutoApprove
  // Huli: the host lowers its own priority; absent from a parent older than it, which leaves it.
  lowerAgentPriority?: boolean
  // Huli: manager mode's settings; absent from a parent older than it, which has none.
  manager?: ManagerSettings
  // Huli: the sandbox default and its approvals rule; absent from a parent older than it, which
  // starts every session unsandboxed.
  sandbox?: SandboxSettings
  // Huli: which optional features are on; absent from a parent older than it, which has all on.
  features?: FeatureSettings
}

/** The part of the settings the terminal host receives. */
export interface TerminalSettings {
  shellPath: string | null
  fontSize: SettingsFile['terminal']['fontSize']
  allowDevices: boolean // `remote.terminal`: paired devices' ports may use the terminals
}
