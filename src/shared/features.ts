// Huli: Settings > Features, the page of switches for Kite's big optional features: one turned off
// has its entry points hidden and its code neither loaded nor run, and agents are not offered its
// tools. This registry is the one list of them; see tools/huli/README.md (Feature switches) for
// how a new feature registers itself.

import type { HostMethod, McpToolGroup } from './agent-host'

/**
 * One optional feature. Its name and its line on the page are the settings catalog's
 * `features.items.<id>.name` and `.description`, in both locales.
 */
export interface FeatureDef {
  id: string
  /**
   * The places it shows, which the window and the phone ask `entryOn` about before they draw
   * them: `<where>.<what>`, with `phone.` for the phone app's.
   */
  entries: readonly string[]
  /** Kite's MCP tools offered to agents only while it is on, by name. */
  tools?: readonly string[]
  /** Whole groups of Kite's MCP tools offered only while it is on. */
  toolGroups?: readonly McpToolGroup[]
  /** The agent host's methods it refuses while it is off, for windows and paired devices alike. */
  methods?: readonly HostMethod[]
}

export const FEATURES = [
  {
    id: 'board',
    entries: [
      'overview.board',
      'sidebar.boardMark',
      'sessionMenu.board',
      'phone.boardRow',
      'phone.boardMenu',
    ],
    tools: ['set_board_status'],
    methods: ['sessions.setBoardStatus'],
  },
  {
    id: 'manager',
    entries: [
      'settings.manager',
      'newSession.manager',
      'pane.workers',
      'composer.managerStrip',
      'sessionMenu.manager',
      'phone.managerBanner',
      'phone.newSessionManager',
    ],
    tools: [
      'list_workers',
      'start_worker',
      'get_worker',
      'stop_worker',
      'answer_worker_request',
      'report_work',
    ],
    // Turning a session or a project into a manager; stopping and pausing its workers stay.
    methods: ['manager.set', 'projects.setManager'],
  },
  {
    id: 'bestOfN',
    entries: ['newSession.bestOfN', 'sidebar.runGroup', 'page.group', 'phone.bestOfRow'],
    methods: ['groups.start', 'groups.changes', 'groups.fileDiff', 'groups.keep', 'groups.discard'],
  },
  {
    id: 'routines',
    entries: [
      'sidebar.routines',
      'search.routines',
      'page.routines',
      'settings.routineNotifications',
      'session.routineLink',
      'phone.routines',
    ],
    // What would start or change a run; listing them and stopping one stay.
    methods: ['routines.create', 'routines.update', 'routines.runNow'],
  },
  {
    id: 'github',
    entries: [
      'projectMenu.issues',
      'page.issues',
      'sessionMenu.prFlow',
      'header.flowChips',
      'sidebar.issueBadge',
      'routine.trigger',
      'phone.flowChips',
    ],
    methods: ['github.issues', 'github.startIssue', 'sessions.setPrFlow'],
  },
  {
    id: 'sandbox',
    entries: ['settings.sandbox', 'projectMenu.sandbox', 'newSession.sandbox', 'composer.sandbox'],
  },
  { id: 'chatBridge', entries: ['settings.chatBridge'] },
  {
    id: 'agentSync',
    entries: ['marketplace.sync'],
    methods: ['sync.read', 'sync.preview', 'sync.apply', 'sync.saveSnippets'],
  },
  { id: 'portForwarding', entries: ['browser.ports', 'settings.hostPorts', 'terminal.openOnHost'] },
  { id: 'devPreview', entries: ['phone.devServers'] },
  {
    id: 'devices',
    entries: ['settings.devices', 'pane.devices'],
    toolGroups: ['devices'],
  },
  { id: 'pickElement', entries: ['browser.pick'] },
  // A checkpoint of the session's files as each message goes, which a rewind can restore them to.
  {
    id: 'fileCheckpoints',
    entries: ['rewind.files', 'phone.rewindFiles'],
    methods: ['sessions.restoreFiles', 'sessions.undoRewindFiles'],
  },
  { id: 'secrets', entries: [], toolGroups: ['secrets'] },
  { id: 'agentTheme', entries: [], toolGroups: ['theme'] },
] as const satisfies readonly FeatureDef[]

export type FeatureId = (typeof FEATURES)[number]['id']
export type FeatureEntry = (typeof FEATURES)[number]['entries'][number]

export const FEATURE_IDS: readonly FeatureId[] = FEATURES.map((feature) => feature.id)

/** Which features are on, by id; every feature is on unless it says false. */
export type FeatureSettings = Record<FeatureId, boolean>

export const DEFAULT_FEATURES: FeatureSettings = Object.fromEntries(
  FEATURE_IDS.map((id) => [id, true]),
) as FeatureSettings

export function isFeatureId(value: unknown): value is FeatureId {
  return typeof value === 'string' && (FEATURE_IDS as readonly string[]).includes(value)
}

const BY_ENTRY: ReadonlyMap<string, FeatureId> = new Map(
  FEATURES.flatMap((feature) => feature.entries.map((entry) => [entry, feature.id] as const)),
)

/** The feature an entry point belongs to. */
export function featureOfEntry(entry: FeatureEntry): FeatureId {
  return BY_ENTRY.get(entry)!
}

/** Whether a feature is on; absent settings, as from a host older than the switches, are all on. */
export function featureOn(
  features: Partial<Record<string, boolean>> | null | undefined,
  id: FeatureId,
): boolean {
  return features?.[id] !== false
}

/** Whether an entry point shows. */
export function entryOn(
  features: Partial<Record<string, boolean>> | null | undefined,
  entry: FeatureEntry,
): boolean {
  return featureOn(features, featureOfEntry(entry))
}

/** The features turned off, as the remote host tells paired devices. */
export function featuresOff(features: Partial<Record<string, boolean>> | null | undefined) {
  return FEATURE_IDS.filter((id) => !featureOn(features, id))
}

/** The same as settings from a list of the features turned off; unknown ids are left out. */
export function featuresFromOff(off: readonly unknown[]): FeatureSettings {
  const features = { ...DEFAULT_FEATURES }
  for (const id of off) if (isFeatureId(id)) features[id] = false
  return features
}

/** The feature whose switch gates an agent host method; none for most. */
export function featureOfMethod(method: string): FeatureId | null {
  for (const feature of FEATURES as readonly FeatureDef[]) {
    if ((feature.methods as readonly string[] | undefined)?.includes(method)) {
      return feature.id as FeatureId
    }
  }
  return null
}

/**
 * The feature whose switch gates a tool of Kite's MCP server, from its name or its group; none
 * for a tool every session is offered.
 */
export function featureOfTool(name: string, group: McpToolGroup | undefined): FeatureId | null {
  for (const feature of FEATURES as readonly FeatureDef[]) {
    if (feature.tools?.includes(name)) return feature.id as FeatureId
    if (group && feature.toolGroups?.includes(group)) return feature.id as FeatureId
  }
  return null
}
