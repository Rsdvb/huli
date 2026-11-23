// The agent host, assembled: state, agents, sessions, git and the ports. start.ts runs it in
// the utility process or under Node.js; tests run it in-process with fakes for the launcher,
// shell and git.

import { DEVICE_ACCESS_WAIT_MS, type DeviceCall, type DeviceCallAnswer } from '@shared/device-agent'
import type { AgentSync } from './agent-sync/service'
import {
  replyRunNotice,
  type TerminalCall,
  type TerminalCallAnswer,
  type TerminalCallErrorCode,
} from '@shared/terminal-agent'
import { DeviceAccessStore } from './devices/access'
import os from 'node:os'
import path from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import { LAUNCH_FILE, parseLaunchConfigs, type LaunchConfig } from '@shared/launch-configs'
import { cp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import type {
  AgentOptions,
  AgentStatus,
  DiagnosticsBundle,
  HostEvent,
  HostParams,
  McpStatus,
} from '@shared/agent-host'
import { OWNER } from '@shared/artifact-comments'
import { DEFAULT_WEBHOOK_PORT, ROUTINE_ID } from '@shared/routines'
import { flushLog, logFolder, redactLogText, writeLog } from '@shared/log/process-log'
import { writeReport } from '@shared/log/report-bundle'
import { parseReportRequest } from '@shared/report'
import { harnessOf, takesStartMode, type HarnessId } from '@shared/agents'
import type { RuntimeAnswer } from '@shared/artifact-capabilities'
import { ARTIFACT_ENTRY, artifactFileType } from '@shared/artifact-files'
import { type ArtifactImportResult, type ArtifactSummary, NO_SESSION } from '@shared/artifacts'
import type { AttachmentGrant } from '@shared/attachments'
import {
  siteOf,
  type BrowserCallAnswer,
  type BrowserCallRequest,
  type BrowserOriginAnswer,
} from '@shared/browser'
import { isControlOutcome, isControlStep, SURFACE_ACCESS_WAIT_MS } from '@shared/control'
import type {
  AgentProcess,
  AttentionFront,
  ArtifactBrief,
  ArtifactContentResult,
  ArtifactExportResult,
  ArtifactListResult,
  ComputerControlAction,
  HostToMain,
  MainToHost,
  NodeRuntime,
  ReportBuildResult,
  SettingFacts,
  SettingsCall,
  SettingsCallAnswer,
  SettingsSnapshot,
} from '@shared/host-control'
import type { ArtifactExportFormat } from '@shared/artifact-types'
import type { ComputerFrame } from '@shared/computer-use'
import type { Platform } from '@shared/platform'
import type { PortChannel } from '@shared/port-channel'
import type { FromPort, PortErrorCode } from '@shared/port-rpc'
import type { PortDevice } from '@shared/remote/device'
import type { MemorySource } from '@shared/memory'
import { DEFAULT_AGENT_NETWORK } from '@shared/agent-network'
import { featureOfMethod, featureOn, type FeatureId } from '@shared/features'
import type { HostSettings } from '@shared/settings'
import {
  serverFor,
  serverName,
  specInputs,
  type CatalogServer,
  type MarketConnection,
  type MarketServer,
  type MarketSkill,
} from '@shared/marketplace'
import { listingIdOf } from '@shared/market-community'
import {
  HANDLE,
  MARKET_WAIT_MS,
  type MarketAccount,
  type MarketCall,
  type MarketCallAnswer,
  type MarketResults,
} from '@shared/market-publish'
import { HARNESSES_FOLDER, KETTU_HOME_FOLDER, PLUGINS_FOLDER } from '@shared/storage'
import type {
  AgentId,
  DigestedThreadEntry,
  FromDevice,
  ThreadEntry,
  UserContent,
} from '@shared/thread'
import { AgentFiles } from './agent-files'
import { AgentCopies } from './agent-copies'
import { agentOptionsFile, AgentOptionsStore, startModeIn } from './agent-options'
import { listedModels } from './claude/user-settings'
import { STOP_TIMINGS } from './agent-process'
import { AgentTrees } from './agent-trees'
import { readImport } from './artifacts/import'
import { ArtifactConsents } from './artifacts/runtime/consent'
import type { DeclaredArtifact } from './artifacts/runtime/calls'
import { ArtifactData } from './artifacts/runtime/data'
import { dbCapability } from './artifacts/runtime/db-capability'
import {
  CapabilityError,
  registerCapability,
  RuntimeDispatcher,
  RuntimeRequests,
} from './artifacts/runtime/dispatcher'
import { filesCapability } from './artifacts/runtime/files-capability'
import {
  sampleCapability,
  type SampleAgent,
  type SampleQuestion,
} from './artifacts/runtime/sample-capability'
import { ArtifactService, SERVICE_NAME } from './artifacts/service'
import { ArtifactError, ArtifactStore, versionSummary } from './artifacts/store'
import { registerContentCapability } from './artifacts/types/capability'
import { ExportError, exportVersion } from './artifacts/types/export'
import { ArtifactTypes } from './artifacts/types/registry'
import { upgradeContent } from './artifacts/types/writes'
import {
  AgentManager,
  processLauncher,
  type AgentLauncher,
  type AgentManagerDeps,
  type AgentTimings,
} from './agents'
import { buildCatalog, configFolders, type AgentDefinition } from './catalog'
import {
  answerOf,
  BROWSER_GONE,
  browserTarget,
  DeviceBrowserCalls,
  type BrowserTarget,
} from './device-browser'
import { BrowserTurns } from './browser-turns'
import { writeCommitMessage } from './commit-message'
import { writePullRequestDraft } from './pull-request-draft'
import { writeBranchSlug } from './session-titles'
import { cleanSlug } from './worktrees/names'
import { lightTarget } from './light-model'
import { reportDraftPrompt, writeReportDraft } from './report-draft'
import { Diagnostics } from './diagnostics'
import type { ContainerSandbox } from './sandbox/container'
import { HostError, invalidParams, isHostError, notFound } from './errors'
import { setLocale, t, tSettings, tSettingsEnglish } from './i18n'
import { FilesService } from './files'
import { MediaService } from './media'
import { MemoryError, type MemoryErrorCode } from './memory/errors'
import { MemoryService } from './memory/service'
import { catalogFile, MarketCatalogService } from './marketplace/catalog'
import { bundlesFile, MarketBundlesService } from './marketplace/bundles'
import { communityFile, MarketCommunityService } from './marketplace/community'
import { MarketConnectionsService } from './marketplace/connections'
import { logText } from './localized-error'
import { parseSignIns } from './marketplace/oauth'
import { McpProxy } from './marketplace/proxy'
import type { CodexRequest } from './marketplace/codex-plugins'
import { MarketPluginsService, pluginsFile } from './marketplace/plugins'
import { MarketSkillsService, skillFor, skillsCatalogFile } from './marketplace/skills'
import { PublishDrafts } from './marketplace/publish-drafts'
import { MarketCallError, MarketTools } from './marketplace/publish-tools'
import {
  SETTINGS_WAIT_MS,
  SettingsTools,
  StaleUndo,
  type LocalFacts,
  type SettingsTarget,
} from './settings/tools'
import {
  ALL_TRANSPORTS,
  keyState,
  libraryServers,
  parseMarketKeys,
  serverHeaders,
  type MarketKeys,
} from './marketplace/servers'
import { findCommand, isExecutableFile, type Env } from './find-command'
import type { GitServiceApi, GitServiceDeps } from './git/api'
import { createExec, type ExecRunner } from './git/exec'
import { findExecutable } from './git/executable'
import { createGitRunner, type GitRunner } from './file-checkpoints/git'
import { FileCheckpoints } from './file-checkpoints/store'
import { GitRetains } from './git/retains'
import type { SkillsListResponse } from './codex/protocol'
import { completePath } from './path-completion'
import { pathKey } from './paths'
import { PreparedRecords, preparedFile, settingsTargets } from './prepared'
import { processControl, type ProcessControl } from './process-tree'
import { ProjectCreate } from './project-create'
import { ProjectHooksAnswers } from './project-hooks'
import { ProjectMcpAnswers } from './project-mcp'
import { Projects } from './projects'
import { claudeOutside, type OutsideReader } from './outside-sessions'
import type { SecretStore } from './agent-reset/secrets'
import { claudeCacheTtl, type CacheTtlReader } from './prompt-cache'
import { claudeModelRequests } from './model-requests/claude'
import { clineModelRequests } from './model-requests/cline'
import { codexModelRequests } from './model-requests/codex'
import { opencodeModelRequests } from './model-requests/opencode'
import { byHarness } from './model-requests/reader'
import { AcpMessages, acpModelRequests } from './model-requests/acp-messages'
import { IdleRelease } from './idle-release'
import { MAIN_PORT, PortHub, type Handlers, type RequestContext } from './rpc'
import type { SessionMoves } from './session-move/service'
import { Attachments, toArrayBuffer } from './attachments'
import { storageUsage } from './data-usage'
import { RoutinesManager, type RoutineTimings } from './routines/manager'
import {
  isWebhookSecret,
  newWebhookSecret,
  WebhookListener,
  webhookPrompt,
} from './routines/webhooks'
import { TaskEngine, type TaskSessionHooksRef, type WrittenDocument } from './workflow/engine'
import {
  keptTool,
  type SuggestedTool,
  type WorkflowSettings,
  type TaskSummary,
  type TaskView,
  type WorkflowEntry,
} from '@shared/workflow'
import { STEP_HARNESSES } from './workflow/picks'
import { createTaskGit } from './workflow/git'
import { createGroupGit } from './groups/git'
import { SessionGroups } from './groups/groups'
import { managerGit } from './manager/git'
import { GithubFlow } from './github-flow/flow'
import { optionsOfPick, pickOfOptions, workflowAgents } from './workflow/host-agents'
import { WorkflowLibrary, workflowsFile } from './workflow/library'
import { WorkflowSuggestions, suggestionsFile } from './workflow/suggestions'
import { publishWorkflowPrompt } from './workflow/prompts'
import { deliveryOf } from './workflow/views'
import type { RoutineSessionHooksRef } from './routines/hooks'
import type { RoutineClock } from './routines/scheduler'
import { ScratchFolders } from './scratch'
import { createWorktreeGit } from './worktrees/git'
import { WorktreeManager } from './worktrees/manager'
import { ComputerDriver, probePermissions } from './computer/driver'
import { ElevatedDriver } from './computer/elevated'
import { ElevatedInstall } from './computer/elevated-install'
import { ComputerHelper } from './computer/helper'
import { networkStateFile, subscriptionsFile } from './node-proxy/files'
import { NodeProxy, type NodeProxyDeps } from './node-proxy/service'
import { routeFor, type ProxyVariables } from './node-proxy/download'
import { strictestRequirement } from './node-runtime/release'
import {
  isMusl,
  nodeRuntimeFile,
  nodeRuntimesFolder,
  NodeRuntimeService,
} from './node-runtime/service'
import { httpTransport, ownProxyVariables } from './node-runtime/transport'
import { getEnv } from './find-command'
import { moliRoot } from './web-reader/install'
import { WebReaderService } from './web-reader/service'
import { ComputerUse } from './computer/service'
import { ComputerToolError } from './computer/tools'
import { SessionFiles } from './session-files'
import { SessionManager, type SessionTimings } from './sessions'
import { EnvironmentService, type EnvironmentServiceDeps } from './shell-env'
import {
  agentProcessesFile,
  agentsFile,
  agentUpdatesFile,
  projectsFile,
  projectHooksFile,
  projectMcpFile,
  registryListingFile,
  harnessManifestFile,
  returnedFile,
  routinesFile,
  githubFlowFile,
  sessionsFile,
  type AgentsFile,
  type AgentUpdatesFile,
  type JsonFile,
  type RegistryListingFile,
  type HarnessManifestFile,
} from './storage'
import { GitHubStar, gitHubStarFile } from './github-star'
import { PlanAlerts, planAlertsFile } from './plan-alerts'
import { digestEntries } from './threads/digest'
import type { ImageMode } from './threads/model'
import { ThreadStore, type ThreadWorkerFactory } from './threads/store'
import { watchMigration } from './migration-watch'
import { UsageManager, type UsageTimings } from './usage/manager'
import type { LogReader } from './usage/model'
import { LimitNotices, limitNoticeText, type LimitNotice } from './limit-notices'
import { LOG_READERS } from './usage/readers'
import { UsageStore, type UsageWorkerFactory } from './usage/store'
import { createValidators } from './validate'
import { AgentHistory } from './agent-history'
import { claudeDesktopFolders } from './claude-desktop'
import { SessionFolders, sessionFoldersFile } from './session-folders'
import { DeletedSessions, deletedSessionsFile } from './deleted-sessions'
import { ProviderProfiles } from './provider-profiles'
import { removeSessionEnv, sessionEnvFiles } from './secrets/deliver'
import { SECRET_WAIT_MS, SecretTools } from './secrets/tools'
import { StaleThemeUndo, THEME_WAIT_MS, ThemeTools } from './theme/tools'
import type { ThemeCall, ThemeCallAnswer, ThemeSnapshot } from '@shared/theme-palette'
import { anyBridgeOn, parseChatBridgeConfig, type ChatBridgeConfig } from '@shared/chat-bridge'
import type { ChatBridgeService } from './chat-bridge/service'

// The agent menu reads a running agent's options again once they are older than this.
const OPTIONS_FRESH_MS = 5 * 60_000
/** How long a used-up window's notice waits for the turn it stopped to fail. */
const LIMIT_MERGE_MS = 2_000
/** A turn that failed this long before its window was used up counts as stopped by it. */
const LIMIT_FAILED_WITHIN_MS = 15_000
/** The harnesses whose connection answers a page's question in a session with no tools at all. */
const QUESTION_HARNESSES: ReadonlySet<HarnessId> = new Set(['claude-code'])

/** Huli: a request of a feature that Settings > Features turned off. */
function featureOff(id: FeatureId): HostError {
  return new HostError(
    'unavailable',
    t('featureOff', { name: tSettings(`features.items.${id}.name`) }),
  )
}

/** Refuses a port that is not a desktop app's: only one runs browser calls for the host. */
function browserApp(ctx: RequestContext): void {
  if (!ctx.device?.browser) {
    throw new HostError('forbidden', 'Only a paired desktop app answers browser calls')
  }
}

function brief(
  artifact: Pick<ArtifactSummary, 'id' | 'version' | 'createdAt' | 'updatedAt'>,
  deleted: boolean,
): ArtifactBrief {
  const { id, version, createdAt, updatedAt } = artifact
  return { id, version, createdAt, updatedAt, deleted }
}

/** A window, and a device that said so, read stored images by hash; other devices get bytes. */
function imagesFor(device: PortDevice | null): ImageMode {
  return device && !device.imageRefs ? 'inline' : 'refs'
}

/** A page as a device reads it: with long tool outputs and inputs as digests, when it said so. */
function digestsFor<T extends { entries: ThreadEntry[] }>(
  device: PortDevice | null,
  page: T,
): T | (Omit<T, 'entries'> & { entries: DigestedThreadEntry[] }) {
  return device?.toolDigests ? digestEntries(page) : page
}

/** What a message or answer from a paired device's port keeps of it; none from a window. */
function fromDevice(device: PortDevice | null): FromDevice | undefined {
  return device ? { id: device.id, name: device.name } : undefined
}

/** The user's own writes to Kettu's memory, from Settings, name no agent or session. */
const BY_USER: MemorySource = { agentId: null, sessionId: null }

const MEMORY_ERRORS: Record<MemoryErrorCode, PortErrorCode> = {
  invalid: 'invalid_params',
  secret: 'invalid_params',
  full: 'conflict',
  not_found: 'not_found',
  conflict: 'conflict',
  off: 'unavailable',
}

/** Runs a memory request, its refusals crossing the port with `memory_<code>` as `data.reason`. */
async function memoryCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof MemoryError)) throw error
    throw new HostError(MEMORY_ERRORS[error.code], error.message, {
      reason: `memory_${error.code}`,
    })
  }
}

export interface HostOptions {
  userDataPath: string
  appVersion: string
  platform: Platform
  nodeRuntime: NodeRuntime
  fakeAgentPath: string | null
  /** The session router's bundle, which a per-session agent's process runs under. */
  sessionRouterPath?: string | null
  /** The bundle of the process that runs Cline's SDK; without it Cline runs over ACP. */
  clineHostPath?: string | null
  settings: HostSettings
  baseEnv: Env
  send(message: HostToMain): void
  /** The git service, or how to make one with the host's log; without it every `git.*` fails. */
  git?: GitServiceApi | ((deps: GitServiceDeps) => GitServiceApi) | null
  launcher?: AgentLauncher
  resolveEnv?: EnvironmentServiceDeps['resolve']
  probeNode?: EnvironmentServiceDeps['probe']
  detect?: AgentManagerDeps['detect']
  /** Each agent's protocol over the catalog's, as a test runs the fake ACP agent under its id. */
  protocols?: AgentManagerDeps['protocols']
  /** Drivers over the built-in ones, as a test's own. */
  drivers?: AgentManagerDeps['drivers']
  agentTimings?: Partial<AgentTimings>
  sessionTimings?: Partial<SessionTimings>
  /** How long a minute of a run's time limit lasts, shortened by tests. */
  routineTimings?: Partial<RoutineTimings>
  /** The scheduler's clock and timer; the system's by default, or a test's. */
  routineClock?: RoutineClock
  /** How long after an agent's traffic its process tree is listed again. */
  treeNoteMs?: number
  /** Lists and stops the agents' process trees; the system's tools by default. */
  processControl?: ProcessControl
  mirrorTraffic?: boolean
  /** Starts the worker that owns the thread database; without it no thread is stored. */
  threadWorker?: ThreadWorkerFactory
  /** Starts the worker that owns the usage database; without it no usage is kept. */
  usageWorker?: UsageWorkerFactory
  usageTimings?: Partial<UsageTimings>
  /** The agents' log readers, for the manager; the worker has its own. */
  usageReaders?: readonly LogReader[]
  /** Where the agents' logs are looked for; the user's home by default. */
  homeDir?: string
  /** Where harness packages are installed; `~/.kettu/harnesses` by default, which apps share. */
  harnessesDir?: string
  /** Reads a session's prompt cache lifetime; Claude Code's transcripts by default. */
  cacheTtl?: CacheTtlReader
  /** Reads Claude Code sessions run outside Kettu; tests pass their own. */
  outside?: OutsideReader
  /** Huli: the credential store an agent's reset checks and clears; the system's by default. */
  secretStore?: SecretStore
  /** The desktop app's computer use; the daemon has none. */
  computer?: ComputerHostOptions | null
  /** Huli: the `mihomo` program the desktop app ships for the agents' network; the daemon has none. */
  mihomoPath?: string | null
  /** How the agents' network finds the physical interface; the system's tools by default. */
  detectInterface?: NodeProxyDeps['detect']
  /** What the host's requests to Kettu's download service say they are: the app or the daemon. */
  userAgent?: string
}

/** What the desktop app gives the host for computer use. */
export interface ComputerHostOptions {
  /** The `cua-driver` program in the app's resources, which may be missing in a checkout. */
  driverPath: string
  /** Huli: Kite's computer use helper beside it, on Windows and macOS; absent elsewhere. */
  helperPath?: string | null
  /** Kettu's own process and app ids, which computer use never touches. */
  selfPid: number
  selfIds: string[]
}

/** Whether a path is a directory, without raising when it is not there. */
async function isDirectory(folder: string): Promise<boolean> {
  return (await stat(folder).catch(() => null))?.isDirectory() ?? false
}

/**
 * Kettu used to install harness packages beside its own data, where uninstalling the app could
 * take them along. Moves that folder to the user's home once; a folder on another volume is
 * copied instead.
 */
async function moveHarnessInstalls(
  legacy: string,
  target: string,
  log: (message: string) => void,
): Promise<void> {
  if (!(await isDirectory(legacy)) || (await isDirectory(target))) return
  await mkdir(path.dirname(target), { recursive: true })
  try {
    await rename(legacy, target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      log(`Could not move ${legacy} to ${target}: ${(error as Error).message}`)
      return
    }
    try {
      await cp(legacy, target, { recursive: true })
      await rm(legacy, { recursive: true, force: true })
    } catch (copyError) {
      log(`Could not move ${legacy} to ${target}: ${(copyError as Error).message}`)
    }
  }
}

function harnessesFolder(options: HostOptions): string {
  return (
    options.harnessesDir ??
    path.join(options.homeDir ?? os.homedir(), KETTU_HOME_FOLDER, HARNESSES_FOLDER)
  )
}

const REPLY_RUN_ERRORS: Record<TerminalCallErrorCode, PortErrorCode> = {
  not_found: 'not_found',
  restricted: 'restricted',
  not_allowed: 'terminal_not_allowed',
  stopped: 'busy',
  unavailable: 'unavailable',
  failed: 'conflict',
}

/** Whether the user referenced a surface in a message to `sessionId`, or to New session's. */
function sharedWith(shared: Map<string, string | null>, id: string, sessionId: string): boolean {
  const to = shared.get(id)
  return to !== undefined && (to === null || to === sessionId)
}

export class AgentHost {
  readonly diagnostics: Diagnostics
  /** What each ACP session sent and received since the host started, for the Requests pane. */
  private readonly acpMessages = new AcpMessages()
  private readonly limitNotices = new LimitNotices()
  /** Each agent's session whose turn failed last, which a used-up window's notice may stand for. */
  private readonly lastFailed = new Map<AgentId, { sessionId: string; at: number }>()
  /** The session a used-up window stopped, by the window's key, which its reset opens. */
  private readonly stoppedBy = new Map<string, string>()
  readonly env: EnvironmentService
  readonly projects: Projects
  /** Huli: Add project's clones and new empty projects. */
  private readonly projectCreate: ProjectCreate
  readonly scratch: ScratchFolders
  private readonly worktrees: WorktreeManager
  readonly agents: AgentManager
  /** What the agents last reported about their accounts and plans, kept across runs. */
  private readonly remembered: JsonFile<AgentsFile>
  /** What the last update check found, so a found update shows after a restart. */
  private readonly updates: JsonFile<AgentUpdatesFile>
  private readonly registryListing: JsonFile<RegistryListingFile>
  private readonly harnessManifest: JsonFile<HarnessManifestFile>
  private readonly star: GitHubStar
  private readonly planAlerts: PlanAlerts
  /** Each agent's config options from its last new session, for New session. */
  private readonly agentOptions: AgentOptionsStore
  /** New session's prepared sessions not yet adopted or removed, for the host after a crash. */
  private readonly preparedRecords: PreparedRecords
  /** The agent processes and what they leave behind, until seen gone. */
  private readonly trees: AgentTrees
  readonly sessions: SessionManager
  private readonly agentHistory: AgentHistory
  /** Huli: the user's folders of sessions. */
  private readonly sessionFolders: SessionFolders
  /** Huli: the agents' network through the user's proxy subscriptions. */
  private readonly nodeProxy: NodeProxy
  /** Huli: Kite's own Node.js, for agents when the user's own is missing or too old. */
  private readonly nodeRuntime: NodeRuntimeService
  /** Huli: background web reading with Moli, downloaded once the user turns it on. */
  private readonly webReader: WebReaderService
  /** When idle Claude Code sessions let their agent go, by the setting and the system's memory. */
  private readonly idleRelease: IdleRelease
  /** The saved routines and the lifecycle of their runs. */
  readonly routines: RoutinesManager
  /** The user's workflow library. */
  readonly workflowLibrary: WorkflowLibrary
  /** The tasks that run through workflows. */
  readonly tasks: TaskEngine
  private readonly groups: SessionGroups
  /** Huli: the issue inbox, pull requests merged once green or watched, and GitHub triggers. */
  private readonly githubFlow: GithubFlow
  /** The routines' GitHub triggers the flow last planned for. */
  private flowTriggers = ''
  /** Huli: routines' webhooks, listening while one of them uses its webhook. */
  private readonly webhooks: WebhookListener
  /** Huli: each webhook routine's secret, kept encrypted by main and sent here; host only. */
  private webhookSecrets = new Map<string, string>()
  /** The cards the workflow tools leave in sessions, their answers and Start. */
  readonly workflowSuggestions: WorkflowSuggestions
  /** The attachments of drafts and queued prompts, until sent or removed. */
  readonly attachments: Attachments
  /** Every session's thread, read a page at a time, in a worker of its own. */
  readonly threads: ThreadStore | null
  /** Kettu's record and the agents' logs, in a worker of its own. */
  readonly usage: UsageManager
  /** Every project's artifacts, kept in the thread database and the data folder. */
  readonly artifacts: ArtifactStore
  /** The `kettu` MCP server, through which the sessions' agents reach the artifacts. */
  readonly artifactService: ArtifactService
  /** Kettu's memory of the user and of each project, which every session is handed. */
  readonly memory: MemoryService
  /** The artifacts' own data, which their pages and the agents read and write. */
  private readonly artifactData: ArtifactData
  /** Agents using the desktop apps of this computer; null on a host without the driver. */
  private readonly computer: ComputerUse | null
  /** Huli: the elevated helper's install in Program Files, on Windows. */
  private readonly elevatedInstall: ElevatedInstall | null
  /** What the user allowed the artifacts' pages, and the questions asking for it. */
  private readonly consents: ArtifactConsents
  /** The page runtime's requests in flight, from main and from devices' remote hosts. */
  private readonly runtimeRequests: RuntimeRequests
  /** The types artifacts are made from: their formats, guidance and exports. */
  readonly artifactTypes = new ArtifactTypes()
  readonly hub: PortHub
  private settings: HostSettings
  private readonly git: GitServiceApi | null
  /** Runs git for the project's files, with the agent environment. */
  private readonly execRunner: ExecRunner
  /** Huli: git for the file checkpoints, which reads the user's repositories and writes none. */
  private readonly checkpointGit: GitRunner
  private readonly files: FilesService
  private readonly agentFiles: AgentFiles
  /** Huli: what agents keep of the sessions deleted here. */
  private readonly copies: AgentCopies
  private readonly sessionFiles: SessionFiles
  /** Grants for the media a thread names and the Files pane opens, which main serves. */
  private readonly media: MediaService
  private gitUnsubscribe: (() => void)[] = []
  /** Ports keeping a project's git status live, by path key. */
  private readonly gitRetains = new GitRetains()
  /** Browser calls awaiting main's answer, by the id the call was given. */
  private readonly browserCalls = new Map<number, (answer: BrowserCallAnswer) => void>()
  private readonly deviceCalls = new Map<number, (answer: DeviceCallAnswer) => void>()
  private readonly terminalCalls = new Map<number, (answer: TerminalCallAnswer) => void>()
  private nextTerminalCall = 1
  // Sessions whose running turn used a terminal, told to the terminal host when the turn ends.
  private readonly terminalTurns = new Set<string>()
  // Terminals the user referenced in a message, by id, with the session it went to; null for New
  // session's, whose terminals go to the session it creates. Each allows that session's agent.
  private readonly sharedTerminals = new Map<string, string | null>()
  // Browser tabs and devices the user referenced the same way.
  private readonly sharedTabs = new Map<string, string | null>()
  private readonly sharedDevices = new Map<string, string | null>()
  /** Sessions whose running turn acted on a device, which the device host hears the end of. */
  private readonly deviceTurns = new Set<string>()
  private nextDeviceCall = 1
  private readonly deviceAccess: DeviceAccessStore
  /** Browser calls sent to the desktop apps that sent their turns. */
  private readonly deviceBrowser: DeviceBrowserCalls
  /** The running turns that use each session's page, whose end ends the page's agent state. */
  private readonly browserTurns = new BrowserTurns()
  /** The site each session's page last showed, from its calls' answers, which an asked step names. */
  private readonly browserSites = new Map<string, string>()
  /** The values of the Marketplace servers' inputs from main, held only in memory. */
  private marketKeys: MarketKeys = new Map()
  private agentEnvKeys: Record<string, Record<string, string>> = {}
  /** Huli: the container tier's engine and image, loaded on its first use. */
  private containers: Promise<ContainerSandbox> | null = null
  /** Huli: the agents' API provider profiles from main, with their keys, held only in memory. */
  private readonly profiles = new ProviderProfiles()
  /** The Marketplace's catalog of MCP servers, from the registry. */
  private readonly marketCatalog: MarketCatalogService
  /** The sign-ins of the Marketplace's OAuth servers. */
  private readonly marketConnections: MarketConnectionsService
  /** Where agents reach the OAuth servers, with a fresh token. */
  private readonly mcpProxy: McpProxy
  /** The sign-ins sent to main that no push has carried back yet, by server id. */
  private readonly unkept = new Map<string, { state: string | null; pushes: number }>()
  /** Claude Code's and Codex's plugins, through each agent's harness. */
  private readonly marketPlugins: MarketPluginsService
  /** The skills catalog, the skills Kettu keeps, and what each agent gets of them. */
  private readonly marketSkills: MarketSkillsService
  private agentSyncService: Promise<AgentSync> | null = null
  /** Huli: moving sessions to other computers, loaded at the first move. */
  private movesService: Promise<SessionMoves> | null = null
  /** The Kettu Marketplace's listings, the downloads of their files and its plugins. */
  private readonly marketCommunity: MarketCommunityService
  private readonly marketBundles: MarketBundlesService
  /** The host's Kettu account from main, while signed in with Kettu's services on. */
  private marketAccount: MarketAccount | null = null
  /** Marketplace API calls awaiting main's answer. */
  private readonly marketCalls = new Map<number, (answer: MarketCallAnswer) => void>()
  private nextMarketCall = 1
  /** Trash calls awaiting main's answer: null once done, else why not. */
  private readonly trashCalls = new Map<number, (error: string | null) => void>()
  private nextTrashCall = 1
  /** Settings calls awaiting main's or the daemon's answer. */
  private readonly settingsCalls = new Map<number, (answer: SettingsCallAnswer) => void>()
  private nextSettingsCall = 1
  /** The settings tools of Kettu's MCP service. */
  private readonly settingsTools: SettingsTools
  /** Huli: the secrets tool of Kettu's MCP service. */
  private readonly secretTools: SecretTools
  /** Huli: the theme tools of Kettu's MCP service, and their calls awaiting main's answer. */
  private readonly themeTools: ThemeTools
  private readonly themeCalls = new Map<number, (answer: ThemeCallAnswer) => void>()
  private nextThemeCall = 1
  /** Huli: the values the user saved for each project, by project path, then name; host only. */
  private projectSecrets: Record<string, Record<string, string>> = {}
  /** What was put off or refused, to publish later. */
  private readonly publishDrafts: PublishDrafts
  /** The Marketplace tools of Kettu's MCP service. */
  private readonly marketTools: MarketTools
  /** Huli: the chat bridges, loaded once one is turned on; see tools/huli/README.md (Chat apps). */
  private chatBridge: ChatBridgeService | null = null
  private chatBridgeLoad: Promise<ChatBridgeService> | null = null
  private chatBridgeConfig: ChatBridgeConfig | null = null
  private lastProcesses = '[]'
  private sentFolders: string | null = null
  private stopping: Promise<void> | null = null
  private readonly catalog: readonly AgentDefinition[]

  private constructor(private readonly options: HostOptions) {
    const { platform } = options
    this.settings = options.settings
    setLocale(options.settings.locale)
    this.diagnostics = new Diagnostics({ mirrorTraffic: options.mirrorTraffic ?? false })
    const log = this.diagnostics.log.bind(this.diagnostics)
    this.env = new EnvironmentService({
      platform,
      nodeRuntime: options.nodeRuntime,
      baseEnv: options.baseEnv,
      ...(options.resolveEnv ? { resolve: options.resolveEnv } : {}),
      ...(options.probeNode ? { probe: options.probeNode } : {}),
    })
    const catalog = buildCatalog(options.fakeAgentPath)
    this.catalog = catalog
    this.env.setProxy(options.settings.proxy)
    this.env.setConfigFolders(configFolders(catalog, options.settings))
    this.execRunner = createExec(() => this.env.agentEnv() as NodeJS.ProcessEnv)
    this.checkpointGit = createGitRunner(() => this.env.agentEnv() as NodeJS.ProcessEnv, platform)
    this.media = new MediaService({
      platform,
      homeDir: options.homeDir ?? os.homedir(),
      names: (sessionId, text) => this.sessions.names(sessionId, text),
      grant: (grant) => options.send({ type: 'host:media-grant', grant }),
    })
    this.files = new FilesService({
      exec: this.execRunner.exec,
      platform,
      media: (real, info) => this.media.grantFile(real, info, null),
      describeMedia: (real, info) => this.media.describe(real, info),
      trash: (paths) => this.trash(paths),
    })
    this.agentFiles = new AgentFiles({
      platform,
      homeDir: options.homeDir ?? os.homedir(),
      session: (sessionId) => this.sessions.agentSession(sessionId),
      read: (real, shown) => this.files.readAllowed(real, shown),
      bytes: (real, name, part) => this.files.bytesAllowed(real, name, part),
    })
    this.sessionFiles = new SessionFiles({
      platform,
      folder: (sessionId) => this.sessions.workFolder(sessionId),
      read: (folder, relative) =>
        this.filesCall(folder, (root) => this.files.read(root, relative, true)),
    })
    this.deviceAccess = new DeviceAccessStore(options.userDataPath, log)
    this.publishDrafts = new PublishDrafts(options.userDataPath, log)
    this.marketTools = new MarketTools({
      account: () => this.marketAccount,
      call: (call) => this.marketCall(call),
      ask: (sessionId, ask) => this.sessions.marketAsked(sessionId, ask, MARKET_WAIT_MS),
      settle: (sessionId, entryId, outcome) =>
        this.sessions.marketSettled(sessionId, entryId, outcome),
      tell: (sessionId, text) => {
        this.sessions.sendCardAnswer(sessionId, text).catch((error: unknown) => {
          log('warn', `Could not tell a session about its card: ${(error as Error).message}`)
        })
      },
      drafts: this.publishDrafts,
      changed: () => this.hub.broadcast({ type: 'market.publishedChanged' }),
      agentOf: (sessionId) => this.sessions.sessionAgent(sessionId),
      sessionTitle: (sessionId) => this.sessions.title(sessionId),
      taskWorkflow: async (taskId) => {
        const draft = this.tasks.writtenDraft(taskId)
        if (!draft) return null
        const text = await this.workflowSuggestions.draftText(draft)
        return { title: this.tasks.get(taskId).title, text }
      },
      taskWorkflowFolder: (taskId) => {
        try {
          return this.tasks.writtenDraft(taskId) ? this.taskPublishFolder(taskId) : null
        } catch (error) {
          if (error instanceof HostError && error.code === 'not_found') return null
          throw error
        }
      },
      home: options.homeDir ?? os.homedir(),
    })
    this.settingsTools = new SettingsTools({
      platform,
      read: () => this.settingsCall({ kind: 'read' }),
      apply: (patch) => this.settingsCall({ kind: 'change', patch }),
      local: () => this.settingsLocal(),
      fullAccess: (sessionId) => this.sessions.settingsFullAccess(sessionId),
      ask: (sessionId, ask) => this.sessions.settingsAsked(sessionId, ask, SETTINGS_WAIT_MS),
      recorded: (sessionId, items) => this.sessions.settingsRecorded(sessionId, items),
      settle: (sessionId, entryId, outcome) =>
        this.sessions.settingsSettled(sessionId, entryId, outcome),
      open: (sessionId, target) => this.openSettings(sessionId, target),
      words: tSettings,
      english: tSettingsEnglish,
    })
    const envDir = path.join(options.userDataPath, 'session-env')
    this.secretTools = new SecretTools({
      platform,
      envDir,
      saved: (project) => new Map(Object.entries(this.projectSecrets[project] ?? {})),
      save: (project, values) => options.send({ type: 'host:project-secrets', project, values }),
      loadsEnv: (sessionId) => this.sessions.loadsEnvFile(sessionId),
      ask: (sessionId, ask) => this.sessions.secretAsked(sessionId, ask, SECRET_WAIT_MS),
      answer: (sessionId, entryId, answer, device) =>
        this.sessions.answerSecret(sessionId, entryId, answer, device),
      check: (sessionId, entryId) => this.sessions.checkSecret(sessionId, entryId),
      ignored: async (folder, relative) => {
        const result = await this.execRunner.exec('git', ['check-ignore', '-q', '--', relative], {
          cwd: folder,
          timeoutMs: 10_000,
        })
        if (result.failure !== null) return null
        return result.code === 0 ? true : result.code === 1 ? false : null
      },
    })
    this.themeTools = new ThemeTools({
      read: () => this.themeCall({ kind: 'read' }),
      set: (agent, chosen) => this.themeCall({ kind: 'set', agent, chosen }),
      fullAccess: (sessionId) => this.sessions.settingsFullAccess(sessionId),
      ask: (sessionId, change) => this.sessions.themeAsked(sessionId, change, THEME_WAIT_MS),
      recorded: (sessionId, change) => this.sessions.themeRecorded(sessionId, change),
      settle: (sessionId, entryId, outcome) =>
        this.sessions.themeSettled(sessionId, entryId, outcome),
    })
    this.projects = new Projects({
      file: projectsFile(options.userDataPath, log, platform),
      platform,
      home: options.homeDir ?? os.homedir(),
      dataDir: options.userDataPath,
    })
    this.projectCreate = new ProjectCreate({
      platform,
      home: options.homeDir ?? os.homedir(),
      dataDir: options.userDataPath,
      projects: this.projects,
      // git is found, and goes out through Kite's proxy, as the rest of its git does.
      env: async () => {
        await this.env.ready()
        return this.env.agentEnv() as NodeJS.ProcessEnv
      },
      findGit: (env) => findExecutable('git', platform, env),
      exec: (file, args, execOptions) => this.execRunner.exec(file, args, execOptions),
      control: options.processControl ?? processControl(platform),
      progress: (portId, progress) =>
        this.hub.send([portId], { type: 'projects.cloneProgress', progress }),
      log,
    })
    this.scratch = new ScratchFolders(path.join(options.userDataPath, 'scratch'), platform)
    this.remembered = agentsFile(options.userDataPath, log)
    this.updates = agentUpdatesFile(options.userDataPath, log)
    this.registryListing = registryListingFile(options.userDataPath, log)
    this.harnessManifest = harnessManifestFile(options.userDataPath, log)
    this.star = new GitHubStar({
      file: gitHubStarFile(options.userDataPath, log),
      git: () => this.git,
      changed: (state) => this.broadcast({ type: 'star.changed', state }),
      log,
    })
    this.planAlerts = new PlanAlerts({
      file: planAlertsFile(options.userDataPath, log),
      alert: (alert) => {
        // Huli: the toast and the phone's alert; upstream's LimitNotices sends the notification.
        this.broadcast({ type: 'agents.limitAlert', alert })
      },
      log,
    })
    this.agentOptions = new AgentOptionsStore({
      file: agentOptionsFile(options.userDataPath, log),
      changed: (changed) =>
        this.hub.broadcast({ type: 'agent.options', options: this.withStartMode(changed) }),
    })
    this.preparedRecords = new PreparedRecords(preparedFile(options.userDataPath, log))
    this.marketCatalog = new MarketCatalogService({
      file: catalogFile(options.userDataPath, log),
      log,
    })
    this.marketConnections = new MarketConnectionsService({
      log,
      servers: () => this.settings.marketplace.mcp,
      headers: (server) => serverHeaders(server, this.marketKeys),
      keep: (serverId, state) => this.keepSignIn(serverId, state),
      changed: (serverId, connection, loginId, error) =>
        this.connectionChanged(serverId, connection, loginId, error),
    })
    this.mcpProxy = new McpProxy({
      servers: () => this.settings.marketplace.mcp,
      headers: (server) => serverHeaders(server, this.marketKeys),
      token: (serverId) => this.marketConnections.token(serverId),
      refused: (serverId, used) => this.marketConnections.refused(serverId, used),
    })
    const home = options.homeDir ?? os.homedir()
    this.marketPlugins = new MarketPluginsService({
      file: pluginsFile(options.userDataPath, log),
      log,
      platform,
      agents: () => this.installedAgents(['claude-code', 'codex']),
      program: (agentId) => this.agents.harnessProgram(agentId),
      appServer: (agentId) => this.appServer(agentId),
    })
    this.marketCommunity = new MarketCommunityService({
      userDataPath: options.userDataPath,
      pluginsRoot: path.join(home, KETTU_HOME_FOLDER, PLUGINS_FOLDER),
      file: communityFile(options.userDataPath, log),
      log,
      account: () => this.marketAccount,
      call: (call) => this.marketCall(call),
      kept: () => [
        ...[...this.settings.marketplace.skills, ...this.settings.marketplace.mcp].flatMap(
          (item) => listingIdOf(item.id) ?? [],
        ),
        ...this.workflowLibrary.listingIds(),
      ],
      installPlugin: (agentId, local, name, scope, projectPath) =>
        this.marketPlugins.installLocal(agentId, local, name, scope, projectPath),
      pluginInstalled: (harness, pluginId) =>
        this.marketPlugins.installedAnywhere(harness, pluginId),
      installWorkflow: (text, origin) => this.workflowLibrary.installListing(text, origin),
    })
    this.marketBundles = new MarketBundlesService({
      userDataPath: options.userDataPath,
      file: bundlesFile(options.userDataPath, log),
      log,
      platform,
      home,
      nodeVersion: process.versions.node,
      listing: (id) => this.marketCommunity.listing(id),
      download: (id, kind) => this.marketCommunity.download(id, kind),
      find: (command) =>
        findCommand(command, {
          platform,
          env: this.env.agentEnv() as Env,
          isExecutable: (file) => isExecutableFile(file, platform),
        }),
      servers: () => this.settings.marketplace.mcp,
    })
    void this.marketBundles.sweep()
    this.marketSkills = new MarketSkillsService({
      userDataPath: options.userDataPath,
      file: skillsCatalogFile(options.userDataPath, log),
      log,
      platform,
      home,
      settings: () => this.settings.marketplace.skills,
      agents: () => this.agents.ids().filter((id) => !this.settings.disabledAgents.includes(id)),
      configFolder: (agentId) => this.agents.configFolder(agentId),
      codexSkills: async (agentId) => {
        if ((await this.installedAgents(['codex'], [agentId])).length === 0) return null
        return (await this.appServer(agentId))<SkillsListResponse>('skills/list', { cwds: [home] })
      },
      kettu: (id) => this.marketCommunity.download(id, 'skill'),
      ownSkills: () => this.artifactService.guideFlags,
      kettuOn: (agentId) => !this.settings.mcp.kettu.off.includes(agentId),
    })
    this.trees = new AgentTrees({
      file: agentProcessesFile(options.userDataPath, log),
      control: options.processControl ?? processControl(platform),
      graceMs: STOP_TIMINGS.termMs,
      ...(options.treeNoteMs !== undefined ? { noteMs: options.treeNoteMs } : {}),
      log,
    })
    this.attachments = new Attachments({ userDataPath: options.userDataPath, log })
    const contentDir = path.join(options.userDataPath, 'artifacts', 'content')
    this.threads = options.threadWorker
      ? new ThreadStore({
          file: path.join(options.userDataPath, 'state', 'threads.db'),
          contentDir,
          createWorker: options.threadWorker,
          log,
        })
      : null
    // Huli: main's backup waits while the thread database migrates and moves its pictures out.
    if (this.threads) {
      watchMigration(this.threads, (running) => options.send({ type: 'host:migrating', running }))
    }
    this.artifacts = new ArtifactStore({
      threads: this.threads,
      contentDir,
      log,
      changed: () => {
        this.hub.broadcast({ type: 'artifacts.changed' })
        this.options.send({ type: 'host:artifacts-changed' })
      },
      version: (portIds, id, version) =>
        this.hub.send(portIds, { type: 'artifacts.version', id, version }),
      // Each port hears of the other clients showing the artifact, named as it knows them.
      activity: (portIds, activity) => {
        const showing = [...portIds]
        for (const portId of showing) {
          this.hub.send([portId], {
            type: 'artifacts.activity',
            ...activity,
            clients: this.hub.viewers(showing, portId).map((viewer) => ({
              ...viewer,
              page:
                activity.pages.get(
                  showing.find((p) =>
                    viewer.kind === 'host'
                      ? !this.hub.deviceOf(p)
                      : this.hub.deviceOf(p)?.id === viewer.id,
                  ) ?? '',
                ) ?? null,
            })),
          })
        }
      },
      comments: (portIds, id) => this.hub.send(portIds, { type: 'artifacts.comments', id }),
      seen: (id, version) => this.hub.broadcast({ type: 'artifacts.seen', id, version }),
      canvas: (portIds, event) => this.hub.send(portIds, { type: 'artifacts.canvas', ...event }),
      unwatched: (id) => this.consents.unwatched(id),
    })
    this.artifactData = new ArtifactData({ store: this.artifacts })
    registerContentCapability({ store: this.artifacts, types: this.artifactTypes })
    const computer = options.computer ?? null
    // Huli: the helper starts only when a session's call needs it.
    const helper = computer?.helperPath
      ? new ComputerHelper({ path: computer.helperPath, log })
      : null
    this.elevatedInstall =
      platform === 'win32'
        ? new ElevatedInstall({
            helper,
            client: process.execPath,
            mode: () => this.settings.computerUse.elevated,
          })
        : null
    this.computer = computer
      ? new ComputerUse({
          platform,
          driver: new ComputerDriver({ path: computer.driverPath, log }),
          helper,
          // Huli: only the copy the owner installed into Program Files runs as administrator.
          elevate:
            platform === 'win32' && helper
              ? async (pid) => {
                  const installed = await helper.layout(process.execPath)
                  if (installed.state !== 'current' || !(await this.elevatedInstall?.ready())) {
                    throw notInstalled()
                  }
                  const { sid } = await helper.whoami()
                  if (!sid) throw new Error('Windows did not name this account.')
                  return ElevatedDriver.start({
                    target: pid,
                    user: sid,
                    helper,
                    installDir: installed.installDir,
                    lang: this.settings.locale === 'zh-CN' ? 'zh-CN' : 'en',
                    log,
                  })
                }
              : null,
          foreground: (sessionId, app) => this.sessions.computerForeground(sessionId, app),
          elevatedStopped: (sessionId, app) =>
            this.sessions.computerElevatedStopped(sessionId, app),
          elevatedReady: async () => (await this.elevatedInstall?.ready()) ?? false,
          self: { pids: [computer.selfPid, process.pid], ids: computer.selfIds },
          settings: () => this.settings.computerUse,
          turnRefusal: (sessionId) => this.sessions.computerRefusal(sessionId),
          sessionTitle: (sessionId) => this.sessions.title(sessionId) ?? 'Untitled',
          asked: (sessionId, requestId, app, ask) =>
            this.sessions.computerAppAsked(sessionId, requestId, app, ask),
          settled: (requestId, answer) => this.sessions.computerAppSettled(requestId, answer),
          allowAlways: (app) => options.send({ type: 'host:computer-app-allow', app }),
          using: (sessionId, view) => this.sessions.computerUsing(sessionId, view),
          permissions: () => probePermissions({ path: computer.driverPath, log }),
          setupAsked: (sessionId, requestId, steps) =>
            this.sessions.computerSetupAsked(sessionId, requestId, steps),
          setupDone: (requestId, done) => this.sessions.computerSetupDone(requestId, done),
          setupSettled: (requestId, outcome) =>
            this.sessions.computerSetupSettled(requestId, outcome),
          stopped: (sessionId) => this.sessions.computerStopped(sessionId),
          handedBack: (sessionId, durationMs) =>
            this.sessions.controlHandedBack(sessionId, 'computer', durationMs),
          paused: (sessionId, app) => this.sessions.controlPaused(sessionId, 'computer', app),
          agent: (sessionId) => ({
            id: this.sessions.sessionAgent(sessionId) ?? '',
            name: this.sessions.agentName(sessionId),
          }),
          held: (hold) => options.send({ type: 'host:computer-hold', hold }),
          log,
        })
      : null
    this.memory = new MemoryService({
      root: path.join(options.userDataPath, 'memory'),
      log,
      projects: () => this.projects.list().map(({ path, name }) => ({ path, name })),
      claudeAgents: () => this.claudeAgents(),
      codexAgents: () => this.codexAgents(),
    })
    this.memory.onChange(() => this.hub.broadcast({ type: 'memory.changed' }))
    this.workflowLibrary = new WorkflowLibrary({
      dir: path.join(options.userDataPath, 'workflows'),
      file: workflowsFile(options.userDataPath, log),
      knownTools: () => ({
        mcp: new Set(this.settings.marketplace.mcp.flatMap((server) => [server.name, server.id])),
        skills: new Set(
          this.settings.marketplace.skills.flatMap((skill) => [skill.name, skill.id]),
        ),
      }),
      log,
      changed: () => this.broadcast({ type: 'workflows.changed' }),
    })
    this.artifactService = new ArtifactService({
      workflow: {
        library: this.workflowLibrary,
        marketplace: this.marketCommunity,
        report: (sessionId, input) => this.tasks.report(sessionId, input),
        pick: (sessionId, picks) => this.tasks.pick(sessionId, picks),
        suggestions: {
          suggest: (sessionId, input) => this.workflowSuggestions.suggest(sessionId, input),
          draft: (sessionId, text) => this.workflowSuggestions.draft(sessionId, text),
          keep: (sessionId, text) => this.workflowSuggestions.keep(sessionId, text),
        },
        isStep: (sessionId) => this.tasks.refOf(sessionId) !== null,
        agentOf: (sessionId) => this.sessions.sessionAgent(sessionId),
      },
      data: this.artifactData,
      store: this.artifacts,
      types: this.artifactTypes,
      sessionTitle: (sessionId) => this.sessions.title(sessionId),
      runningTurn: (sessionId) => this.sessions.runningTurn(sessionId),
      sessionOf: (process, id) => this.sessions.sessionOf(process, id),
      subagentCall: (process, id) => this.sessions.isSubagentCall(process, id),
      plan: { set: (sessionId, items) => this.sessions.planSet(sessionId, items) },
      report: { add: (sessionId, draft) => this.sessions.reportDrafted(sessionId, draft) },
      notify: { notify: (sessionId, note) => this.sessions.noteToUser(sessionId, note) },
      memory: {
        service: this.memory,
        projectOf: (caller) => this.projects.find(caller.project)?.path ?? null,
        written: (sessionId, write) => this.sessions.memoryWritten(sessionId, write),
        proposed: (sessionId, proposal) => this.sessions.memoryProposed(sessionId, proposal),
        agentOf: (sessionId) => this.sessions.sessionAgent(sessionId),
      },
      wrote: (sessionId, write) => this.sessions.artifactWritten(sessionId, write),
      browserCall: (request, caller) => this.browserCall(request, caller),
      browserAccess: {
        fullAccess: (sessionId) => this.sessions.surfaceAccessOf(sessionId).fullAccess,
        ask: (sessionId, tab) =>
          this.sessions.surfaceAccessAsked(
            sessionId,
            { surface: 'browser', id: tab.id, name: tab.title },
            { readOnly: false },
            SURFACE_ACCESS_WAIT_MS,
          ),
        used: (sessionId, title) => this.sessions.surfaceUsed(sessionId, 'browser', title),
        shared: (sessionId, tabId) => sharedWith(this.sharedTabs, tabId, sessionId),
      },
      browserSession: (sessionId) => this.sessions.browserSession(sessionId),
      devices: {
        call: (call) => this.deviceCall(call),
        agentName: (sessionId) => this.sessions.agentName(sessionId),
        ask: (sessionId, deviceId, deviceName) =>
          this.sessions.deviceAccessAsked(sessionId, deviceId, deviceName, DEVICE_ACCESS_WAIT_MS),
        alwaysAllowed: (deviceId) => this.deviceAccess.has(deviceId),
        fullAccess: (sessionId) => this.sessions.surfaceAccessOf(sessionId).fullAccess,
        used: (sessionId, name) => this.sessions.surfaceUsed(sessionId, 'device', name),
        shared: (sessionId, deviceId) => sharedWith(this.sharedDevices, deviceId, sessionId),
        allowAlways: (deviceId) => this.deviceAccess.add(deviceId),
      },
      terminals: {
        call: (call) => this.terminalCall(call),
        agentOf: (sessionId) => this.sessions.sessionAgent(sessionId),
        accessOf: (sessionId) => this.sessions.surfaceAccessOf(sessionId),
        ask: (sessionId, terminal, ask) =>
          this.sessions.surfaceAccessAsked(
            sessionId,
            { surface: 'terminal', id: terminal.id, name: terminal.name ?? terminal.title },
            ask,
            SURFACE_ACCESS_WAIT_MS,
          ),
        used: (sessionId, terminal) =>
          this.sessions.surfaceUsed(sessionId, 'terminal', terminal.name ?? terminal.title),
        shared: (sessionId, terminalId) => sharedWith(this.sharedTerminals, terminalId, sessionId),
      },
      sessionProject: (sessionId) => this.sessions.sessionProject(sessionId),
      sessionFolder: (sessionId) => this.sessions.sessionFolder(sessionId),
      ...(this.computer ? { computer: this.computer } : {}),
      market: this.marketTools,
      settings: this.settingsTools,
      secrets: this.secretTools,
      theme: this.themeTools,
      features: () => this.settings.features,
      webReader: { read: (caller, input) => this.webReader.read(caller, input) },
      proxy: this.mcpProxy,
      sessions: {
        info: (sessionId) => this.sessions.sessionInfo(sessionId),
        list: (projectPath) => this.sessions.toolSessions(projectPath),
        lastReply: (sessionId) => this.sessions.lastReply(sessionId),
        rename: (sessionId, title) => this.sessions.renameByAgent(sessionId, title),
        setBoard: (sessionId, status) => this.sessions.setBoardStatus(sessionId, status),
        work: (sessionId) => this.sessions.runningWork([sessionId]),
        archiveAfterTurn: (sessionId, agentName) =>
          this.sessions.archiveWhenIdle(sessionId, agentName),
        archiveNow: (sessionId, agentName) => this.sessions.archiveByAgent(sessionId, agentName),
        start: (callerId, params) => this.sessions.startFromTool(callerId, params),
        send: (sessionId, text, from, now) =>
          this.sessions.sendFromTool(sessionId, text, from, now),
        started: (callerId) => this.sessions.startedBy(callerId),
        name: (sessionId) => this.sessions.toolName(sessionId),
        agentName: (sessionId) => this.sessions.agentName(sessionId),
        agentLabel: (agentId) => this.agents.name(agentId),
        agents: () => this.agents.statuses(),
        history: (sessionId) => this.sessions.historyTurns(sessionId),
        mode: (sessionId) => this.sessions.toolMode(sessionId),
        starterRank: (sessionId) => this.sessions.starterRank(sessionId),
        startMode: (agentId) => startModeIn(this.settings, agentId),
        sendRefusal: (callerId, sessionId) =>
          this.sessions.manager.sendRefusal(callerId, sessionId),
        referenced: (callerId, sessionId) => this.sessions.referencedBy(callerId, sessionId),
      },
      manager: () => this.sessions.manager,
      log,
      appVersion: options.appVersion,
    })
    const usageStore = options.usageWorker
      ? new UsageStore({
          file: path.join(options.userDataPath, 'state', 'usage.db'),
          createWorker: options.usageWorker,
          log,
          onChanged: () => this.usage.rowsChanged(),
          onProgress: (progress) => this.usage.progressed(progress),
          onStatus: (status) => this.usage.storeStatus(status),
        })
      : null
    this.usage = new UsageManager({
      store: usageStore,
      readers: options.usageReaders ?? LOG_READERS,
      fromComputer: options.settings.usage.fromComputer,
      platform,
      home: options.homeDir ?? os.homedir(),
      env: async (agentId) => {
        await this.env.ready()
        return this.env.agentEnv(agentId)
      },
      isScratch: (folder) => this.scratch.contains(folder),
      worktreeProject: (folder) => this.sessions.worktreeProject(folder),
      session: (agentId, agentSessionId) => this.sessions.usageSession(agentId, agentSessionId),
      log,
      changed: () => this.hub.broadcast({ type: 'usage.changed' }),
      status: (status) => this.hub.broadcast({ type: 'usage.status', status }),
      ...(options.usageTimings ? { timings: options.usageTimings } : {}),
    })
    const adaptersDir = harnessesFolder(options)
    this.copies = new AgentCopies({
      platform,
      configFolder: (agentId) => this.agents.configFolder(agentId),
      env: (agentId) => this.env.agentEnv(agentId),
      homeDir: options.homeDir ?? os.homedir(),
      log,
    })
    this.agents = new AgentManager({
      catalog,
      platform,
      nodeRuntime: options.nodeRuntime,
      appVersion: options.appVersion,
      env: this.env,
      diagnostics: this.diagnostics,
      acpMessages: this.acpMessages,
      launcher: options.launcher ?? processLauncher(platform),
      settings: () => this.settings,
      reportsDir: path.join(options.userDataPath, 'agent-reports'),
      adaptersDir,
      sessionRouterPath: options.sessionRouterPath ?? null,
      clineHostPath: options.clineHostPath ?? null,
      ...(options.detect ? { detect: options.detect } : {}),
      ...(options.protocols ? { protocols: options.protocols } : {}),
      ...(options.drivers ? { drivers: options.drivers } : {}),
      ...(options.agentTimings ? { timings: options.agentTimings } : {}),
      status: (status) => {
        this.hub.broadcast({ type: 'agent.status', status })
        this.planAlerts.observe(status)
        this.limitsNoticed(status)
        this.routines.limitsChanged(status.id)
        this.tasks?.recheck()
      },
      removed: (agentId) => this.hub.broadcast({ type: 'agent.removed', agentId }),
      processes: (processes) => this.reportProcesses(processes),
      trees: this.trees,
      authCommands: (commands) => options.send({ type: 'host:auth-commands', commands }),
      remember: (file) => this.remembered.save(file),
      rememberUpdates: (file) => this.updates.save(file),
      rememberRegistry: (file) => this.registryListing.save(file),
      rememberManifest: (file) => this.harnessManifest.save(file),
      ...(options.userAgent ? { userAgent: options.userAgent } : {}),
      launchEnv: (agentId, env) => ({
        ...this.marketSkills.launchEnv(agentId, env),
        ...(this.agentEnvKeys[agentId] ?? {}),
      }),
      envKeyIsSet: (agentId, variable) =>
        typeof this.agentEnvKeys[agentId]?.[variable] === 'string',
      envKeyNames: (agentId) => Object.keys(this.agentEnvKeys[agentId] ?? {}),
      containers: () => this.containerSandbox(),
      dataDir: options.userDataPath,
      profiles: (agentId) => ({
        view: this.profiles.view(agentId),
        balances: this.profiles.balancesOf(agentId),
      }),
      readProfileBalances: (agentId, force) => {
        void this.profiles.readBalances(agentId, force).then(
          (changed) => {
            if (changed) this.agents.profilesChanged(agentId)
          },
          (error: unknown) =>
            this.diagnostics.log('warn', `Could not read the profiles' balances: ${String(error)}`),
        )
      },
      ...(options.secretStore ? { secretStore: options.secretStore } : {}),
      copies: this.copies,
    })
    const routineHooks: RoutineSessionHooksRef = { current: null }
    const taskHooks: TaskSessionHooksRef = { current: null }
    this.worktrees = new WorktreeManager({
      git: createWorktreeGit({
        exec: this.execRunner.exec,
        platform,
        homeDir: options.homeDir ?? os.homedir(),
      }),
      platform,
      settings: (projectPath) => this.projects.worktreeSettings(projectPath),
      root: () => this.settings.git.worktreeRoot,
      env: async () => {
        await this.env.ready()
        return this.env.agentEnv() as NodeJS.ProcessEnv
      },
      takenByPullRequest: (projectPath, branch) =>
        this.git?.branchPullRequests(projectPath).has(branch) ?? false,
      severalFolders: (projectPath) => this.projects.folders(projectPath).length > 0,
      log,
    })
    this.idleRelease = new IdleRelease({
      platform,
      settings: () => this.settings.idleSessions,
      log: (level, message) => this.diagnostics.log(level, message),
      changed: () => {
        this.sessions.idleRulesChanged()
        this.hub.broadcast({ type: 'idleRelease.changed', state: this.idleRelease.state() })
      },
    })
    this.sessions = new SessionManager({
      platform,
      agents: this.agents,
      managerGit: managerGit(this.execRunner.exec),
      projects: this.projects,
      autoApprove: () => this.settings.autoApprove ?? 'off',
      sandbox: () => this.settings.sandbox,
      agentProxyPort: (agentId) => this.nodeProxy.portFor(agentId),
      scratch: this.scratch,
      worktrees: this.worktrees,
      file: sessionsFile(options.userDataPath, log),
      returned: returnedFile(options.userDataPath, log),
      fileCheckpoints: new FileCheckpoints({
        root: path.join(options.userDataPath, 'checkpoints'),
        run: this.checkpointGit.run,
        platform,
        log,
      }),
      deleted: new DeletedSessions(deletedSessionsFile(options.userDataPath, log)),
      projectMcp: new ProjectMcpAnswers(projectMcpFile(options.userDataPath, log)),
      projectHooks: new ProjectHooksAnswers(projectHooksFile(options.userDataPath, log)),
      portOpen: (portId) => this.hub.has(portId),
      portDevice: (portId) => this.hub.deviceOf(portId),
      profiles: this.profiles,
      envFiles: {
        of: (sessionId) => sessionEnvFiles(envDir, sessionId, platform).sh,
        remove: (sessionId) => removeSessionEnv(envDir, sessionId, platform),
      },
      threads: this.threads,
      agentFile: (sessionId, file) =>
        this.agentFiles.read(sessionId, file).then(
          (content) => (content.kind === 'text' ? content.text : null),
          (error: unknown) => {
            log('warn', `Could not read ${file}: ${(error as Error).message}`)
            return null
          },
        ),
      projectFile: (sessionId, file) =>
        this.sessionFiles.text(sessionId, file).catch((error: unknown) => {
          log('warn', `Could not read ${file}: ${(error as Error).message}`)
          return null
        }),
      reportsDir: path.join(options.userDataPath, 'agent-reports'),
      attachments: this.attachments,
      mcp: {
        servers: (sessionId, record, connection) => {
          const gateway = this.agents.toolGateway(record.agentId)
          return this.agents.mcpServersByName(record.agentId)
            ? this.artifactService.folderServers(connection, record.projectPath, sessionId, gateway)
            : this.artifactService.servers(sessionId, record.projectPath, gateway)
        },
        library: (sessionId, record, connection, transports, taken) =>
          libraryServers(
            this.settings.marketplace.mcp,
            this.marketKeys,
            record.agentId,
            transports,
            {
              platform,
              taken,
              node: options.nodeRuntime,
              also: record.task ? (this.tasks.toolsOf(record.task)?.mcp ?? []) : [],
              oauth: {
                access: (server) => this.marketConnections.access(server),
                bearer: () =>
                  this.artifactService.bearer(
                    sessionId,
                    record.projectPath,
                    this.agents.mcpServersByName(record.agentId) ? connection : null,
                  ),
              },
            },
          ),
        detached: (sessionId) => {
          this.artifactService.revoke(sessionId)
          this.artifacts.stopUsing(sessionId)
          this.computer?.forget(sessionId)
          this.browserSites.delete(sessionId)
        },
        guide: (agentId) =>
          this.artifactService.guidePrompt(
            this.marketSkills.takesSkills(agentId),
            this.agents.toolGateway(agentId),
          ),
        turnEnded: (sessionId) => {
          this.artifacts.stopUsing(sessionId)
          this.computer?.turnEnded(sessionId)
          this.browserTurnEnded(sessionId)
          this.marketTools.turnEnded(sessionId)
          this.settingsTools.turnEnded(sessionId)
          this.secretTools.turnEnded(sessionId)
          this.themeTools.turnEnded(sessionId)
          if (this.deviceTurns.delete(sessionId)) {
            this.options.send({ type: 'host:device-turn-ended', sessionId })
          }
          if (this.terminalTurns.delete(sessionId)) {
            this.options.send({ type: 'host:terminal-turn-ended', sessionId })
          }
        },
      },
      skills: (record, kettu) =>
        this.marketSkills.sessionOptions(
          record.agentId,
          kettu,
          record.task ? (this.tasks.toolsOf(record.task)?.skills ?? []) : [],
        ),
      memory: this.memory,
      usage: this.usage,
      cacheTtl:
        options.cacheTtl ??
        claudeCacheTtl({
          platform,
          home: options.homeDir ?? os.homedir(),
          env: async () => {
            await this.env.ready()
            return this.env.agentEnv('claude-code')
          },
          log,
        }),
      modelRequests: byHarness(
        {
          'claude-code': claudeModelRequests({
            platform,
            home: options.homeDir ?? os.homedir(),
            env: async () => {
              await this.env.ready()
              return this.env.agentEnv('claude-code')
            },
          }),
          codex: codexModelRequests({
            home: options.homeDir ?? os.homedir(),
            env: async () => {
              await this.env.ready()
              return this.env.agentEnv('codex')
            },
          }),
          opencode: opencodeModelRequests({ sessions: (agentId) => this.agents.openCode(agentId) }),
          cline: clineModelRequests({
            home: options.homeDir ?? os.homedir(),
            env: async () => {
              await this.env.ready()
              return this.env.agentEnv('cline')
            },
          }),
        },
        acpModelRequests(this.acpMessages),
      ),
      outside:
        options.outside ??
        claudeOutside({
          platform,
          home: options.homeDir ?? os.homedir(),
          env: async () => {
            await this.env.ready()
            return this.env.agentEnv('claude-code')
          },
          log,
          // Huli: its own Claude Code under a test entry point is no terminal's.
          ownEntrypoint: () => this.settings.claudeTestEntrypoint,
          ownProcess: (pid) => this.trees.owns(pid),
        }),
      idleRelease: this.idleRelease,
      diagnostics: this.diagnostics,
      git: () => this.git,
      prFlowChanged: () => void this.githubFlow.refresh(),
      options: this.agentOptions,
      settings: () => this.settings,
      ...(options.sessionTimings ? { timings: options.sessionTimings } : {}),
      prepared: this.preparedRecords,
      copies: this.copies,
      settingsTargets: (agentId, folder) =>
        settingsTargets(
          agentId,
          folder,
          (name) => this.env.get(name, agentId),
          options.homeDir ?? os.homedir(),
          platform,
        ),
      routine: routineHooks,
      task: taskHooks,
      cards: {
        waiting: (sessionId) => this.workflowSuggestions.waitingCount(sessionId),
        turnStarted: (sessionId) => void this.workflowSuggestions.turnStarted(sessionId),
      },
      events: {
        patches: (batch, portIds) => this.hub.send(portIds, { type: 'session.patches', batch }),
        summary: (summary, portIds) => {
          if (portIds) {
            this.hub.send(portIds, { type: 'session.summary', summary })
            return
          }
          this.hub.broadcast({ type: 'session.summary', summary })
          if (summary.scratch || summary.worktree) this.sendFolders()
        },
        removed: (sessionId, portIds) => {
          if (portIds) {
            this.hub.send(portIds, { type: 'session.removed', sessionId })
            return
          }
          this.hub.broadcast({ type: 'session.removed', sessionId })
          this.sendFolders()
        },
        ended: (sessionIds) => options.send({ type: 'host:sessions-ended', sessionIds }),
        returned: (sessionId, portIds) => {
          if (portIds) this.hub.send(portIds, { type: 'session.returned', sessionId })
          else this.hub.broadcast({ type: 'session.returned', sessionId })
        },
        viewers: (sessionId, showing, to) => {
          for (const portId of to) {
            const viewers = this.hub.viewers(showing, portId)
            this.hub.send([portId], { type: 'session.viewers', sessionId, viewers })
          }
        },
        attention: (sessionId, kind, title, body, request) => {
          if (kind === 'error') this.sessionFailed(sessionId)
          options.send({
            type: 'host:attention',
            sessionId,
            kind,
            title,
            body,
            ...(request?.allow
              ? { allowOnce: { requestId: request.id, optionId: request.allow.optionId } }
              : {}),
            ...(request ? { request } : {}),
            front: this.front(sessionId),
          })
        },
        badge: (count) => options.send({ type: 'host:badge', count }),
        waiting: (sessions) => options.send({ type: 'host:waiting', sessions }),
        progress: (sessions) => options.send({ type: 'host:progress', sessions }),
        seen: (sessionId) => options.send({ type: 'host:seen', sessionId }),
        busy: (counts) => options.send({ type: 'host:busy-changed', ...counts }),
        completed: () => void this.star.turnCompleted(),
        mcpChanged: (sessionId, login, portIds) =>
          this.hub.send(portIds, {
            type: 'session.mcpChanged',
            sessionId,
            ...(login ? { login } : {}),
          }),
      },
    })
    this.agentHistory = new AgentHistory({
      platform,
      agents: this.agents,
      sessions: this.sessions,
      desktopFolders: () =>
        claudeDesktopFolders({
          platform,
          env: options.baseEnv,
          home: options.homeDir ?? os.homedir(),
        }),
      log,
    })
    this.sessionFolders = new SessionFolders({
      file: sessionFoldersFile(options.userDataPath, log),
      isSession: (id) => this.sessions.has(id),
      changed: (folders) => this.hub.broadcast({ type: 'folders.changed', folders }),
    })
    this.nodeProxy = new NodeProxy({
      userDataPath: options.userDataPath,
      platform,
      mihomoPath: options.mihomoPath ?? null,
      log,
      subscriptions: subscriptionsFile(options.userDataPath, log),
      state: networkStateFile(options.userDataPath, log),
      settings: () => this.settings.agentNetwork ?? DEFAULT_AGENT_NETWORK,
      agentIds: () => this.agents.ids(),
      // The subscriptions' names and hosts are the owner's alone: no device hears them.
      changed: (status) => this.hub.sendToWindows({ type: 'agentNetwork.changed', status }),
      routesChanged: (agentIds) => {
        for (const agentId of agentIds) {
          void this.agents.networkChanged(agentId).catch((error: unknown) => {
            log('warn', `Could not restart ${agentId} for its network: ${(error as Error).message}`)
          })
        }
      },
      systemProxy: (agentId) => {
        const read = (name: string) =>
          this.env.get(name, agentId) ?? this.env.get(name.toLowerCase(), agentId) ?? null
        return { proxy: read('HTTPS_PROXY') ?? read('ALL_PROXY'), noProxy: read('NO_PROXY') }
      },
      // Subscriptions download the way Kite's own requests go: Advanced › Proxy, else the
      // environment's proxy, else directly; never through a node.
      ownProxy: () => this.ownProxy(),
      ...(options.detectInterface ? { detect: options.detectInterface } : {}),
    })
    this.env.setNodeRoutes((agentId) => this.nodeProxy.portFor(agentId))
    const nodeRequired = strictestRequirement(catalog.map((def) => def.requiresNode))
    this.nodeRuntime = new NodeRuntimeService({
      root: nodeRuntimesFolder(options.userDataPath),
      file: nodeRuntimeFile(options.userDataPath, log),
      platform,
      arch: process.arch,
      musl: () => platform === 'linux' && isMusl(),
      required: nodeRequired,
      // The way Kite's own requests go, as subscriptions download: never through a node.
      transport: httpTransport(() => routeFor(this.ownProxy())),
      log,
      apply: (setup) => this.nodeSetupChanged(setup),
      changed: () => this.env.notify(),
    })
    this.env.setInstallStatus(() => this.nodeRuntime.status())
    this.webReader = new WebReaderService({
      root: moliRoot(options.userDataPath),
      platform,
      arch: process.arch,
      musl: () => platform === 'linux' && isMusl(),
      // Downloaded the way Kite's own requests go, never through an agent's node.
      transport: httpTransport(() => routeFor(this.ownProxy())),
      log,
      on: () => this.featureOn('webReader'),
      egress: (sessionId) => {
        const agentId = this.sessions.sessionAgent(
          this.sessions.browserSession(sessionId) ?? sessionId,
        )
        if (!agentId) return null
        // The agent's own way out: its node's listener, else Kite's proxy, as its commands get it.
        const env = this.env.agentEnv(agentId)
        const read = (name: string) =>
          getEnv(env, name, platform) ?? getEnv(env, name.toLowerCase(), platform) ?? null
        return {
          proxy: read('HTTPS_PROXY') ?? read('ALL_PROXY') ?? read('HTTP_PROXY'),
          noProxy: read('NO_PROXY'),
        }
      },
      place: (sessionId) =>
        this.sessions.webReadPlace(this.sessions.browserSession(sessionId) ?? sessionId),
      ownExit: (sessionId) => {
        const agentId = this.sessions.sessionAgent(
          this.sessions.browserSession(sessionId) ?? sessionId,
        )
        return agentId !== null && this.nodeProxy.portFor(agentId) !== null
      },
      baseEnv: () => process.env,
      changed: (status) => this.hub.sendToWindows({ type: 'webReader.changed', status }),
    })
    void this.env.setNodeSetup({ required: nodeRequired })
    this.routines = new RoutinesManager({
      userDataPath: options.userDataPath,
      file: routinesFile(options.userDataPath, log),
      threads: this.threads,
      sessions: {
        createRun: (params) => this.sessions.createRun(params),
        continueRun: (sessionId, agentId, mode, text) =>
          this.sessions.continueRun(sessionId, agentId, mode, text),
        cancel: (sessionId) => this.sessions.cancel(sessionId),
        delete: (sessionId) => this.sessions.delete(sessionId),
        has: (sessionId) => this.sessions.has(sessionId),
        summary: (sessionId) =>
          this.sessions.has(sessionId) ? this.sessions.summary(sessionId) : null,
      },
      agents: {
        limits: (agentId) => this.agents.limitsOf(agentId),
        modelOption: (agentId) =>
          this.agentOptions.get(agentId)?.config.find((option) => option.category === 'model'),
        readLimits: (agentId) => this.agents.refreshLimits(agentId),
        name: (agentId) => this.agents.name(agentId),
        statuses: () => this.agents.statuses(),
      },
      log,
      resolveProject: (value) => this.projects.resolveDirectory(value),
      timings: options.routineTimings,
      ...(options.routineClock ? { clock: options.routineClock } : {}),
      webhook: (routine) => ({
        secret: this.webhookSecrets.has(routine.id),
        port: this.webhooks.port,
        error: this.webhooks.error,
      }),
      events: {
        changed: (routine) => {
          this.broadcast({ type: 'routine.changed', routine })
          if (routine.trigger.kind !== 'webhook') this.forgetWebhookSecret(routine.id)
          this.routineTriggersChanged()
        },
        removed: (routineId) => {
          this.broadcast({ type: 'routine.removed', routineId })
          this.forgetWebhookSecret(routineId)
          this.routineTriggersChanged()
        },
        run: (run) => this.broadcast({ type: 'routine.run', run }),
        working: (working) => options.send({ type: 'host:routines-working', working }),
        attention: (kind, sessionId, title, body) =>
          options.send({
            type: 'host:attention',
            sessionId,
            kind,
            title,
            body,
            front: this.front(sessionId),
          }),
        paused: (agentId, title, body) =>
          options.send({ type: 'host:attention', kind: 'routine-paused', agentId, title, body }),
      },
    })
    routineHooks.current = this.routines.hooks
    this.webhooks = new WebhookListener({
      log,
      secret: (routineId) =>
        this.routines.takesWebhook(routineId) ? this.webhookSecrets.get(routineId) : undefined,
      run: (routineId, body) =>
        this.routines.runOnWebhook(routineId, (prompt) =>
          webhookPrompt(prompt, body, {
            header: t('routines.webhookHeader'),
            binary: t('routines.webhookBinary', { bytes: body.bytes }),
            empty: t('routines.webhookEmpty'),
          }),
        ),
      changed: () => this.routines.webhooksChanged(),
    })
    const threads = this.threads
    this.tasks = new TaskEngine({
      store: threads
        ? {
            put: (task) => threads.task('put', { task }),
            all: () => threads.task('all', undefined),
            remove: (taskId) => threads.task('remove', { taskId }),
          }
        : { put: async () => null, all: async () => [], remove: async () => null },
      library: this.workflowLibrary,
      sessions: {
        createStep: (params) => this.sessions.createStep(params),
        send: (sessionId, text, due) => this.sessions.sendFromKettu(sessionId, text, due),
        cancel: (sessionId) => this.sessions.cancel(sessionId),
        delete: (sessionId) => this.sessions.delete(sessionId),
        has: (sessionId) => this.sessions.has(sessionId),
      },
      titleTask: (sessionId, text) => this.sessions.titleTask(sessionId, text),
      worktrees: {
        create: (projectPath, request, first) =>
          first
            ? this.sessions.createTaskWorktree(projectPath, request, first)
            : this.worktrees.create(projectPath, request),
        remove: async (projectPath, record, branch) => {
          const expected = await this.worktrees.inspect(projectPath, record)
          // Nothing the user was not shown is thrown away: a dirty worktree stays.
          if (expected.uncommitted > 0) return
          await this.worktrees.remove(projectPath, record, { branch, expected })
        },
      },
      git: createTaskGit(this.execRunner.exec),
      documents: {
        written: (artifactId, sessionId, since) =>
          this.documentWritten(artifactId, sessionId, since),
        openComments: async (artifactId) =>
          (await this.artifacts.threads(artifactId))
            .filter((thread) => thread.resolvedAt === null)
            .map((thread) => thread.comments.map((comment) => comment.body).join(' / ')),
      },
      resolveProject: (value) => this.projects.resolveDirectory(value),
      agents: () =>
        workflowAgents({
          statuses: this.agents.statuses(),
          options: (agentId) => this.agentOptions.get(agentId),
          catalog: this.catalog,
          marketplace: this.settings.marketplace,
        }),
      optionsOf: (pick) => optionsOfPick(this.agentOptions.get(pick.agentId), pick),
      pickOf: (agentId, values) => pickOfOptions(this.agentOptions.get(agentId), agentId, values),
      events: {
        changed: (task) => this.broadcast({ type: 'task.changed', task }),
        removed: (taskId) => this.broadcast({ type: 'task.removed', taskId }),
        attention: (task, kind) => this.taskAttention(task, kind),
        ended: (view, written) => void this.taskEnded(view, written),
      },
      workingLimit: () => this.settings.workflow.maxWorkingSteps,
      pullRequests: (sessionIds) =>
        sessionIds.flatMap((id) =>
          this.sessions.has(id) ? (this.sessions.summary(id).prs ?? []).map((pr) => pr.url) : [],
        ),
      log,
    })
    taskHooks.current = this.tasks
    const attachments = this.attachments
    this.groups = new SessionGroups({
      sessions: this.sessions,
      git: createGroupGit(this.execRunner.exec),
      exec: this.execRunner.exec,
      copyAttachment: (id) => ({
        type: 'ref',
        ref: { kind: 'attachment', attachment: attachments.copy(id) },
      }),
      releaseAttachments: (ids) => void attachments.release(ids),
      agentName: (agentId) => this.agents.name(agentId),
      log,
    })
    const sessions = this.sessions
    this.githubFlow = new GithubFlow({
      exec: this.execRunner.exec,
      home: os.homedir(),
      tools: () => this.gitCall((git) => git.tools()),
      repoOf: async (folder) => {
        const status = await this.gitCall((git) => git.status(folder))
        return status.remote?.github ?? null
      },
      // Huli: with GitHub automation off it reads nothing, so it keeps no timer.
      sessions: {
        flows: () => (this.featureOn('github') ? sessions.prFlows() : []),
        update: (sessionId, url, change) => sessions.updatePrFlow(sessionId, url, change),
        setState: (sessionId, state) => sessions.setPrFlowState(sessionId, state),
        note: (sessionId, severity, title, description) =>
          sessions.flowNote(sessionId, severity, title, description),
        tell: (sessionId, text) => sessions.tellFromHost(sessionId, text),
        closeMerged: (sessionId, headOid) => sessions.closeMerged(sessionId, headOid),
      },
      routines: {
        triggers: () => (this.featureOn('github') ? this.routines.eventTriggers() : []),
        idle: (routineId) => this.routines.idleForEvent(routineId),
        fire: (routineId, cause, context) => this.routines.runOnEvent(routineId, cause, context),
      },
      file: githubFlowFile(options.userDataPath, log),
      log: (level, message) => log(level, message),
    })
    const taskGit = createTaskGit(this.execRunner.exec)
    this.workflowSuggestions = new WorkflowSuggestions({
      file: suggestionsFile(options.userDataPath, log),
      dir: path.join(options.userDataPath, 'workflow-cards'),
      library: this.workflowLibrary,
      market: {
        workflows: () => this.marketCommunity.publicWorkflows(),
        text: (listingId, version) => this.marketCommunity.workflowText(listingId, version),
        add: (listing, text) => this.marketCommunity.addWorkflowVersion(listing, text),
      },
      tools: {
        kept: () => this.settings.marketplace,
        connected: (serverId) => this.marketConnections.view()[serverId]?.state === 'connected',
        resolve: (kind, ref) => this.marketTool(kind, ref),
        install: (tool) => this.installMarketTool(tool),
      },
      tasks: {
        start: (params, from, given) => this.tasks.start(params, from, given),
        pastRuns: (workflowId) => this.tasks.pastRuns(workflowId),
        draftIds: () => this.tasks.draftIds(),
      },
      sessions: {
        agentOf: (sessionId) => this.sessions.sessionAgent(sessionId),
        projectOf: (sessionId) => this.sessions.sessionProject(sessionId),
        tell: (sessionId, text) => this.sessions.sendCardAnswer(sessionId, text),
      },
      isRepo: (projectPath) => taskGit.isRepo(projectPath),
      changed: (suggestion) => {
        this.broadcast({ type: 'workflows.suggestion', suggestion })
        if (this.sessions.has(suggestion.sessionId))
          this.sessions.cardsChanged(suggestion.sessionId)
      },
      log,
    })
    this.consents = new ArtifactConsents({
      store: this.artifacts,
      isDevice: (portId) => this.hub.deviceOf(portId) !== null,
      send: (portIds, event) => this.hub.send(portIds, event),
      broadcast: (event) => this.hub.broadcast(event),
      agentName: async (folder) => (await this.sampleAgent(this.projectOf(folder)))?.name ?? null,
    })
    registerCapability(dbCapability(this.artifactData))
    registerCapability(filesCapability(platform))
    registerCapability(
      sampleCapability({
        agentFor: (project) => this.sampleAgent(project),
        answer: (agent, question) => this.answerQuestion(agent, question),
      }),
    )
    this.runtimeRequests = new RuntimeRequests(
      new RuntimeDispatcher({
        artifact: (id) => this.declaredArtifact(id),
        project: (folder) => this.projectOf(folder),
        allowed: (id, capability) => this.consents.allowed(id, capability),
        ask: (artifact, capability, client, waitMs) =>
          this.consents.ask(artifact, capability, client, waitMs),
        log,
      }),
    )
    this.deviceBrowser = new DeviceBrowserCalls({
      send: (portId, event) => this.hub.send([portId], event),
      servicePort: () => this.artifactService.listeningPort,
    })
    this.hub = new PortHub({
      handlers: this.gatedHandlers(this.handlers()),
      validators: createValidators(platform),
      closed: (portId) => this.portClosed(portId),
      log,
    })
    this.projects.onChange((projects, noProject) => {
      this.broadcast({ type: 'projects.changed', projects, noProject })
      this.sendFolders()
    })
    this.env.onChange((info) => {
      this.broadcast({ type: 'environment.changed', info })
      this.git?.setEnvironment(this.env.agentEnv() as NodeJS.ProcessEnv)
    })
    // As Reload does: the fallback's PATH may have missed programs the login shell's finds.
    this.env.onRecovered(() => {
      void (async () => {
        await this.agents.redetect()
        if (this.git) await this.gitCall((g) => g.reloadTools())
      })().catch((error: unknown) =>
        log('warn', `Could not detect the agents again: ${(error as Error).message}`),
      )
    })
    this.git =
      typeof options.git === 'function'
        ? options.git({
            env: this.env.agentEnv() as NodeJS.ProcessEnv,
            log: (level, message) => log(level, `git: ${message}`),
          })
        : (options.git ?? null)
    if (this.git) this.wireGit(this.git)
  }

  /** Loads the state, answers `host:ready`, and resolves the environment in the background. */
  static async start(options: HostOptions): Promise<AgentHost> {
    await moveHarnessInstalls(
      path.join(options.userDataPath, 'agents'),
      harnessesFolder(options),
      (message) => writeLog('warn', 'host', message),
    )
    // Huli: what needs the user goes to the chat bridges as well as to main's notifications.
    let started: AgentHost | null = null
    const host = new AgentHost({
      ...options,
      send: (message) => {
        options.send(message)
        if (message.type === 'host:attention' && 'sessionId' in message && message.sessionId) {
          started?.chatBridge?.attention({ ...message, sessionId: message.sessionId })
        }
      },
    })
    started = host
    const [, , , remembered, updates, listing, manifest] = await Promise.all([
      host.scratch.ready(),
      host.projects.load(),
      host.sessions.load(),
      host.remembered.load(),
      host.updates.load(),
      host.registryListing.load(),
      host.harnessManifest.load(),
      host.trees.load(),
      host.agentOptions.load(),
      host.preparedRecords.load(),
      host.attachments.load(),
      host.artifactService.start(),
      host.routines.load(),
      host.memory.load(),
      host.workflowLibrary.load(),
      host.sessionFolders.load(),
      host.nodeProxy.load(),
      // Before the first detection, so agents start on Kite's own Node.js when they should.
      host.nodeRuntime
        .load()
        .then((setup) => host.env.setNodeSetup(setup))
        .catch((error: unknown) =>
          writeLog('warn', 'host', `Kite's Node.js: ${(error as Error).message}`),
        ),
      host.workflowSuggestions.load(),
    ])
    // Huli: once both the projects and the sessions are in.
    host.sessions.adoptOutsideScratch()
    // After the sessions, whose step sessions it messages when it resumes.
    await host.tasks.load()
    // After the tasks, whose drafts keep their texts.
    await host.workflowSuggestions.sweep()
    host.agents.restore(remembered)
    host.agents.restoreRegistry(listing)
    host.agents.restoreManifest(manifest)
    host.agents.restoreUpdates(updates)
    void host.moveLocalMarketplaces()
    host.routines.setOn(host.featureOn('routines'))
    // Huli: reads GitHub only for what a session or a routine turned on.
    host.routineTriggersChanged()
    void host.githubFlow.refresh()
    void host.marketSkills.sync()
    host.sendFolders()
    void host.sessions.checkWorktrees()
    host.usage.start()
    host.artifacts.start()
    host.idleRelease.start()
    host.nodeProxy.start()
    options.send({ type: 'host:service-port', port: host.artifactService.listeningPort })
    options.send({ type: 'host:ready' })
    void host.trees.stopLeftovers()
    host.agents.startLimitReads()
    void host.agents.removeAntigravityUsageServer()
    void host.agents.detectAll().then(() => {
      host.agents.scheduleUpdateChecks()
      host.agents.scheduleRegistryReads()
      host.firstStart()
    })
    return host
  }

  /**
   * The first start of this host: names the programs it found for the settings' owner to add
   * their agents. A host whose login shell could not be read waits for the next start, since
   * the programs on its `PATH` may be missing.
   */
  /** Huli: made on the first container session or status request, never at startup. */
  private containerSandbox(): Promise<ContainerSandbox> {
    this.containers ??= import('./sandbox/container').then(
      ({ ContainerSandbox }) =>
        new ContainerSandbox({
          platform: this.options.platform,
          // The engine's own program goes through the proxy Kite's settings name, as git does.
          env: () => this.env.agentEnv(),
          dataDir: this.options.userDataPath,
          log: (level, message) => this.diagnostics.log(level, message),
        }),
    )
    return this.containers
  }

  private firstStart(): void {
    if (this.settings.initialSetupDone || this.env.info().source === 'fallback') return
    this.options.send({ type: 'host:first-start', harnesses: this.agents.userPrograms() })
  }

  /** The Claude Code agents of this host and their configuration folders, for memory's import. */
  private claudeAgents(): { agentId: AgentId; name: string; configDir: string }[] {
    return this.agents.ids().flatMap((agentId) => {
      if (harnessOf(agentId) !== 'claude-code') return []
      const configDir = this.agents.configFolder(agentId)
      return configDir ? [{ agentId, name: this.agents.name(agentId), configDir }] : []
    })
  }

  /** Huli: the Codex agents of this host and their homes, for memory's import. */
  private codexAgents(): { agentId: AgentId; name: string; home: string }[] {
    return this.agents.ids().flatMap((agentId) => {
      if (harnessOf(agentId) !== 'codex') return []
      const home = this.agents.configFolder(agentId)
      return home ? [{ agentId, name: this.agents.name(agentId), home }] : []
    })
  }

  private wireGit(git: GitServiceApi): void {
    git.setBackgroundFetch(this.settings.git.backgroundFetch)
    this.gitUnsubscribe = [
      git.onChanged((status) =>
        this.sendToRetainers(status.projectPath, { type: 'git.changed', status }),
      ),
      git.onPullRequest((projectPath, pr) =>
        this.sendToRetainers(projectPath, { type: 'git.pr', projectPath, pr }),
      ),
      git.onTools((tools) => {
        this.broadcast({ type: 'git.tools', tools })
        this.star.recheck()
      }),
      git.onBranchPullRequests((projectPath) => this.sessions.pullRequestsChanged(projectPath)),
      git.onReferenceChanged((url, found) => {
        this.hub.send(git.referenceWatchers(url), { type: 'git.reference', url, found })
        if (found.kind === 'pull') this.sessions.pullRequestLoaded(found.pullRequest.url)
      }),
      git.onSessionEvents((sessionId, events) => this.sessions.gitEvents(sessionId, events)),
    ]
  }

  /**
   * The folders terminals may open in, sent when they change: the projects, scratch folders and
   * sessions' worktrees.
   */
  private sendFolders(): void {
    const paths = [...this.projects.paths(), ...this.sessions.sessionFolders()]
    const key = paths.join('\n')
    if (key === this.sentFolders) return
    this.sentFolders = key
    this.options.send({ type: 'host:projects', paths })
  }

  private broadcast(event: HostEvent): void {
    this.hub.broadcast(event)
  }

  /** The workflow settings: suggestions, and which Claude Code and Codex agents Auto may pick. */
  private workflowSettings(): WorkflowSettings {
    const agents = this.agents
      .statuses()
      .filter((status) => STEP_HARNESSES.has(status.harnessId) && status.registered !== false)
      .filter((status) => status.disabled !== true && status.uninstalled !== true)
      .map((status) => {
        const apiKey = status.account?.kind === 'api_key' || status.apiKey?.set === true
        return { agentId: status.id, ...this.workflowLibrary.autoPick(status.id, apiKey) }
      })
    return { suggest: this.workflowLibrary.suggest, agents }
  }

  /** Whether `sessionId` wrote a version of the document artifact at or after `since`. */
  private async documentWritten(
    artifactId: string,
    sessionId: string,
    since: number,
  ): Promise<WrittenDocument> {
    let found
    try {
      found = await this.artifacts.get(artifactId)
    } catch {
      return { ok: false, why: 'not_found' }
    }
    if (found.type?.name !== 'document') return { ok: false, why: 'not_document' }
    const versions = await this.artifacts.versions(artifactId)
    const own = versions.find((v) => v.author === sessionId && v.createdAt >= since)
    if (!own) return { ok: false, why: 'not_written' }
    return { ok: true, version: found.version.version, title: found.artifact.title }
  }

  /**
   * A task's notification, which opens the task whether or not any step has a session; devices,
   * which open sessions, get it through its latest step's session.
   */
  private taskAttention(task: TaskSummary, kind: 'needs-you' | 'ended'): void {
    const steps = [...task.steps].reverse()
    const step = steps.find((s) => s.state === 'needs_you' || s.state === 'error')
    const sessionId = step?.sessionId ?? steps.find((s) => s.sessionId !== null)?.sessionId
    const title =
      kind === 'needs-you'
        ? t('tasks.needsYou', { title: task.title })
        : task.status === 'cancelled'
          ? t('tasks.cancelled', { title: task.title })
          : task.end === 'done'
            ? t('tasks.done', { title: task.title })
            : t('tasks.dropped', { title: task.title })
    const body =
      kind === 'needs-you'
        ? t('tasks.needsYouBody', { step: step?.name ?? '', workflow: task.workflowName })
        : t('tasks.endedBody', { workflow: task.workflowName, steps: task.steps.length })
    this.options.send({
      type: 'host:attention',
      kind: kind === 'needs-you' ? 'task-needs-you' : 'task-ended',
      taskId: task.id,
      title,
      body,
      ...(sessionId ? { sessionId, front: this.front(sessionId) } : {}),
    })
  }

  /** What a status changed in the agent's plan limit windows, said as notices. */
  private limitsNoticed(status: AgentStatus): void {
    for (const notice of this.limitNotices.observe(status, Date.now())) {
      // A used-up window waits a moment for the turn it stopped to fail, so the two say it once.
      if (notice.level === 'reached') setTimeout(() => this.sendLimitNotice(notice), LIMIT_MERGE_MS)
      else this.sendLimitNotice(notice)
    }
  }

  private sessionFailed(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return
    this.lastFailed.set(this.sessions.summary(sessionId).agentId, { sessionId, at: Date.now() })
  }

  private sendLimitNotice(notice: LimitNotice): void {
    const now = Date.now()
    let sessionId: string | undefined
    if (notice.level === 'reached') {
      const failed = this.lastFailed.get(notice.agentId)
      if (failed && now - failed.at < LIMIT_FAILED_WITHIN_MS) {
        sessionId = failed.sessionId
        this.stoppedBy.set(notice.key, sessionId)
        if (this.sessions.has(sessionId)) {
          this.sessions.turnLimited(sessionId, this.agents.status(notice.agentId), notice.limit)
        }
      }
    } else if (notice.level === 'reset') {
      sessionId = this.stoppedBy.get(notice.key)
      this.stoppedBy.delete(notice.key)
    }
    const summary =
      sessionId && this.sessions.has(sessionId) ? this.sessions.summary(sessionId) : null
    const { title, body } = limitNoticeText(notice, summary?.title ?? null, now)
    this.options.send({
      type: 'host:attention',
      kind: 'plan-limit',
      agentId: notice.agentId,
      level: notice.level,
      key: notice.key,
      usedPercent: notice.limit.usedPercent,
      ...(summary ? { sessionId: summary.id } : {}),
      title,
      body,
    })
  }

  /** A task that ended tells the conversation it started from what it delivered. */
  private async taskEnded(view: TaskView, written: boolean): Promise<void> {
    const from = view.from
    if (!from) return
    const writtenBy = written
      ? (this.workflowSuggestions.draftAgent(view.workflowId) ??
        this.sessions.sessionAgent(from.sessionId))
      : null
    try {
      await this.sessions.taskDelivered(from.sessionId, deliveryOf(view, writtenBy, Date.now()))
    } catch (error) {
      this.diagnostics.log('warn', `Could not deliver task ${view.id}: ${(error as Error).message}`)
    }
  }

  /** Save as my workflow, on a task that ran on a workflow its agent wrote for it and ended done. */
  private async saveTaskWorkflow(taskId: string): Promise<WorkflowEntry> {
    const draft = this.tasks.writtenDraft(taskId)
    if (!draft) throw new HostError('conflict', t('tasks.notWritten'))
    return this.workflowSuggestions.saveDraft(draft)
  }

  /** Where a task's workflow is kept while it is published, as the Marketplace tools write it. */
  private taskPublishFolder(taskId: string): string {
    return path.join(this.options.userDataPath, 'workflows-to-publish', taskId)
  }

  /**
   * Publish to the Marketplace: the agent of the conversation the task started from gets the
   * task's workflow and is asked to make it general and publish it, handing the text back to the
   * Marketplace tools, so it writes no file of its own.
   */
  private async publishTaskWorkflow(taskId: string): Promise<void> {
    const draft = this.tasks.writtenDraft(taskId)
    if (!draft) throw new HostError('conflict', t('tasks.notWritten'))
    const view = this.tasks.get(taskId)
    const sessionId = view.from?.sessionId
    if (!sessionId || !this.sessions.has(sessionId)) throw notFound(t('tasks.noOrigin'))
    // The agent's general version is kept when the user asks again.
    const kept = await readFile(
      path.join(this.taskPublishFolder(taskId), 'workflow.yaml'),
      'utf8',
    ).catch(() => null)
    const own = await this.workflowSuggestions.draftText(draft)
    const general = kept !== null && kept !== own
    await this.sessions.sendCardAnswer(
      sessionId,
      publishWorkflowPrompt(view, general ? kept : own, general),
    )
    const entry = await this.sessions.taskDelivery(sessionId, taskId)
    if (entry) this.sessions.taskPublishAsked(sessionId, entry.id)
  }

  /** Who shows a session in front now: any window or device, and which devices. */
  private front(sessionId: string): AttentionFront {
    const ports = this.sessions.showing(sessionId)
    const devices = ports.flatMap((portId) => this.hub.deviceOf(portId)?.id ?? [])
    return { any: ports.length > 0, devices: [...new Set(devices)] }
  }

  private sendToRetainers(projectPath: string, event: HostEvent): void {
    this.hub.send(this.gitRetains.ports(pathKey(projectPath, this.options.platform)), event)
  }

  private reportProcesses(processes: AgentProcess[]): void {
    const json = JSON.stringify(processes)
    if (json === this.lastProcesses) return
    this.lastProcesses = json
    this.options.send({ type: 'host:agent-processes', processes })
  }

  /** Serves a window's port, or a paired device's when `device` names it. */
  connect(channel: PortChannel<FromPort<HostEvent>>, device: PortDevice | null = null): string {
    return this.hub.add(channel, device)
  }

  private portClosed(portId: string): void {
    this.runtimeRequests.portClosed(portId)
    this.consents.portClosed(portId)
    this.deviceBrowser.portClosed(portId)
    this.browserTurns.portClosed(portId)
    this.sessions.portClosed(portId)
    this.artifacts.portClosed(portId)
    this.gitRetains.dropPort(portId)
    this.git?.releaseAll(portId)
  }

  /** `host:settings`: binary overrides, the proxy and background fetch, applied live. */
  async updateSettings(next: HostSettings): Promise<void> {
    const previous = this.settings
    this.settings = next
    if (setLocale(next.locale))
      this.broadcast({ type: 'environment.changed', info: this.env.info() })
    if (JSON.stringify(previous.proxy) !== JSON.stringify(next.proxy)) {
      this.env.setProxy(next.proxy)
      this.git?.setEnvironment(this.env.agentEnv() as NodeJS.ProcessEnv)
    }
    if (previous.git.backgroundFetch !== next.git.backgroundFetch) {
      this.git?.setBackgroundFetch(next.git.backgroundFetch)
    }
    this.usage.setFromComputer(next.usage.fromComputer)
    if (JSON.stringify(previous.computerUse) !== JSON.stringify(next.computerUse)) {
      this.computer?.settingsChanged()
    }
    this.env.setConfigFolders(configFolders(this.catalog, next))
    this.startModesChanged(previous, next)
    if (JSON.stringify(previous.idleSessions) !== JSON.stringify(next.idleSessions)) {
      this.idleRelease.notify()
    }
    if (JSON.stringify(previous.supervisor) !== JSON.stringify(next.supervisor)) {
      this.sessions.supervisorChanged()
    }
    if (JSON.stringify(previous.tidy) !== JSON.stringify(next.tidy)) this.sessions.tidyChanged()
    if (previous.webhooks?.port !== next.webhooks?.port) this.syncWebhooks()
    if (previous.workflow.maxWorkingSteps !== next.workflow.maxWorkingSteps) {
      this.tasks.limitChanged()
    }
    // A step held for a tool the host lacked may start once it is installed and on.
    if (JSON.stringify(previous.marketplace) !== JSON.stringify(next.marketplace)) {
      this.tasks.recheck()
    }
    this.marketChanged(previous.marketplace.mcp, this.marketKeys)
    if (JSON.stringify(previous.marketplace.mcp) !== JSON.stringify(next.marketplace.mcp)) {
      void this.marketBundles.sweep()
    }
    if (JSON.stringify(previous.marketplace.skills) !== JSON.stringify(next.marketplace.skills)) {
      void this.skillsChanged(previous.marketplace.skills)
    }
    this.countCommunity(previous.marketplace, next.marketplace)
    // The agents' listener ports first, so whatever the agents start next already names them.
    await this.nodeProxy.portsReady()
    const removed = await this.agents.settingsChanged(previous, next)
    await this.nodeProxy.settingsChanged(
      previous.agentNetwork ?? DEFAULT_AGENT_NETWORK,
      this.agents.ids(),
    )
    this.agents.readJoinedSignIns(previous, next)
    const turnedOff = next.disabledAgents.filter((id) => !previous.disabledAgents.includes(id))
    const gone = [...removed, ...turnedOff]
    if (gone.length > 0) await this.sessions.agentsRemoved(gone)
    this.featuresChanged(previous)
  }

  /** Huli: whether an optional feature is on, as Settings > Features has it. */
  featureOn(id: FeatureId): boolean {
    return featureOn(this.settings.features, id)
  }

  /**
   * Huli: Settings > Features turned features on or off. Each takes effect at once: routines'
   * schedule and the GitHub reads stop or start, the chat bridges disconnect or connect, and
   * Kite's skills, guide and tools follow for the sessions started from now on.
   */
  private featuresChanged(previous: HostSettings): void {
    const changed = (id: FeatureId) => featureOn(previous.features, id) !== this.featureOn(id)
    if (changed('routines')) {
      this.routines.setOn(this.featureOn('routines'))
      this.routineTriggersChanged()
    }
    if (changed('github') || changed('routines')) void this.githubFlow.refresh()
    if (changed('chatBridge')) this.applyChatBridge()
    if (changed('sessionTidy')) this.sessions.tidyChanged()
    if (changed('board') || changed('devices')) void this.ownSkillsChanged()
    else if (
      ['manager', 'secrets', 'agentTheme', 'webReader', 'agentNotify'].some((id) =>
        changed(id as FeatureId),
      )
    ) {
      this.sessions.libraryChanged(() => true)
    }
    // Turning it on is the user's yes to Moli's download, whose size the page and the card name.
    if (changed('webReader') && this.featureOn('webReader')) void this.webReader.turnedOn()
  }

  /** Huli: the handlers with the methods of a feature that is off refused. */
  private gatedHandlers(handlers: Handlers): Handlers {
    const gated = { ...handlers } as Record<string, (...args: never[]) => unknown>
    for (const [method, handler] of Object.entries(handlers)) {
      const feature = featureOfMethod(method)
      if (!feature) continue
      gated[method] = (...args: never[]) => {
        if (!this.featureOn(feature)) throw featureOff(feature)
        return (handler as (...args: never[]) => unknown)(...args)
      }
    }
    return gated as unknown as Handlers
  }

  /**
   * Huli: `host:chat-bridge`. The bridges' code loads only once one is on; with none on, it does
   * nothing and holds nothing.
   */
  setChatBridge(raw: unknown): void {
    const config = parseChatBridgeConfig(raw)
    if (!config) {
      this.diagnostics.log('warn', 'host:chat-bridge was not a configuration; ignored')
      return
    }
    this.chatBridgeConfig = config
    this.applyChatBridge()
  }

  /** Huli: the bridges as main last configured them, none while their feature is off. */
  private applyChatBridge(): void {
    const stored = this.chatBridgeConfig
    if (!stored) return
    const config = this.featureOn('chatBridge') ? stored : { platforms: {}, binding: null }
    if (this.chatBridge) {
      this.chatBridge.setConfig(config)
      return
    }
    if (!anyBridgeOn(config) || this.stopping) return
    this.chatBridgeLoad ??= import('./chat-bridge/service').then(({ ChatBridgeService }) => {
      const service = new ChatBridgeService({
        serve: (channel, device) => void this.hub.add(channel, device),
        route: () => routeFor(this.ownProxy()),
        send: (message) => this.options.send(message),
        defaultAgent: () => this.settings.defaultAgent,
        log: (level, message) => this.diagnostics.log(level, message),
      })
      this.chatBridge = service
      return service
    })
    void this.chatBridgeLoad.then(
      () => {
        if (!this.stopping) this.applyChatBridge()
      },
      (error: unknown) => {
        this.chatBridgeLoad = null
        this.diagnostics.log('error', `The chat bridges did not load: ${(error as Error).message}`)
      },
    )
  }

  /** `host:market-account`: the Kettu account the Marketplace tools publish with, or none. */
  setMarketAccount(account: unknown): void {
    const value = account as Record<string, unknown> | null
    const before = this.marketAccount
    this.marketAccount =
      value !== null &&
      typeof value === 'object' &&
      typeof value.email === 'string' &&
      (value.name === null || typeof value.name === 'string')
        ? { name: value.name as string | null, email: value.email }
        : null
    if (JSON.stringify(before) !== JSON.stringify(this.marketAccount)) {
      this.hub.broadcast({ type: 'market.publishedChanged' })
    }
    if ((before === null) !== (this.marketAccount === null)) void this.ownSkillsChanged()
  }

  /**
   * A feature that decides Kettu's own skills and guide was turned on or off: Claude Code's
   * plugins follow, and the prepared sessions, which started with the old ones, are replaced.
   */
  private async ownSkillsChanged(): Promise<void> {
    await this.marketSkills.sync()
    this.sessions.libraryChanged(() => true)
  }

  /**
   * The Marketplace entry a workflow names a tool by, as its card shows it: a Kettu Marketplace
   * listing, an MCP Registry server or a skill of the catalog; null when there is none.
   */
  private async marketTool(kind: 'mcp' | 'skill', ref: string): Promise<SuggestedTool | null> {
    const listing = listingIdOf(ref)
    if (kind === 'mcp') {
      let server: CatalogServer | null
      if (listing) {
        const found = await this.marketCommunity.listing(listing)
        server =
          found.state === 'listed' && found.listing.kind === 'mcp-server' ? found.server : null
      } else {
        server = (await this.marketCatalog.search(ref)).items.find((s) => s.id === ref) ?? null
      }
      if (!server) return null
      const setup =
        server.spec.type === 'http' && server.spec.oauth
          ? 'sign-in'
          : specInputs(server.spec).some((input) => input.required)
            ? 'keys'
            : 'none'
      return {
        kind,
        ref,
        title: server.title,
        description: server.description || null,
        server,
        skill: null,
        setup,
      }
    }
    if (listing) {
      const found = await this.marketCommunity.listing(listing)
      if (found.state !== 'listed' || found.listing.kind !== 'skill') return null
      return {
        kind,
        ref,
        title: found.listing.name,
        description: found.listing.description || null,
        server: null,
        skill: { kind: 'kettu', id: listing },
        setup: 'none',
      }
    }
    const skill = (await this.marketSkills.skills()).catalog.find((s) => s.id === ref)
    if (!skill) return null
    return {
      kind,
      ref,
      title: skill.name,
      description: skill.description || null,
      server: null,
      skill: { kind: 'catalog', id: ref },
      setup: 'none',
    }
  }

  /**
   * Installs a tool a workflow card's Start names, for every agent as the Marketplace installs by
   * default, or turns on the one Kettu keeps off. The change is an edit of the list its owner
   * holds, so it never writes over another install made meanwhile.
   */
  private async installMarketTool(tool: SuggestedTool): Promise<void> {
    const { marketplace } = (await this.settingsCall({ kind: 'read' })).file
    if (tool.kind === 'skill') {
      const own = keptTool(marketplace.skills, tool.ref)
      if (own?.on) return
      let entry: MarketSkill
      if (own) {
        entry = { ...own, on: true }
      } else {
        if (!tool.skill) throw notFound(t('workflow.toolGone', { name: tool.title }))
        entry = { ...(await this.marketSkills.add(tool.skill)), agents: 'all', on: true }
      }
      await this.settingsCall({
        kind: 'change',
        patch: { marketplace: { skillsEdit: { put: [entry] } } },
      })
      return
    }
    const own = keptTool(marketplace.mcp, tool.ref)
    if (own?.on) return
    let entry: MarketServer
    if (own) {
      entry = { ...own, on: true }
    } else {
      const server = tool.server
      if (!server) throw notFound(t('workflow.toolGone', { name: tool.title }))
      const kettu = listingIdOf(server.id) !== null
      entry = {
        id: server.id,
        name: serverName(kettu ? server.title : server.id, marketplace.mcp),
        title: server.title,
        source: kettu ? 'kettu' : 'registry',
        version: server.version,
        spec: server.spec,
        agents: 'all',
        on: true,
      }
    }
    await this.settingsCall({
      kind: 'change',
      patch: { marketplace: { mcpEdit: { put: [entry] } } },
    })
  }

  /** Makes a Marketplace API call through main or the daemon, which hold the access token. */
  private marketCall<K extends MarketCall['kind']>(
    call: Extract<MarketCall, { kind: K }>,
  ): Promise<MarketResults[K]> {
    const callId = this.nextMarketCall++
    return new Promise<MarketCallAnswer>((resolve) => {
      this.marketCalls.set(callId, resolve)
      this.options.send({ type: 'host:market-call', callId, call })
    }).then((answer) => {
      if ('error' in answer) throw new MarketCallError(answer.error)
      return answer.result as MarketResults[K]
    })
  }

  /** A first publish's publisher name; a name the service refuses keeps the card waiting. */
  private async setPublisher(handle: string): Promise<void> {
    if (!HANDLE.test(handle))
      throw new HostError('invalid_params', t('marketPublish.handleInvalid'))
    try {
      await this.marketTools.setPublisher(handle)
    } catch (error) {
      if (!(error instanceof MarketCallError)) throw error
      const { code, message } = error.failure
      if (code === 'handle_taken') {
        throw new HostError('conflict', t('marketPublish.handleTaken', { handle }))
      }
      if (code === 'invalid_request') {
        throw new HostError('invalid_params', t('marketPublish.handleInvalid'))
      }
      throw new HostError('unavailable', t('marketPublish.publisherFailed', { reason: message }))
    }
  }

  /** Moves the paths to the system's trash, which only main reaches; the daemon has none. */
  private async trash(paths: string[]): Promise<void> {
    const callId = this.nextTrashCall++
    const error = await new Promise<string | null>((resolve) => {
      this.trashCalls.set(callId, resolve)
      this.options.send({ type: 'host:trash-call', callId, paths })
    })
    if (error !== null) throw new HostError('unavailable', error)
  }

  /** `trash-result`: main's or the daemon's answer to a trash call. */
  trashResult(callId: number, error: string | null): void {
    const resolve = this.trashCalls.get(callId)
    if (!resolve) return
    this.trashCalls.delete(callId)
    resolve(error)
  }

  /** Reads or changes the settings through main or the daemon, which keep the file. */
  private settingsCall(call: SettingsCall): Promise<SettingsSnapshot> {
    const callId = this.nextSettingsCall++
    return new Promise<SettingsCallAnswer>((resolve) => {
      this.settingsCalls.set(callId, resolve)
      this.options.send({ type: 'host:settings-call', callId, call })
    }).then((answer) => {
      if ('error' in answer) throw new Error(answer.error)
      return answer.result
    })
  }

  /** Huli: reads or sets the themes through main, which keeps them and the window. */
  private themeCall(call: ThemeCall): Promise<ThemeSnapshot> {
    const callId = this.nextThemeCall++
    return new Promise<ThemeCallAnswer>((resolve) => {
      this.themeCalls.set(callId, resolve)
      this.options.send({ type: 'host:theme-call', callId, call })
    }).then((answer) => {
      if ('error' in answer) throw new Error(answer.error)
      return answer.result
    })
  }

  /** Huli: `theme-result`: main's or the daemon's answer to a theme call. */
  themeResult(callId: number, answer: ThemeCallAnswer): void {
    const resolve = this.themeCalls.get(callId)
    if (!resolve) return
    this.themeCalls.delete(callId)
    resolve(answer)
  }

  /** Huli: Undo on a theme line: what the change replaced comes back, unless it changed since. */
  private async undoTheme(sessionId: string, entryId: string): Promise<void> {
    const change = this.sessions.themeChange(sessionId, entryId)
    try {
      await this.themeTools.undo(change)
    } catch (error) {
      if (error instanceof StaleThemeUndo) {
        this.sessions.themeSettled(sessionId, entryId, { kind: 'changed', stale: true })
        throw new HostError('conflict', error.message)
      }
      throw new HostError('unavailable', (error as Error).message)
    }
    this.sessions.themeSettled(sessionId, entryId, { kind: 'changed', undone: true })
  }

  /** `settings-result`: main's or the daemon's answer to a settings call. */
  settingsResult(callId: number, answer: SettingsCallAnswer): void {
    const resolve = this.settingsCalls.get(callId)
    if (!resolve) return
    this.settingsCalls.delete(callId)
    resolve(answer)
  }

  /** What the settings tools read of the host itself: its agents and harnesses, and their facts. */
  private async settingsLocal(): Promise<LocalFacts> {
    const statuses = this.agents
      .statuses()
      .filter((status) => status.registered !== false && status.uninstalled !== true)
    const facts: SettingFacts = {}
    const modes: Partial<Record<AgentId, { value: string; name: string }[]>> = {}
    for (const status of statuses) {
      const account = status.account
      facts[`agents.account:${status.id}`] =
        account && account.kind !== 'none'
          ? [account.label, account.email].filter(Boolean).join(' · ') || null
          : null
      // Only whether a key is set; its value stays where Kettu keeps it.
      facts[`agents.api-key:${status.id}`] = status.apiKey ? status.apiKey.set : null
      if (takesStartMode(status.id)) {
        const option = this.agentOptions
          .get(status.id)
          ?.config.find((o) => o.category === 'mode' && o.type === 'select' && !!o.choices?.length)
        if (option?.choices) {
          modes[status.id] = option.choices.map((choice) => ({
            value: choice.value,
            name: choice.name,
          }))
        }
      }
    }
    const harnesses = new Map(statuses.map((s) => [s.harnessId, s.harnessName]))
    facts['agents.agents'] = statuses.length
    facts['harnesses.installed'] = harnesses.size
    facts['archived.sessions'] = this.sessions
      .summaries()
      .filter((summary) => summary.archivedAt !== null).length
    facts['memory.enabled'] = this.memory.enabled
    facts['agents.workflow-suggest'] = this.workflowLibrary.suggest
    try {
      facts['artifacts.page-permissions'] = (await this.consents.list()).length
    } catch {
      // Unread lists go without a count.
    }
    try {
      await this.deviceAccess.ready
      facts['devices.allowed-devices'] = this.deviceAccess.list().length
    } catch {
      // As above.
    }
    return {
      agents: statuses.map((status) => ({
        id: status.id,
        name: status.name,
        harnessId: status.harnessId,
      })),
      harnesses: [...harnesses].map(([id, name]) => ({ id, name })),
      modes,
      facts,
    }
  }

  /**
   * open_settings: Settings opens at the row in the desktop windows that show the session, a
   * desktop app connected as a device included; a row of the desktop app's own only in this
   * computer's windows. False when no such window shows it.
   */
  private openSettings(sessionId: string, target: SettingsTarget): boolean {
    const ports = this.sessions.showing(sessionId).filter((portId) => {
      const device = this.hub.deviceOf(portId)
      return device === null || (!target.desktop && device.browser === true)
    })
    if (ports.length === 0) return false
    this.hub.send(ports, {
      type: 'settings.open',
      section: target.section,
      item: target.item,
      row: target.row,
    })
    return true
  }

  /** Undo on a settings line: the rows go back, unless one changed again since. */
  private async undoSettings(sessionId: string, entryId: string): Promise<void> {
    const items = this.sessions.settingsChange(sessionId, entryId)
    try {
      await this.settingsTools.undo(items)
    } catch (error) {
      if (error instanceof StaleUndo) {
        this.sessions.settingsSettled(sessionId, entryId, { kind: 'changed', stale: true })
        throw new HostError('conflict', error.message)
      }
      throw new HostError('unavailable', (error as Error).message)
    }
    this.sessions.settingsSettled(sessionId, entryId, { kind: 'changed', undone: true })
  }

  /** `market-result`: main's or the daemon's answer to a Marketplace call. */
  marketResult(callId: number, answer: MarketCallAnswer): void {
    const resolve = this.marketCalls.get(callId)
    if (!resolve) return
    this.marketCalls.delete(callId)
    resolve(answer)
  }

  /**
   * `host:market-keys`: every value of the Marketplace servers' inputs, replacing those before.
   * They stay in memory and go only into what agents are handed; a malformed message is dropped.
   */
  setMarketKeys(values: unknown, oauth?: unknown, agentEnv?: unknown): void {
    const keys = parseMarketKeys(values)
    const signIns = oauth === undefined ? undefined : parseSignIns(oauth)
    if (!keys || signIns === null) {
      this.diagnostics.log('warn', 'host:market-keys was not a map of values; ignored')
      return
    }
    const previous = this.marketKeys
    this.marketKeys = keys
    const previousAgentEnv = this.agentEnvKeys
    if (typeof agentEnv === 'object' && agentEnv !== null && !Array.isArray(agentEnv)) {
      this.agentEnvKeys = Object.fromEntries(
        Object.entries(agentEnv).flatMap(([id, vars]) =>
          typeof vars === 'object' && vars !== null && !Array.isArray(vars)
            ? [
                [
                  id,
                  Object.fromEntries(
                    Object.entries(vars).filter(
                      (entry): entry is [string, string] => typeof entry[1] === 'string',
                    ),
                  ),
                ],
              ]
            : [],
        ),
      )
    }
    for (const agentId of new Set([
      ...Object.keys(previousAgentEnv),
      ...Object.keys(this.agentEnvKeys),
    ])) {
      if (
        JSON.stringify(previousAgentEnv[agentId] ?? {}) !==
        JSON.stringify(this.agentEnvKeys[agentId] ?? {})
      ) {
        void this.agents.agentEnvChanged(agentId as AgentId).catch((error: unknown) => {
          this.diagnostics.log(
            'warn',
            `Could not restart ${agentId} after its key changed: ${(error as Error).message}`,
          )
        })
      }
    }
    this.marketChanged(this.settings.marketplace.mcp, previous)
    if (signIns) this.signInsPushed(signIns)
    this.hub.broadcast({ type: 'market.keysChanged' })
  }

  /**
   * Huli: routines' webhook listener: on the port Settings gives while a routine runs on its
   * webhook and routines are on, else closed.
   */
  private syncWebhooks(): void {
    const on = this.routines.webhookRoutines().length > 0
    this.webhooks.sync(on ? (this.settings.webhooks?.port ?? DEFAULT_WEBHOOK_PORT) : null)
  }

  /**
   * Huli: a new secret for a webhook routine, in place of its old one: kept here at once and sent
   * to main to keep encrypted. It is answered this once, never again.
   */
  newWebhookSecret(routineId: string): { secret: string } {
    if (!this.routines.isWebhookRoutine(routineId)) {
      throw invalidParams(t('routines.webhookOnly'))
    }
    const secret = newWebhookSecret()
    this.webhookSecrets.set(routineId, secret)
    this.options.send({ type: 'host:webhook-secret', routineId, secret })
    this.routines.webhooksChanged()
    return { secret }
  }

  private forgetWebhookSecret(routineId: string): void {
    if (!this.webhookSecrets.delete(routineId)) return
    this.options.send({ type: 'host:webhook-secret', routineId, secret: null })
  }

  /** Huli: the webhook routines' secrets main keeps; one that does not read as one is left out. */
  setWebhookSecrets(raw: unknown): void {
    const kept = new Map<string, string>()
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      for (const [routineId, secret] of Object.entries(raw)) {
        if (ROUTINE_ID.test(routineId) && isWebhookSecret(secret)) kept.set(routineId, secret)
      }
    }
    const changed =
      kept.size !== this.webhookSecrets.size ||
      [...kept].some(([id, secret]) => this.webhookSecrets.get(id) !== secret)
    this.webhookSecrets = kept
    if (changed) this.routines.webhooksChanged()
  }

  /** Huli: the values saved from secret cards, in place of those before; a bad message keeps none. */
  setProjectSecrets(raw: unknown): void {
    const kept: Record<string, Record<string, string>> = {}
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      for (const [project, values] of Object.entries(raw)) {
        if (typeof values !== 'object' || values === null || Array.isArray(values)) continue
        const own = Object.entries(values).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        )
        if (own.length > 0) kept[project] = Object.fromEntries(own)
      }
    }
    this.projectSecrets = kept
  }

  /**
   * Huli: main's API provider profiles, with their keys, in place of those before. An idle session
   * on a profile that changed attaches anew; one at work keeps what it started with until then.
   */
  setProfiles(raw: unknown): void {
    for (const { agentId, profileIds } of this.profiles.set(raw)) {
      if (!this.agents.has(agentId)) continue
      this.agents.profilesChanged(agentId)
      if (profileIds.length > 0) this.sessions.profilesChanged(agentId, profileIds)
    }
  }

  /**
   * Main's copy of the sign-ins. Every message to main is answered with one, so a sign-in two
   * pushes have not carried back was refused: it keeps working until the host restarts.
   */
  private signInsPushed(signIns: Record<string, string>): void {
    const before = this.marketConnections.view()
    this.marketConnections.load(signIns)
    for (const [serverId, sent] of this.unkept) {
      const kept = Object.hasOwn(signIns, serverId) ? signIns[serverId]! : null
      if (kept === sent.state) {
        this.unkept.delete(serverId)
      } else if (++sent.pushes >= 2) {
        this.unkept.delete(serverId)
        this.diagnostics.log(
          'warn',
          `Main did not keep the sign-in of ${serverId}; it lasts until the host restarts`,
        )
      }
    }
    const after = this.marketConnections.view()
    for (const [serverId, connection] of Object.entries(after)) {
      if (JSON.stringify(before[serverId]) !== JSON.stringify(connection)) {
        this.connectionChanged(serverId, connection)
      }
    }
  }

  /** Asks main to keep a server's sign-in, or to forget it with null. */
  private keepSignIn(serverId: string, state: string | null): void {
    this.unkept.set(serverId, { state, pushes: 0 })
    this.options.send({ type: 'host:market-oauth', serverId, state })
  }

  /**
   * A server's sign-in changed: the clients hear of it, and the prepared sessions of its agents
   * are replaced, since they started with the server or without it.
   */
  private connectionChanged(
    serverId: string,
    connection: MarketConnection,
    loginId?: string,
    error?: string,
  ): void {
    this.hub.broadcast({
      type: 'market.connectionChanged',
      serverId,
      connection,
      ...(loginId !== undefined ? { loginId } : {}),
      ...(error !== undefined ? { error } : {}),
    })
    const server = this.settings.marketplace.mcp.find((item) => item.id === serverId)
    if (server) this.sessions.libraryChanged((agentId) => serverFor(server, agentId))
  }

  /**
   * The Marketplace's servers or keys may have changed from `servers` and `keys`: each agent whose
   * servers differ now has its prepared sessions replaced.
   */
  private marketChanged(servers: HostSettings['marketplace']['mcp'], keys: MarketKeys): void {
    // Proxied servers compare by where they go, without a session's bearer.
    const oauth = {
      access: (server: MarketServer) => this.marketConnections.access(server),
      bearer: () => ({ origin: '', token: '' }),
    }
    const options = { platform: this.options.platform, oauth, node: this.options.nodeRuntime }
    const of = (list: typeof servers, held: MarketKeys, agentId: AgentId): string =>
      JSON.stringify(libraryServers(list, held, agentId, ALL_TRANSPORTS, options))
    const now = this.settings.marketplace.mcp
    if (servers === now && keys === this.marketKeys) return
    this.sessions.libraryChanged(
      (agentId) => of(servers, keys, agentId) !== of(now, this.marketKeys, agentId),
    )
  }

  /**
   * The skills in the settings changed from `before`: the disk follows, then the prepared sessions
   * of each agent whose skills differ are replaced.
   */
  private async skillsChanged(before: HostSettings['marketplace']['skills']): Promise<void> {
    await this.marketSkills.sync()
    const now = this.settings.marketplace.skills
    const of = (skills: typeof now, agentId: AgentId): string =>
      JSON.stringify(skills.filter((skill) => skillFor(skill, agentId)).map((s) => [s.id, s.name]))
    this.sessions.libraryChanged((agentId) => of(before, agentId) !== of(now, agentId))
  }

  /**
   * The skills and servers from the Kettu Marketplace that the settings now keep, or keep at
   * another version, are counted once each as an install or an update.
   */
  private countCommunity(
    before: HostSettings['marketplace'],
    after: HostSettings['marketplace'],
  ): void {
    const versions = (list: readonly { id: string; version: string | null }[]) =>
      new Map(
        list.flatMap((item) => {
          const id = listingIdOf(item.id)
          return id ? [[id, item.version] as const] : []
        }),
      )
    for (const kind of ['skills', 'mcp'] as const) {
      const was = versions(before[kind])
      for (const [id, version] of versions(after[kind])) {
        if (!was.has(id)) void this.marketCommunity.count(id, version, 'install')
        else if (was.get(id) !== version) void this.marketCommunity.count(id, version, 'update')
      }
    }
  }

  /**
   * Moves the Kettu Marketplace's local marketplaces out of the app's data, once, then points the
   * agents that registered them at the new place.
   */
  private async moveLocalMarketplaces(): Promise<void> {
    for (const harness of await this.marketCommunity.moveLegacy()) {
      try {
        await this.marketPlugins.pointLocal(
          harness,
          await this.marketCommunity.resolvedLocal(harness),
        )
      } catch (error) {
        writeLog(
          'warn',
          'host',
          `Could not point the agents at the moved ${harness} marketplace: ${(error as Error).message}`,
        )
      }
    }
  }

  /** The agents of these harnesses that are turned on and whose program is installed. */
  private async installedAgents(
    harnesses: readonly HarnessId[],
    among: readonly AgentId[] = this.agents.ids(),
  ): Promise<AgentId[]> {
    const wanted = among.filter(
      (id) => harnesses.includes(harnessOf(id)) && !this.settings.disabledAgents.includes(id),
    )
    const found = await Promise.all(wanted.map((id) => this.agents.harnessProgram(id)))
    return wanted.filter((_, index) => found[index] !== null)
  }

  /** The agent's app-server for requests outside a session, started if it is not running. */
  private async appServer(agentId: AgentId): Promise<CodexRequest> {
    const { connection } = await this.agents.ensureReady(agentId)
    const request = connection.request?.bind(connection)
    if (!request) throw new HostError('agent_unavailable', t('hostError.agentNoRequest'))
    return request
  }

  /** The options as New session takes them, with the start mode the settings name for the agent. */
  private withStartMode(options: AgentOptions): AgentOptions {
    const startMode = startModeIn(this.settings, options.agentId)
    return startMode === undefined ? options : { ...options, startMode }
  }

  /**
   * An agent's start mode changed: its prepared sessions started in the old one, and the windows
   * learn the new one with its options, after the prepared sessions' removal.
   */
  private startModesChanged(previous: HostSettings, next: HostSettings): void {
    const agentIds = new Set([...Object.keys(previous.startModes), ...Object.keys(next.startModes)])
    for (const agentId of agentIds as Set<AgentId>) {
      if (startModeIn(previous, agentId) === startModeIn(next, agentId)) continue
      this.sessions.startModeChanged(agentId)
      const entry = this.agentOptions.get(agentId)
      if (entry) this.hub.broadcast({ type: 'agent.options', options: this.withStartMode(entry) })
    }
  }

  /** The computer slept or woke, so the routines' timer starts over from the wall clock. */
  power(state: 'suspend' | 'resume'): void {
    this.routines.power(state)
    this.githubFlow.power(state)
  }

  /** Huli: whether a window of the app shows, which the GitHub flow reads more slowly without. */
  windowsVisible(visible: boolean): void {
    this.githubFlow.setVisible(visible)
  }

  /** Huli: the routines' GitHub triggers changed, so the flow plans its reads again. */
  private routineTriggersChanged(): void {
    this.syncWebhooks()
    const triggers = JSON.stringify(this.routines.eventTriggers())
    if (triggers === this.flowTriggers) return
    this.flowTriggers = triggers
    void this.githubFlow?.refresh()
  }

  busy(requestId: number): void {
    this.options.send({ type: 'host:busy', requestId, sessions: this.sessions.busy() })
  }

  /** Huli: main's own request of a host method, which only main may make of some. */
  mainCall(callId: number, method: string, params: unknown): void {
    this.hub.callFromMain(method, params).then(
      (result) => this.options.send({ type: 'host:main-answer', callId, result }),
      (error: unknown) =>
        this.options.send({
          type: 'host:main-answer',
          callId,
          error: isHostError(error)
            ? error.toPortError()
            : { code: 'internal', message: (error as Error)?.message ?? String(error) },
        }),
    )
  }

  /** The floating label's buttons and the stop shortcut, from main. */
  computerControl(sessionId: string, action: ComputerControlAction): void {
    this.computer?.control(sessionId, action)
  }

  /** `host:computer-frame-request`: where the window the holding session uses is now. */
  computerFrame(requestId: number): void {
    const answer = (frame: ComputerFrame | null) =>
      this.options.send({ type: 'host:computer-frame', requestId, frame })
    if (!this.computer) return answer(null)
    this.computer.frame().then(answer, (error: unknown) => {
      this.diagnostics.log('info', `Computer use could not find its window: ${String(error)}`)
      answer(null)
    })
  }

  /**
   * `host:report-request`: a problem report's bundle, written into the data folder's `reports`,
   * which the parent removes once the user saved or dropped it.
   */
  async report(message: Extract<MainToHost, { type: 'host:report-request' }>): Promise<void> {
    let result: ReportBuildResult
    try {
      const request = parseReportRequest(message.request)
      await flushLog()
      result = await writeReport(
        {
          request,
          now: Date.now(),
          parent:
            typeof message.parent === 'object' && message.parent !== null ? message.parent : {},
          settings: message.settings ?? null,
          host: await this.collectDiagnostics(),
          logDir: logFolder(),
          crashDir: typeof message.crashDir === 'string' ? message.crashDir : null,
          screenshot:
            typeof message.screenshot === 'string'
              ? new Uint8Array(Buffer.from(message.screenshot, 'base64'))
              : null,
          redact: redactLogText,
        },
        path.join(this.options.userDataPath, 'reports'),
      )
    } catch (error) {
      result = { ok: false, reason: 'failed', message: (error as Error).message }
    }
    if (!result.ok) this.diagnostics.log('warn', `No problem report: ${result.message}`)
    this.options.send({ type: 'host:report', requestId: message.requestId, result })
  }

  /** Allow once from a request's notification; a request already answered elsewhere is left. */
  answerPermission(sessionId: string, requestId: string, optionId: string): void {
    try {
      this.sessions.respond(sessionId, requestId, { optionId })
    } catch (error) {
      this.diagnostics.log(
        'info',
        `A notification's answer was not taken: ${(error as Error).message}`,
      )
    }
  }

  /** Takes the paths main granted for attachments, then says so, before main answers the renderer. */
  grant(requestId: number, grants: AttachmentGrant[]): void {
    this.attachments.grant(grants)
    this.options.send({ type: 'host:granted', requestId })
  }

  /** `host:artifact-content-request`: the files of a version, for main's protocol. */
  async artifactContent(requestId: number, id: string, version: number | null): Promise<void> {
    let result: ArtifactContentResult
    try {
      result = { kind: 'found', ...(await this.artifacts.content(id, version ?? undefined)) }
    } catch (error) {
      if (error instanceof ArtifactError) {
        result = { kind: 'not_found' }
      } else {
        this.diagnostics.log('warn', `Could not find ${id}'s content: ${(error as Error).message}`)
        result = { kind: 'failed' }
      }
    }
    this.options.send({ type: 'host:artifact-content', requestId, result })
  }

  /** `host:artifact-runtime`: a page's message main relayed from an artifact origin it serves. */
  artifactRuntime(requestId: number, artifactId: string, message: unknown): void {
    this.runtimeRequests.fromMain(requestId, artifactId, message, (answer: RuntimeAnswer) =>
      this.options.send({ type: 'host:artifact-runtime-answer', requestId, answer }),
    )
  }

  /** `host:artifact-runtime-cancel`: the page closed its request, which ends a stream. */
  artifactRuntimeCancel(requestId: number): void {
    this.runtimeRequests.cancelMain(requestId)
  }

  /** The artifact's folder as a project, or null for a scratch folder, which is No project. */
  private projectOf(folder: string): string | null {
    return this.scratch.contains(folder) ? null : folder
  }

  /**
   * The artifact as the runtime checks a page's request against it: what its latest version
   * declares, and for one made from a type, what its type's viewer uses.
   */
  private async declaredArtifact(id: string): Promise<DeclaredArtifact | null> {
    const [declared, found] = await Promise.all([
      this.artifacts.runtime('declaration', { id, project: null, version: null }),
      this.artifacts.get(id),
    ]).catch(() => [null, null] as const)
    if (!declared || !found?.type) return declared
    const implied = this.artifactTypes.capabilities(found.type.name)
    return { ...declared, capabilities: [...new Set([...declared.capabilities, ...implied])] }
  }

  /**
   * The agent that answers the questions of a page of `project`, null for No project: the agent
   * new sessions start with, else the one its latest session used, when that agent can answer
   * without tools.
   */
  private async sampleAgent(project: string | null): Promise<SampleAgent | null> {
    const agentId = this.preferredAgent(project)
    if (agentId === null || !QUESTION_HARNESSES.has(harnessOf(agentId))) return null
    return { id: agentId, name: this.agents.name(agentId) }
  }

  /**
   * The agent Kettu asks on its own account about `project`, null for No project: the agent new
   * sessions start with, else the one its latest session used; null when it is gone or off.
   */
  private preferredAgent(project: string | null): AgentId | null {
    let agentId = this.settings.defaultAgent
    if (agentId === null) {
      const sessions = project === null ? this.sessions.list() : this.sessions.list(project)
      agentId = sessions.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.agentId ?? null
    }
    if (agentId === null || !this.agents.has(agentId) || this.agents.isDisabled(agentId))
      return null
    return agentId
  }

  /**
   * A commit message for the changed files at `paths`, from the project's preferred agent or the
   * one the lightweight tasks' model is pinned to.
   */
  private async commitMessage(projectPath: string, paths: string[]): Promise<string> {
    const context = await this.gitProjectCall(projectPath, (g, p) => g.commitContext(p, paths))
    const target = lightTarget(this.settings.lightModel, this.preferredAgent(projectPath), null)
    if (target === null) throw new HostError('agent_error', t('git.commitMessageNoAgent'))
    const agent = this.agents.name(target.agentId)
    try {
      const runtime = await this.agents.ensureReady(target.agentId)
      const dir = path.join(this.options.userDataPath, 'agent-reports')
      await mkdir(dir, { recursive: true })
      return await writeCommitMessage(runtime, {
        dir,
        context,
        model: target.model,
        log: (line) => this.diagnostics.log('warn', line),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.diagnostics.log('warn', `${agent}: could not write a commit message: ${logText(error)}`)
      throw new HostError('agent_error', t('git.commitMessageFailed', { agent, reason }))
    }
  }

  /**
   * A title and description for a pull request of the branch into `base`, from the project's
   * preferred agent or the one the lightweight tasks' model is pinned to.
   */
  private async pullRequestDraft(
    projectPath: string,
    base: string,
    sessionId?: string,
    part?: 'title' | 'body',
  ): Promise<{ title: string; body: string }> {
    // Huli: from a session, its diff and conversation too, written by the session's agent.
    const brief = sessionId ? await this.sessions.conversationBrief(sessionId) : null
    const context = await this.gitProjectCall(projectPath, (g, p) =>
      g.pullRequestContext(p, base, sessionId !== undefined),
    )
    const target = brief
      ? lightTarget(this.settings.lightModel, brief.agentId, brief.model)
      : lightTarget(this.settings.lightModel, this.preferredAgent(projectPath), null)
    if (target === null) throw new HostError('agent_error', t('git.draftNoAgent'))
    const agent = this.agents.name(target.agentId)
    try {
      const runtime = await this.agents.ensureReady(target.agentId)
      const dir = path.join(this.options.userDataPath, 'agent-reports')
      await mkdir(dir, { recursive: true })
      const draft = await writePullRequestDraft(runtime, {
        dir,
        context,
        conversation: brief?.text ?? null,
        model: target.model,
        log: (line) => this.diagnostics.log('warn', line),
      })
      if (part === 'title') return { title: draft.title, body: '' }
      if (part === 'body') return { title: '', body: draft.body }
      return draft
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.diagnostics.log('warn', `${agent}: could not write a pull request: ${logText(error)}`)
      throw new HostError('agent_error', t('git.draftFailed', { agent, reason }))
    }
  }

  /**
   * Huli: a branch name's words for the work `text` asks for, or for the folder's uncommitted
   * changes without it, from `agentId` or the project's preferred agent.
   */
  private async suggestBranch(
    projectPath: string,
    text: string | undefined,
    agentId: AgentId | undefined,
  ): Promise<{ slug: string }> {
    let message = text
    if (message === undefined) {
      const changes = await this.gitProjectCall(projectPath, (g, p) => g.changes(p))
      if (changes.length === 0) throw new HostError('restricted', t('git.suggestBranchNothing'))
      const paths = changes.map((file) => file.path)
      const context = await this.gitProjectCall(projectPath, (g, p) => g.commitContext(p, paths))
      message = [
        'The uncommitted changes of a Git working tree:',
        ...context.files.slice(0, 40).map((file) => `${file.status} ${file.path}`),
        '',
        context.diff,
      ].join('\n')
    }
    const target = lightTarget(
      this.settings.lightModel,
      agentId ?? this.preferredAgent(projectPath),
      null,
    )
    if (target === null) throw new HostError('agent_error', t('git.draftNoAgent'))
    const agent = this.agents.name(target.agentId)
    try {
      const runtime = await this.agents.ensureReady(target.agentId)
      const dir = path.join(this.options.userDataPath, 'agent-reports')
      await mkdir(dir, { recursive: true })
      const reply = await writeBranchSlug(runtime, {
        dir,
        model: target.model,
        message: [{ type: 'text', text: message }],
        log: (line) => this.diagnostics.log('warn', line),
      })
      const slug = cleanSlug(reply)
      if (slug === '') throw new Error('its reply held no branch name')
      return { slug }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.diagnostics.log('warn', `${agent}: could not name a branch: ${logText(error)}`)
      throw new HostError('agent_error', t('git.suggestBranchFailed', { agent, reason }))
    }
  }

  /**
   * A draft of a problem report's description from the agent the report is about, else the one
   * new sessions start with, unless the lightweight tasks' model is pinned to another; null when
   * Kettu observed nothing to write from.
   */
  private async draftReport(
    params: HostParams<'agents.draftReport'>,
  ): Promise<{ draft: string | null; agent: string | null }> {
    const session =
      params.sessionId !== null && this.sessions.has(params.sessionId)
        ? this.sessions.summary(params.sessionId)
        : null
    const about = session?.agentId ?? params.agentId
    const known = about !== null && this.agents.has(about)
    const prompt = reportDraftPrompt(
      {
        origin: params.origin,
        language: params.language,
        agent: known ? this.agents.name(about) : null,
        error: params.error,
        log: this.diagnostics.logEntries(),
        events: known ? this.diagnostics.agentEvents(about) : [],
        now: Date.now(),
      },
      redactLogText,
    )
    if (prompt === null) return { draft: null, agent: null }
    const agentId =
      known && !this.agents.isDisabled(about)
        ? about
        : this.preferredAgent(session && !session.scratch ? session.projectPath : null)
    // The session's model only for its own agent, which another agent may not offer.
    const model = session && session.agentId === agentId ? session.model : null
    const target = lightTarget(this.settings.lightModel, agentId, model)
    if (target === null) throw new HostError('agent_error', t('report.draftNoAgent'))
    const agent = this.agents.name(target.agentId)
    try {
      const runtime = await this.agents.ensureReady(target.agentId)
      const dir = path.join(this.options.userDataPath, 'agent-reports')
      await mkdir(dir, { recursive: true })
      const draft = await writeReportDraft(runtime, {
        dir,
        prompt,
        model: target.model,
        log: (line) => this.diagnostics.log('warn', line),
      })
      return { draft, agent }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      // Info: the report this draft is for must not read its own failure as part of the problem.
      this.diagnostics.log('info', `${agent}: could not draft a problem report: ${logText(error)}`)
      throw new HostError('agent_error', t('report.draftFailed', { agent, reason }))
    }
  }

  /** A page's question to the agent, in a hidden session with no tools in the reports' folder. */
  private async answerQuestion(agent: SampleAgent, question: SampleQuestion): Promise<string> {
    const runtime = await this.agents.ensureReady(agent.id as AgentId)
    const { connection } = runtime
    if (!connection.answerQuestion) {
      throw new CapabilityError('unsupported', `${agent.name} cannot answer without tools.`)
    }
    const dir = path.join(this.options.userDataPath, 'agent-reports')
    await mkdir(dir, { recursive: true })
    return connection.answerQuestion(dir, question.prompt, question.onText, question.signal)
  }

  /** `host:artifact-list-request`: every artifact, for main to publish them and unpublish the gone. */
  async artifactList(requestId: number): Promise<void> {
    let result: ArtifactListResult
    try {
      const [kept, deleted] = await Promise.all([
        this.artifacts.list({ deleted: false }),
        this.artifacts.list({ deleted: true }),
      ])
      result = {
        kind: 'listed',
        artifacts: [...kept.map((a) => brief(a, false)), ...deleted.map((a) => brief(a, true))],
      }
    } catch (error) {
      this.diagnostics.log('warn', `Could not list the artifacts: ${(error as Error).message}`)
      result = { kind: 'failed' }
    }
    this.options.send({ type: 'host:artifact-list', requestId, result })
  }

  /** `host:artifact-export-request`: a typed version converted for main to save. */
  async artifactExport(
    requestId: number,
    id: string,
    version: number,
    format: ArtifactExportFormat,
  ): Promise<void> {
    let result: ArtifactExportResult
    try {
      const found = await this.artifacts.get(id, { version })
      const files = await exportVersion(this.artifacts, found, format)
      result = { kind: 'exported', title: found.artifact.title, files }
    } catch (error) {
      if (error instanceof ArtifactError && error.reason === 'not_found') {
        result = { kind: 'not_found' }
      } else {
        const message = (error as Error).message
        this.diagnostics.log('warn', `Could not export ${id} as ${format}: ${message}`)
        result = { kind: 'failed', message }
      }
    }
    this.options.send({ type: 'host:artifact-export', requestId, result })
  }

  /**
   * `host:artifact-import-request`: makes an artifact of a file or folder the user chose, in
   * `project` or, when it is null, in a new scratch folder, which the page lists under No project.
   */
  async artifactImport(requestId: number, file: string, project: string | null): Promise<void> {
    let result: NonNullable<ArtifactImportResult>
    try {
      let folder: string | null = null
      if (project !== null) {
        folder = await this.projects.resolveDirectory(project)
        if (!this.scratch.contains(folder)) this.projects.match(folder)
      }
      const read = await readImport(file)
      if ('failed' in read) {
        result = read
      } else {
        // Made only now, so a file that cannot be read leaves no empty folder behind.
        folder ??= await this.scratch.create()
        const { id } = await this.artifacts.create({
          project: folder,
          sessionId: NO_SESSION,
          title: read.title,
          files: read.files,
          pages: read.pages,
          note: null,
        })
        result = { id }
      }
    } catch (error) {
      this.diagnostics.log('warn', `Could not import an artifact: ${(error as Error).message}`)
      result = { failed: 'unavailable' }
    }
    this.options.send({ type: 'host:artifact-import', requestId, result })
  }

  /**
   * Sends a browser call to the desktop app that sent the session's turn, or to main, and settles
   * with its answer, or a failure if the host stops. The caller's turn uses the page from now until
   * it ends; a step the agent asks the user for shows in the page's session's thread meanwhile.
   */
  async browserCall(
    request: BrowserCallRequest,
    caller = request.sessionId,
  ): Promise<BrowserCallAnswer> {
    const page = request.sessionId
    const target = browserTarget(this.sessions.browserSender(page), this.hub)
    if (target.kind === 'gone') {
      return { error: { code: 'unavailable', message: BROWSER_GONE } }
    }
    const left = this.browserTurns.used(caller, page, target)
    if (left) this.tellTurnEnded(page, left)
    const asking = request.tool === 'browser_ask_user'
    if (asking) {
      const { step, reason } = request.args
      this.sessions.controlAsked(page, {
        surface: 'browser',
        step: isControlStep(step) ? step : 'other',
        target: this.browserSites.get(page) ?? null,
        reason: typeof reason === 'string' ? reason : '',
      })
    }
    const answer =
      target.kind === 'device'
        ? await this.deviceBrowser.call(target.portId, request)
        : await this.mainBrowserCall(request)
    if ('result' in answer) {
      const site = siteOf(answer.result.value.url)
      if (site) this.browserSites.set(page, site)
    }
    if (asking) {
      if ('result' in answer) {
        const outcome = answer.result.value.outcome
        this.sessions.controlAskSettled(page, isControlOutcome(outcome) ? outcome : 'ended')
      } else if (answer.error.code !== 'user_has_control') {
        // Only a wait that goes on keeps the card; anything else ended the step.
        this.sessions.controlAskSettled(page, 'ended')
      }
    }
    return answer
  }

  /** Sends a browser call to main, which drives the page of the host's own windows. */
  private mainBrowserCall(request: BrowserCallRequest): Promise<BrowserCallAnswer> {
    // The tools' id travels to main unchanged, so its report of a site wait names the same call.
    const callId = request.callId
    return new Promise<BrowserCallAnswer>((resolve) => {
      this.browserCalls.set(callId, resolve)
      this.options.send({
        type: 'host:browser-call',
        callId,
        sessionId: request.sessionId,
        tool: request.tool,
        args: request.args,
        projectPath: request.projectPath,
        ...(request.allowTab ? { allowTab: request.allowTab } : {}),
        ...(request.folder ? { folder: request.folder, worktree: request.worktree === true } : {}),
      })
    })
  }

  /** A session's turn ended: the pages no running turn uses now are nobody's. */
  private browserTurnEnded(sessionId: string): void {
    for (const { page, target } of this.browserTurns.turnEnded(sessionId)) {
      this.tellTurnEnded(page, target)
    }
  }

  private tellTurnEnded(page: string, target: Exclude<BrowserTarget, { kind: 'gone' }>): void {
    if (target.kind === 'main')
      this.options.send({ type: 'host:browser-turn-ended', sessionId: page })
    else this.hub.send([target.portId], { type: 'browser.turnEnded', sessionId: page })
  }

  /** `host:browser-handed-back`: the user handed main's page back; the thread says for how long. */
  browserHandedBack(sessionId: string, durationMs: number): void {
    this.sessions.controlHandedBack(sessionId, 'browser', durationMs)
  }

  /**
   * `host:browser-waiting`: the call waits on a new origin, so its own time limit grows to that
   * wait and the call fails `not_allowed` rather than timing out first.
   */
  browserWaiting(callId: number, waiting: boolean): void {
    this.artifactService.browserWaiting(callId, waiting)
  }

  /** `host:browser-origin-ask`: main's page waits for a new origin, which the thread shows. */
  browserOriginAsked(requestId: number, sessionId: string, origin: string): void {
    this.sessions.browserOriginAsked(sessionId, requestId, origin)
  }

  /** `host:browser-origin-answer`: the wait ended, so the session's card takes the answer. */
  browserOriginSettled(requestId: number, decision: BrowserOriginAnswer): void {
    this.sessions.browserOriginSettled(requestId, decision)
  }

  /** Sends an agent's device call to its parent, which hands it to the device host. */
  deviceCall(call: DeviceCall): Promise<DeviceCallAnswer> {
    if (call.kind === 'action') this.deviceTurns.add(call.sessionId)
    const callId = this.nextDeviceCall++
    return new Promise<DeviceCallAnswer>((resolve) => {
      this.deviceCalls.set(callId, resolve)
      this.options.send({ type: 'host:device-call', callId, call })
    })
  }

  /** `host:device-handed-back`: the user handed a device back; the thread says for how long. */
  deviceHandedBack(sessionId: string, durationMs: number): void {
    this.sessions.controlHandedBack(sessionId, 'device', durationMs)
  }

  /**
   * The user's Run on a shell code block of a session's reply: a new terminal of the session's
   * agent runs it, the way the agent's own terminal tool does, and unless `notify` is false the
   * session is told which, queued while a turn runs. A subagent's reply runs for the session it
   * runs under, which has the terminals and takes prompts.
   */
  private async runReplyCommand(
    params: { sessionId: string; command: string; notify: boolean },
    portId: string,
    device: PortDevice | null,
  ): Promise<{ terminalId: string; notified: boolean }> {
    const sessionId = this.sessions.browserSession(params.sessionId)
    const agentId = sessionId ? this.sessions.sessionAgent(sessionId) : null
    if (!sessionId || !agentId) throw new HostError('not_found', t('session.notFound'))
    const folder = this.sessions.sessionFolder(sessionId) ?? this.sessions.sessionProject(sessionId)
    if (!folder) throw new HostError('restricted', t('hostError.noFolder'))
    const answer = await this.terminalCall({
      kind: 'reply',
      sessionId,
      agentId,
      folder,
      command: params.command,
      fromDevice: device !== null,
    })
    if ('error' in answer) {
      throw new HostError(REPLY_RUN_ERRORS[answer.error.code], answer.error.message)
    }
    if (answer.result.kind !== 'terminal') throw new HostError('internal', 'No terminal opened')
    const terminalId = answer.result.terminal.id
    if (!params.notify) return { terminalId, notified: false }
    try {
      const text = replyRunNotice(terminalId, params.command)
      await this.sessions.queue(sessionId, [{ type: 'text', text }], portId, fromDevice(device))
      return { terminalId, notified: true }
    } catch (error) {
      writeLog('warn', 'host', `A reply's run could not be told: ${(error as Error).message}`)
      return { terminalId, notified: false }
    }
  }

  /**
   * The terminals, browser tabs and devices a user's message references: the session's agent may
   * use them from now on, as the user shared them. A terminal of a session that exists gets the
   * allow at once, so its tab says so; the rest is given on the agent's first call, as New
   * session's terminals reach their session only later.
   */
  private shareSurfaces(sessionId: string | null, content: readonly UserContent[]): void {
    for (const item of content) {
      if (item.type !== 'ref') continue
      if (item.ref.kind === 'page') this.sharedTabs.set(item.ref.tabId, sessionId)
      if (item.ref.kind === 'device') this.sharedDevices.set(item.ref.deviceId, sessionId)
      if (item.ref.kind !== 'terminal') continue
      const terminalId = item.ref.terminalId
      this.sharedTerminals.set(terminalId, sessionId)
      if (sessionId === null) continue
      const session = this.sessions.browserSession(sessionId) ?? sessionId
      void this.terminalCall({ kind: 'allow', sessionId: session, terminalId, allowed: true })
    }
  }

  /** Takes back the session's agent the use of a terminal the user opened, from the tab's menu. */
  private async revokeTerminal(sessionId: string, terminalId: string): Promise<void> {
    this.sharedTerminals.delete(terminalId)
    const answer = await this.terminalCall({ kind: 'allow', sessionId, terminalId, allowed: false })
    if ('error' in answer) throw new HostError('not_found', answer.error.message)
    this.sessions.surfaceAccessRevoked(sessionId, terminalId)
  }

  /**
   * Huli: the dev servers the session's folder names in Claude Code's `.claude/launch.json`, read
   * when asked for; none when the file is missing or unfit.
   */
  private async launchConfigs(sessionId: string): Promise<{ configs: LaunchConfig[] }> {
    const session = this.sessions.browserSession(sessionId) ?? sessionId
    const folder = this.sessions.sessionFolder(session) ?? this.sessions.sessionProject(session)
    if (!folder) return { configs: [] }
    let text: string
    try {
      text = await readFile(path.join(folder, LAUNCH_FILE), 'utf8')
    } catch {
      return { configs: [] }
    }
    if (text.length > 256 * 1024) return { configs: [] }
    return { configs: parseLaunchConfigs(parseJsonc(text, [], { allowTrailingComma: true })) }
  }

  /** Sends an agent's terminal call to its parent, which hands it to the terminal host. */
  terminalCall(call: TerminalCall): Promise<TerminalCallAnswer> {
    // Only these take the terminal for the turn; the terminal host frees it when the turn ends.
    if (call.kind === 'run' || call.kind === 'input' || call.kind === 'stop') {
      this.terminalTurns.add(call.sessionId)
    }
    const callId = this.nextTerminalCall++
    return new Promise<TerminalCallAnswer>((resolve) => {
      this.terminalCalls.set(callId, resolve)
      this.options.send({ type: 'host:terminal-call', callId, call })
    })
  }

  /** `terminal-result`: the terminal host's answer to a call this host forwarded. */
  terminalResult(callId: number, answer: TerminalCallAnswer): void {
    const resolve = this.terminalCalls.get(callId)
    if (!resolve) return
    this.terminalCalls.delete(callId)
    resolve(answer)
  }

  /** `host:terminal-handed-back`: the user handed a terminal back; the thread says for how long. */
  terminalHandedBack(sessionId: string, durationMs: number): void {
    this.sessions.controlHandedBack(sessionId, 'terminal', durationMs)
  }

  /** `device-result`: the device host's answer to a call this host forwarded. */
  deviceResult(callId: number, answer: DeviceCallAnswer): void {
    const resolve = this.deviceCalls.get(callId)
    if (!resolve) return
    this.deviceCalls.delete(callId)
    resolve(answer)
  }

  /** `browser-result`: the answer to a call this host forwarded. */
  browserResult(callId: number, result: unknown, problem: unknown): void {
    const resolve = this.browserCalls.get(callId)
    if (!resolve) return
    this.browserCalls.delete(callId)
    resolve(answerOf(result, problem))
  }

  /** Main is gone: every call awaiting it fails with `timeout`, as its own limit would. */
  private failBrowserCalls(): void {
    for (const resolve of this.browserCalls.values()) {
      resolve({
        error: { code: 'timeout', message: 'Main stopped before the browser answered.' },
      })
    }
    this.browserCalls.clear()
    for (const resolve of this.deviceCalls.values()) {
      resolve({
        error: { code: 'unavailable', message: 'Kettu stopped before the device answered.' },
      })
    }
    this.deviceCalls.clear()
    for (const resolve of this.terminalCalls.values()) {
      resolve({
        error: { code: 'unavailable', message: 'Kettu stopped before the terminal answered.' },
      })
    }
    this.terminalCalls.clear()
    for (const resolve of this.marketCalls.values()) {
      resolve({
        error: { code: 'network', status: null, message: 'Kettu stopped before it answered.' },
      })
    }
    this.marketCalls.clear()
    for (const resolve of this.trashCalls.values()) resolve('Kettu stopped before it answered.')
    this.trashCalls.clear()
  }

  /** Stops every agent with the documented sequence, flushes the state files, then reports. */
  shutdown(): Promise<void> {
    this.stopping ??= (async () => {
      this.webhooks.close()
      this.chatBridge?.stop()
      await this.routines.shutdown()
      this.githubFlow.stop()
      this.sessions.shutdown()
      this.idleRelease.stop()
      this.usage.stop()
      this.artifacts.stop()
      this.execRunner.killAll()
      this.checkpointGit.stop()
      for (const unsubscribe of this.gitUnsubscribe) unsubscribe()
      await Promise.all([
        this.agents.stopAll(),
        this.git?.dispose().catch((error: unknown) => {
          this.diagnostics.log(
            'warn',
            `Git service did not stop cleanly: ${(error as Error).message}`,
          )
        }),
      ])
      await Promise.all([
        this.artifactService.stop(),
        this.computer?.shutdown(),
        this.nodeProxy.shutdown(),
        this.projects.flush(),
        this.sessions.flush(),
        this.remembered.flush(),
        this.updates.flush(),
        this.registryListing.flush(),
        this.harnessManifest.flush(),
        this.star.flush(),
        this.planAlerts.flush(),
        this.trees.close(),
        this.agentOptions.flush(),
        this.preparedRecords.flush(),
        this.attachments.flush(),
        this.marketCatalog.flush(),
        this.marketPlugins.flush(),
        this.marketSkills.flush(),
        this.marketCommunity.flush(),
        this.marketBundles.flush(),
        this.publishDrafts.flush(),
        this.sessionFolders.flush(),
        this.nodeRuntime.flush(),
        this.copies.flush(),
        this.workflowSuggestions.flush(),
        this.threads?.close(),
        this.usage.close(),
      ])
      this.hub.closeAll()
      this.failBrowserCalls()
      this.options.send({ type: 'host:stopped' })
    })()
    return this.stopping
  }

  /** The proxy variables of Kite's own requests: Advanced › Proxy, else the environment's. */
  private ownProxy(): ProxyVariables {
    return ownProxyVariables((name) => this.env.get(name))
  }

  /**
   * Huli: Kite's own Node.js or the choice changed. When the node agents run on changed, every
   * agent is detected again, so one that lacked Node.js can install or start without a restart,
   * and an idle agent's process stops, as after a network change, so its next start runs on it.
   */
  private async nodeSetupChanged(setup: Parameters<EnvironmentService['setNodeSetup']>[0]) {
    const before = this.env.nodeProbe()
    await this.env.setNodeSetup(setup)
    const after = this.env.nodeProbe()
    if (before.nodePath === after.nodePath && before.nodeVersion === after.nodeVersion) return
    await this.agents.redetect()
    await Promise.all(
      this.agents.ids().map((agentId) =>
        this.agents.networkChanged(agentId).catch((error: unknown) => {
          this.diagnostics.log(
            'warn',
            `Could not restart ${agentId} for its Node.js: ${(error as Error).message}`,
          )
        }),
      ),
    )
  }

  async collectDiagnostics(): Promise<DiagnosticsBundle> {
    const node = this.env.nodeProbe()
    const adapters = await Promise.all(
      this.agents.ids().map((agentId) => this.agents.adapterFiles(agentId).catch(() => null)),
    )
    return {
      createdAt: Date.now(),
      appVersion: this.options.appVersion,
      platform: this.options.platform,
      environment: {
        PATH: this.env.get('PATH') ?? null,
        SHELL: this.env.get('SHELL') ?? null,
        node: node.nodeVersion,
      },
      environmentInfo: this.env.info(),
      agents: this.agents.ids().map((agentId, i) => ({
        status: this.agents.status(agentId),
        capabilities: this.agents.rawCapabilities(agentId),
        ...this.diagnostics.agentRecords(agentId),
        adapter: adapters[i] ?? null,
      })),
      sessions: this.sessions.list(),
      log: this.diagnostics.logEntries(),
    }
  }

  private requireGit(): GitServiceApi {
    if (!this.git) throw new HostError('git_error', t('git.notReady'))
    return this.git
  }

  /** Runs git with the resolved environment, so git and gh are found as the agents find them. */
  private async gitCall<T>(run: (git: GitServiceApi) => Promise<T>): Promise<T> {
    const git = this.requireGit()
    await this.env.ready()
    try {
      return await run(git)
    } catch (error) {
      if (error instanceof HostError) throw error
      throw new HostError('git_error', (error as Error)?.message ?? String(error))
    }
  }

  /** Runs a git request that reads or writes a registered project or a scratch folder. */
  private async gitProjectCall<T>(
    projectPath: string,
    run: (git: GitServiceApi, canonical: string) => Promise<T>,
  ): Promise<T> {
    const canonical = await this.gitProject(projectPath)
    return this.gitCall((g) => run(g, canonical))
  }

  /**
   * Refuses a canonical folder that is not a registered project, a further folder of one, a
   * scratch folder or a worktree a session works in: files, git and media are read nowhere else.
   */
  private assertOpenFolder(canonical: string): void {
    if (this.scratch.contains(canonical) || this.sessions.isSessionWorktree(canonical)) return
    if (this.projects.isFolder(canonical)) return
    this.projects.match(canonical)
  }

  /** A registered project, a scratch folder or a session's worktree, canonical; git runs nowhere else. */
  private async gitProject(projectPath: string): Promise<string> {
    this.requireGit()
    const canonical = await this.projects.resolveDirectory(projectPath)
    this.assertOpenFolder(canonical)
    return canonical
  }

  /**
   * Runs a file request for a registered project or a scratch folder, once the environment git
   * needs is resolved.
   */
  private async filesCall<T>(projectPath: string, run: (root: string) => Promise<T>): Promise<T> {
    const canonical = await this.projects.resolveDirectory(projectPath)
    this.assertOpenFolder(canonical)
    await this.env.ready()
    return run(canonical)
  }

  /**
   * Huli: moving sessions to other computers. Main runs a move: of this computer's host through
   * its own messages, of another as a device that is a desktop app; a window never.
   */
  private sessionMoves(ctx: RequestContext): Promise<SessionMoves> {
    if (ctx.portId !== MAIN_PORT && ctx.device?.browser !== true) {
      throw new HostError('forbidden', 'Only the app moves sessions')
    }
    this.movesService ??= import('./session-move/service').then(
      ({ SessionMoves }) =>
        new SessionMoves({
          platform: this.options.platform,
          homeDir: this.options.homeDir ?? os.homedir(),
          folder: path.join(this.options.userDataPath, 'moves'),
          exec: this.execRunner.exec,
          ready: () => this.env.ready(),
          sessions: this.sessions,
          agents: this.agents,
          projects: {
            paths: () => this.projects.paths(),
            add: (folder) => this.projects.add(folder),
            remove: (folder) => {
              const record = this.projects.find(folder)
              if (record && this.sessions.list(record.path).length === 0) {
                this.projects.remove(record)
              }
            },
          },
          worktreeRoot: (projectPath) => this.worktrees.rootFor(projectPath),
          log: (level, message) => this.diagnostics.log(level, message),
        }),
    )
    return this.movesService
  }

  /** Huli: Agent sync, loaded the first time Marketplace › Sync asks for it. */
  private agentSync(): Promise<AgentSync> {
    this.agentSyncService ??= import('./agent-sync/service').then(
      ({ AgentSync }) =>
        new AgentSync({
          userDataPath: this.options.userDataPath,
          home: this.options.homeDir ?? os.homedir(),
          platform: this.options.platform,
          log: (level, message) => this.diagnostics.log(level, message),
          agents: () => this.agents.syncContexts(this.settings.disabledAgents),
        }),
    )
    return this.agentSyncService
  }

  /** For Settings › MCP servers: Kettu's own server and where each agent keeps its own. */
  private async mcpStatus(): Promise<McpStatus> {
    const service = this.artifactService
    return {
      servers: [
        {
          name: SERVICE_NAME,
          title: 'Kettu',
          builtIn: true,
          running: service.listeningPort !== null,
          error: service.error,
          tools: service.toolSummaries(),
        },
      ],
      places: await this.agents.mcpPlaces(),
    }
  }

  private handlers(): Handlers {
    const { agents, sessions, projects, artifacts, routines, memory } = this
    return {
      'agents.list': () => agents.list(),
      'agents.check': ({ agentId }) => agents.check(agentId),
      'agents.reloadEnvironment': async () => {
        const result = await agents.reloadEnvironment()
        // A tool installed since the last probe shows up without a restart.
        if (this.git) await this.gitCall((g) => g.reloadTools())
        return result
      },
      'agents.detectedPrograms': async () => {
        await agents.check()
        return agents.userPrograms()
      },
      'agents.environment': () => this.env.info(),
      'environment.installNode': async () => {
        const { install, installed, source } = await this.nodeRuntime.install()
        return { version: install.version, installed, source }
      },
      'environment.cancelNodeInstall': () => this.nodeRuntime.cancel(),
      'environment.removeNode': () => this.nodeRuntime.remove(),
      'environment.setNodeChoice': ({ choice }) => this.nodeRuntime.setChoice(choice),
      'agents.authenticate': ({ agentId, methodId }, ctx) =>
        agents.authenticate(agentId, methodId, {
          device: ctx.device !== null,
          openLink: (url) =>
            this.hub.send([ctx.portId], { type: 'agents.signInLink', agentId, url }),
          showImage: (image) =>
            this.hub.send([ctx.portId], { type: 'agents.signInImage', agentId, image }),
        }),
      'agents.cancelSignIn': ({ agentId }) => agents.cancelSignIn(agentId),
      'agents.logout': ({ agentId }) => agents.logout(agentId),
      'agents.providerAction': (input) => agents.providerAction(input),
      'agents.retry': ({ agentId }) => agents.retry(agentId),
      'agents.reinstall': ({ agentId }) => agents.reinstall(agentId),
      'agents.checkUpdates': () => agents.checkUpdates(),
      'agents.skipUpdate': ({ agentId }) => agents.skipUpdate(agentId),
      'agents.unskipUpdate': ({ agentId }) => agents.unskipUpdate(agentId),
      'agents.update': ({ agentId }) => agents.update(agentId),
      'agents.updateCli': ({ agentId }) => agents.updateCli(agentId),
      'agents.setApiKey': ({ agentId, ...input }) => agents.setApiKey(agentId, input),
      'agents.clearApiKey': ({ agentId }) => agents.clearApiKey(agentId),
      'agents.resetPreview': async ({ agentId }) => ({
        ...(await agents.resetPreview(agentId, Object.keys(this.agentEnvKeys[agentId] ?? {}))),
        busy: sessions.busyWith(agentId),
      }),
      'agents.reset': async ({ agentId, categories }) => {
        const busy = sessions.busyWith(agentId)
        if (busy.length > 0) {
          throw new HostError('busy', t('agent.resetBusy', { count: busy.length }), { busy })
        }
        return agents.reset(agentId, categories, () => sessions.releaseAgent(agentId))
      },
      'agents.removalPreview': async ({ agentId }) => ({
        ...(await agents.removalPreview(agentId)),
        busy: sessions.busyWith(agentId),
      }),
      'agents.removeFromComputer': async ({ agentId, steps, trash }, ctx) => {
        const busy = sessions.busyWith(agentId)
        if (busy.length > 0) {
          throw new HostError('busy', t('agent.removeBusy', { count: busy.length }), { busy })
        }
        return agents.removeFromComputer(agentId, steps, {
          trash: trash ? (paths) => this.trash(paths) : null,
          release: () => sessions.releaseAgent(agentId),
          progress: (step, state, error) =>
            this.hub.send([ctx.portId], {
              type: 'agents.removalProgress',
              progress: { agentId, stepId: step.id, state, ...(error ? { error } : {}) },
            }),
        })
      },
      'agents.install': ({ agentId, method }) => agents.install(agentId, method),
      'agents.uninstall': ({ agentId, removeProgram }) =>
        agents.uninstall(agentId, removeProgram === true),
      'agents.installOffer': ({ agentId }) => agents.installOffer(agentId),
      'agents.cancelTask': ({ agentId }) => agents.cancelTask(agentId),
      'agents.readOptions': async ({ agentId, projectPath }) => {
        const entry = this.agentOptions.get(agentId)
        // A provisional entry lacks the agent's defaults and its mode, which a switch to it shows.
        if (entry && !entry.provisional && Date.now() - entry.observedAt < OPTIONS_FRESH_MS) return
        const folder =
          projectPath === null
            ? null
            : await projects.resolveDirectory(projectPath).catch(() => null)
        await agents.readOptions(agentId, folder ?? undefined)
      },
      'agents.readFirstOptions': async ({ agentId }) => {
        if (this.agentOptions.known(agentId)) return
        await agents.readFirstOptions(agentId)
      },
      'agents.refreshLimits': ({ agentId, force, ask }) =>
        agents.refreshLimits(agentId, { force, ask }),
      'agents.spendReset': ({ agentId, creditId, requestId }) =>
        agents.spendReset(agentId, creditId, requestId),
      'agents.details': ({ agentId }) => agents.details(agentId),
      'agents.claudeSettings': ({ agentId }) =>
        agents.claudeSettings(agentId, listedModels(this.agentOptions.get(agentId)?.config)),
      'agents.setClaudeSetting': ({ agentId, change }) => agents.setClaudeSetting(agentId, change),
      'agents.autoCompact': ({ agentId }) =>
        agents.autoCompact(agentId, this.agentOptions.get(agentId)?.config, () =>
          this.appServer(agentId),
        ),
      'agents.setAutoCompact': ({ agentId, change }) =>
        agents.setAutoCompact(agentId, change, () => this.appServer(agentId)),
      'agents.codebuddySettings': ({ agentId }) => agents.codebuddySettings(agentId),
      'agents.codexSettings': ({ agentId }) =>
        agents.codexSettings(agentId, () => this.appServer(agentId)),
      'agents.setCodexSetting': ({ agentId, change }) =>
        agents.setCodexSetting(agentId, change, () => this.appServer(agentId)),
      'agents.setCodebuddySite': ({ agentId, change }) => agents.setCodebuddySite(agentId, change),
      'agents.refreshAccount': ({ agentId, force }) => agents.refreshAccount(agentId, { force }),
      'agents.readSignIn': ({ agentId, watch }) => agents.readSignIn(agentId, { watch }),
      'agents.options': () => this.agentOptions.list().map((o) => this.withStartMode(o)),
      'agents.pinModel': ({ agentId, model, pinned }) =>
        this.agentOptions.pin(agentId, model, pinned),
      'agents.lightAgents': () => ({ agents: this.sessions.lightAgents() }),
      'agents.draftReport': (params) => this.draftReport(params),
      'mcp.status': () => this.mcpStatus(),
      'market.catalog': ({ refresh, cached }) =>
        this.marketCatalog.catalog(refresh === true, cached === true),
      'market.search': ({ query }) => this.marketCatalog.search(query),
      'market.keys': () => keyState(this.settings.marketplace.mcp, this.marketKeys),
      'market.connect': ({ serverId }) => this.marketConnections.connect(serverId),
      'market.detectSignIn': async ({ url, headers }) => ({
        oauth: await this.marketConnections.detect(
          url,
          Object.fromEntries(headers.map((header) => [header.name, header.value])),
        ),
      }),
      'market.cancelConnect': ({ loginId }) => this.marketConnections.cancel(loginId),
      'market.disconnect': ({ serverId }) => this.marketConnections.disconnect(serverId),
      'market.connections': () => this.marketConnections.view(),
      'market.plugins': ({ refresh, cached }) =>
        this.marketPlugins.plugins(refresh === true, cached === true),
      'market.pluginDetails': ({ agentId, pluginId }) =>
        this.marketPlugins.details(agentId, pluginId),
      'market.pluginLogo': ({ pluginId }) => this.marketPlugins.logo(pluginId),
      'market.installPlugin': ({ agentId, pluginId, scope, projectPath }) =>
        this.marketPlugins.install(agentId, pluginId, scope, projectPath ?? null),
      'market.uninstallPlugin': ({ agentId, pluginId, scope, projectPath }) =>
        this.marketPlugins.uninstall(agentId, pluginId, scope, projectPath ?? null),
      'market.setPluginEnabled': ({ agentId, pluginId, enabled, scope, projectPath }) =>
        this.marketPlugins.setEnabled(agentId, pluginId, enabled, scope, projectPath ?? null),
      'market.addMarketplace': ({ agentId, source }) =>
        this.marketPlugins.addMarketplace(agentId, source),
      'market.removeMarketplace': ({ agentId, name }) =>
        this.marketPlugins.removeMarketplace(agentId, name),
      'market.skills': ({ refresh, cached }) =>
        this.marketSkills.skills(refresh === true, cached === true),
      'market.skillRepository': ({ id, refresh }) =>
        this.marketSkills.repository(id, refresh === true),
      'market.addSkill': ({ source }) => this.marketSkills.add(source),
      'settings.answerChange': ({ sessionId, entryId, decision }, { device }) =>
        this.sessions.answerSettings(sessionId, entryId, decision, fromDevice(device)),
      'settings.undoChange': ({ sessionId, entryId }) => this.undoSettings(sessionId, entryId),
      'theme.answerChange': ({ sessionId, entryId, decision }, { device }) =>
        this.sessions.answerTheme(sessionId, entryId, decision, fromDevice(device)),
      'theme.undoChange': ({ sessionId, entryId }) => this.undoTheme(sessionId, entryId),
      'secrets.answer': ({ sessionId, entryId, ...answer }, { device }) =>
        this.secretTools.answer(sessionId, entryId, answer, fromDevice(device)),
      'market.answerPublish': ({ sessionId, entryId, ...answer }, { device }) =>
        this.sessions.answerMarket(
          sessionId,
          entryId,
          answer,
          (handle) => this.setPublisher(handle),
          fromDevice(device),
        ),
      'market.publishDrafts': async () => {
        await this.publishDrafts.ready
        return { drafts: this.publishDrafts.list() }
      },
      'market.discardPublishDraft': async ({ id }) => {
        await this.publishDrafts.remove(id)
        this.hub.broadcast({ type: 'market.publishedChanged' })
      },
      'market.account': () => ({ account: this.marketAccount }),
      'market.published': async () => {
        await this.publishDrafts.ready
        return this.marketTools.published()
      },
      'market.setPublisher': ({ handle }) => this.marketTools.renamePublisher(handle),
      'market.updateListing': ({ id, change }) => this.marketTools.updateListing(id, change),
      'market.withdrawVersion': ({ id, version }) => this.marketTools.withdrawVersion(id, version),
      'market.deleteListing': ({ id }) => this.marketTools.deleteListing(id),
      'market.versionFiles': ({ id, version }) => this.marketTools.versionFiles(id, version),
      'market.checkFolder': async ({ path: folder, draftId }) => {
        await this.publishDrafts.ready
        return this.marketTools.checkFolder(folder, draftId ?? null)
      },
      'market.publishFolder': async ({ path: folder, draftId, visibility, notes, handle }) => {
        await this.publishDrafts.ready
        // A first publish sets the publisher name before anything is uploaded, as the card does.
        if (handle !== undefined) await this.setPublisher(handle)
        return this.marketTools.publishFolder(folder, {
          draftId: draftId ?? null,
          visibility: visibility ?? null,
          notes: notes ?? null,
        })
      },
      'market.community': ({ refresh, ...query }) =>
        this.marketCommunity.directory(query, refresh === true),
      'market.communityListing': ({ id }) => this.marketCommunity.listing(id),
      'market.communityWorkflow': ({ id }) => this.marketCommunity.workflow(id),
      'market.communityInstalled': ({ refresh }) =>
        this.marketCommunity.installed(refresh === true),
      'market.installCommunityPlugin': ({ id, agentId, scope, projectPath }) =>
        this.marketCommunity.installPlugin(id, agentId, scope, projectPath ?? null),
      'market.addCommunityWorkflow': ({ id }) => this.marketCommunity.installWorkflow(id),
      'market.reportCommunity': ({ id, message }) => this.marketCommunity.report(id, message),
      'market.bundlePrepare': ({ id }) => this.marketBundles.prepare(id),
      'market.bundleCommit': ({ token, values }) => this.marketBundles.commit(token, values),
      'market.bundleCancel': ({ token }) => this.marketBundles.cancel(token),
      'sync.read': async () => (await this.agentSync()).read(),
      'sync.preview': async ({ changes }) => (await this.agentSync()).preview(changes),
      'sync.apply': async ({ previewId }) => (await this.agentSync()).apply(previewId),
      'sync.saveSnippets': async ({ snippets }) => (await this.agentSync()).saveSnippets(snippets),
      'mcp.retry': async () => {
        await this.artifactService.start()
        this.options.send({ type: 'host:service-port', port: this.artifactService.listeningPort })
        return this.mcpStatus()
      },
      'agents.listSessions': ({ agentId, projectPath, cursor }) =>
        sessions.listImportable(agentId, projectPath, cursor ?? null),
      'projects.list': () => {
        void projects.refreshMissing()
        return projects.list()
      },
      'projects.add': ({ path }) => projects.add(path),
      'projects.remove': async ({ path }) => {
        const record = projects.match(path)
        await sessions.removeProject(record.path)
        projects.remove(record)
        this.options.send({ type: 'host:media-revoke', sessionId: null })
      },
      'projects.touch': ({ path }) => projects.touch(projects.match(path)),
      'projects.pin': ({ path, pinned }) =>
        path === null ? projects.pinNoProject(pinned) : projects.pin(projects.match(path), pinned),
      'projects.move': ({ path, before }) =>
        projects.move(projects.match(path), before === null ? null : projects.match(before)),
      'projects.orderSessions': ({ path, ids }) =>
        projects.orderSessions(path === null ? null : projects.match(path), ids),
      'projects.noProject': () => projects.noProject(),
      'projects.setSandbox': ({ path, sandbox }) =>
        projects.setSandbox(projects.match(path), sandbox),
      'projects.addFolder': ({ path, folder }) => projects.addFolder(projects.match(path), folder),
      'projects.removeFolder': ({ path, folder }) =>
        projects.removeFolder(projects.match(path), folder),
      'projects.suggestFolders': async ({ path }) => {
        const record = projects.match(path)
        const { suggestFolders } = await import('./project-folders')
        return suggestFolders(record.path, record.folders ?? [], {
          platform: this.options.platform,
        })
      },
      'sessions.setSandbox': ({ sessionId, sandbox }) =>
        this.sessions.setSandbox(sessionId, sandbox),
      'sandbox.containerStatus': async () => (await this.containerSandbox()).status(),
      'sandbox.pullImage': async () => (await this.containerSandbox()).pull(),
      'sandbox.removeImage': async () => (await this.containerSandbox()).remove(),
      'webReader.status': () => this.webReader.status(),
      'webReader.install': async () => {
        await this.webReader.install()
        return this.webReader.status()
      },
      'webReader.cancel': () => this.webReader.cancel(),
      'webReader.remove': () => this.webReader.remove(),
      'projects.setAutoApprove': ({ path, autoApprove }) =>
        projects.setAutoApprove(projects.match(path), autoApprove),
      'projects.setManager': ({ path, manager }) =>
        projects.setManager(projects.match(path), manager),
      'projects.worktreeSettings': ({ path }) =>
        projects.worktreeSettings(projects.match(path).path),
      'projects.setWorktreeSettings': ({ path, settings }) =>
        projects.setWorktreeSettings(projects.match(path).path, settings),
      'projects.places': () => this.projectCreate.places(),
      'projects.clone': (params, ctx) =>
        this.projectCreate.clone(params, { portId: ctx.portId, device: ctx.device !== null }),
      'projects.cancelClone': ({ cloneId }) => this.projectCreate.cancelClone(cloneId),
      'projects.create': (params, ctx) =>
        this.projectCreate.create(params, { portId: ctx.portId, device: ctx.device !== null }),
      'paths.complete': ({ path }) =>
        completePath(path, this.options.platform, this.options.homeDir ?? os.homedir()),
      'sessions.list': ({ projectPath }) => sessions.list(projectPath),
      'sessions.create': async (params, { portId, device }) => {
        if (params.manager && !this.featureOn('manager')) throw featureOff('manager')
        // A worktree is made with git, which is found as the agents find it.
        if (params.worktree) await this.env.ready()
        if (params.prompt) this.shareSurfaces(null, params.prompt)
        return sessions.create(device ? { ...params, device: fromDevice(device) } : params, portId)
      },
      'sessions.prepare': (params, { portId }) => sessions.prepare(params, portId),
      'sessions.discard': ({ sessionId }) => sessions.discard(sessionId),
      'sessions.setProfile': ({ sessionId, profileId }) =>
        sessions.setProfile(sessionId, profileId),
      // Huli: one listed by the import from the agents keeps its title and times.
      'sessions.import': ({ source, ...params }) =>
        sessions.importSession(
          params,
          this.agentHistory.keptFor(params.agentId, params.acpSessionId, source ?? null),
        ),
      'sessions.open': async ({ sessionId }, { device }) =>
        digestsFor(device, await sessions.open(sessionId, imagesFor(device))),
      'sessions.snapshot': async ({ sessionId, from }, { device }) =>
        digestsFor(device, await sessions.snapshot(sessionId, from, imagesFor(device))),
      'sessions.page': async ({ sessionId, before, from }, { device }) =>
        digestsFor(device, await sessions.page(sessionId, before, from, imagesFor(device))),
      'sessions.entry': ({ sessionId, entryId }, { device }) =>
        sessions.entry(sessionId, entryId, imagesFor(device)),
      'sessions.requests': async ({ sessionId }, { device }) => ({
        ...(await sessions.requests(sessionId, imagesFor(device))),
        suggestions: await this.workflowSuggestions.waitingFor(sessionId),
      }),
      'sessions.outline': ({ sessionId }) => sessions.outline(sessionId),
      'sessions.modelRequests': ({ sessionId, before }) =>
        sessions.modelRequests(sessionId, before ?? null),
      'sessions.modelRequestsOverview': ({ sessionId }) =>
        sessions.modelRequestsOverview(sessionId),
      'sessions.modelRequestRaw': ({ sessionId, raw, full }) =>
        sessions.modelRequestRaw(sessionId, raw, full === true),
      'sessions.search': ({ query }) => sessions.search(query),
      'sessions.find': ({ sessionId, query }) => sessions.find(sessionId, query),
      'sessions.outputs': ({ sessionId }) => sessions.outputs(sessionId),
      'sessions.outlineTitles': ({ sessionId }) => sessions.outlineTitles(sessionId),
      'sessions.watch': ({ sessionId }, { portId }) => sessions.watch(sessionId, portId),
      'sessions.unwatch': ({ sessionId }, { portId }) => sessions.unwatch(sessionId, portId),
      'sessions.show': ({ sessionIds }, { portId }) => sessions.show(sessionIds, portId),
      'sessions.prompt': ({ sessionId, content }, { portId, device }) => {
        this.shareSurfaces(sessionId, content)
        return sessions.prompt(sessionId, content, portId, fromDevice(device))
      },
      'sessions.attachEarly': ({ sessionId }) => sessions.attachEarly(sessionId),
      'sessions.cancel': ({ sessionId }) => sessions.cancel(sessionId),
      'sessions.runningWork': ({ sessionIds }) => ({ sessions: sessions.runningWork(sessionIds) }),
      'sessions.idleRelease': () => this.idleRelease.state(),
      'sessions.stopTask': ({ sessionId, taskId }) => sessions.stopTask(sessionId, taskId),
      'sessions.taskOutput': ({ sessionId, taskId }) => sessions.taskOutput(sessionId, taskId),
      'sessions.processes': ({ sessionId }) => sessions.processes(sessionId),
      'sessions.mcp': ({ sessionId }) => sessions.mcp(sessionId),
      'sessions.mcpAct': ({ sessionId, action, server }) =>
        sessions.mcpAct(sessionId, action, server),
      'sessions.mcpLogin': ({ sessionId, server }) => sessions.mcpLogin(sessionId, server),
      'sessions.reloadPlugins': ({ sessionId }) => sessions.reloadPlugins(sessionId),
      'sessions.toBackground': ({ sessionId, toolCallId }) =>
        sessions.toBackground(sessionId, toolCallId),
      'sessions.cleanTasks': ({ sessionId }) => sessions.cleanTasks(sessionId),
      'sessions.retry': ({ sessionId }, { portId }) => sessions.retry(sessionId, portId),
      'sessions.rewind': ({ sessionId, entryId, draft }) =>
        sessions.rewind(sessionId, entryId, draft),
      'sessions.putBack': ({ sessionId }) => sessions.putBack(sessionId),
      'sessions.sideAsk': ({ sessionId, question, quote, agentId }) =>
        sessions.sideAsk(sessionId, question, quote ?? null, agentId ?? null),
      'sessions.sideStop': ({ sessionId }) => sessions.sideStop(sessionId),
      'sessions.review': ({ sessionId }) => sessions.review(sessionId),
      'sessions.reviewStart': ({ sessionId }) => sessions.reviewStart(sessionId),
      'sessions.reviewStop': ({ sessionId }) => sessions.reviewStop(sessionId),
      'sessions.reviewAct': ({ sessionId, reviewId, findingIds, action }, { portId, device }) =>
        sessions.reviewAct(sessionId, reviewId, findingIds, action, portId, fromDevice(device)),
      'sessions.suggestTitle': ({ sessionId }) => sessions.suggestTitle(sessionId),
      'sessions.sideClear': ({ sessionId, undo }) => sessions.sideClear(sessionId, undo === true),
      'sessions.sideAgents': ({ sessionId }) => ({ agents: sessions.sideAgents(sessionId) }),
      'sessions.fork': ({ sessionId, entryId, worktree }) =>
        sessions.fork(sessionId, entryId, worktree),
      'sessions.revert': ({ sessionId, entryId }) => sessions.revert(sessionId, entryId),
      'sessions.rewindPreview': ({ sessionId, entryId }) =>
        sessions.rewindPreview(sessionId, entryId),
      'sessions.restoreFiles': ({ sessionId, entryId, token }) =>
        sessions.restoreFiles(sessionId, entryId, token),
      'sessions.undoRewindFiles': ({ sessionId, backup }) =>
        sessions.undoRewindFiles(sessionId, backup),
      'worktrees.inspect': ({ sessionId }) =>
        this.gitCall(() => sessions.inspectWorktree(sessionId)),
      'worktrees.remove': ({ sessionId, branch, expected }) =>
        this.gitCall(() => sessions.removeWorktree(sessionId, branch, expected)),
      'groups.start': async (params) => {
        // Its worktrees are made with git, which is found as the agents find it.
        await this.env.ready()
        this.shareSurfaces(null, params.prompt)
        return this.groups.start(params)
      },
      'groups.changes': ({ sessionId }) => this.gitCall(() => this.groups.changes(sessionId)),
      'groups.fileDiff': ({ sessionId, path, oldPath }) =>
        this.gitCall(() => this.groups.fileDiff(sessionId, path, oldPath)),
      'groups.keep': ({ sessionId }) => this.gitCall(() => this.groups.keep(sessionId)),
      'groups.discard': ({ sessionIds }) => this.gitCall(() => this.groups.discard(sessionIds)),
      'worktrees.retrySetup': ({ sessionId }) => sessions.retryWorktreeSetup(sessionId),
      'worktrees.skipSetup': ({ sessionId }) => sessions.skipWorktreeSetup(sessionId),
      'worktrees.setupLog': ({ sessionId, from }) => sessions.worktreeSetupLog(sessionId, from),
      'sessions.switchAgent': (params, { portId, device }) => {
        this.shareSurfaces(params.sessionId, params.content)
        return sessions.switchAgent(params, portId, fromDevice(device))
      },
      'sessions.context': ({ sessionId }) => sessions.context(sessionId),
      'sessions.contextEstimates': ({ sessionId }) => sessions.contextEstimates(sessionId),
      'sessions.queue': ({ sessionId, content, comments }, { portId, device }) => {
        this.shareSurfaces(sessionId, content)
        return sessions.queue(sessionId, content, portId, fromDevice(device), comments)
      },
      'sessions.runCommand': (params, { portId, device }) =>
        this.runReplyCommand(params, portId, device),
      'sessions.launchConfigs': ({ sessionId }) => this.launchConfigs(sessionId),
      'sessions.unqueue': ({ sessionId, itemId }) => sessions.unqueue(sessionId, itemId),
      'sessions.steer': ({ sessionId, itemId }) => sessions.steer(sessionId, itemId),
      'sessions.sendNow': ({ sessionId, itemId }) => sessions.sendNow(sessionId, itemId),
      'sessions.resumeQueue': ({ sessionId }) => sessions.resumeQueue(sessionId),
      'sessions.limitPause': ({ sessionId, action }) =>
        sessions.limitPauseAction(sessionId, action),
      'sessions.setAutoResume': ({ sessionId, on }) => sessions.setAutoResume(sessionId, on),
      'sessions.setBoardStatus': ({ sessionId, status }) =>
        sessions.setBoardStatus(sessionId, status),
      'manager.set': ({ sessionId, on, choices }) => sessions.setManager(sessionId, on, choices),
      'manager.stopAll': ({ sessionId }) => sessions.stopAllWorkers(sessionId),
      'manager.pause': ({ sessionId, paused }) => sessions.pauseManager(sessionId, paused),
      'manager.detach': ({ sessionId, detached }) => sessions.detachWorker(sessionId, detached),
      'manager.moreTurns': ({ sessionId }) => sessions.moreManagerTurns(sessionId),
      'sessions.setPrFlow': ({ sessionId, url, autoMerge, watch }) =>
        this.gitCall(() =>
          sessions.setPrFlow(sessionId, url, {
            ...(autoMerge === undefined ? {} : { autoMerge }),
            ...(watch === undefined ? {} : { watch }),
          }),
        ),
      'sessions.stall': ({ sessionId, action }) => sessions.stallAction(sessionId, action),
      'sessions.allowDenied': ({ sessionId, entryId, confirmed }) =>
        sessions.allowDenied(sessionId, entryId, confirmed === true),
      'sessions.blob': ({ sessionId, hash }) => sessions.blob(sessionId, hash),
      'sessions.setConfigOption': ({ sessionId, optionId, value }) =>
        sessions.setConfigOption(sessionId, optionId, value),
      'sessions.refreshModels': ({ sessionId }) => sessions.refreshModels(sessionId),
      'sessions.rename': ({ sessionId, title }) => sessions.rename(sessionId, title),
      'sessions.close': ({ sessionId }) => sessions.close(sessionId),
      'sessions.terminalCommand': async ({ sessionId, run }) => {
        const target = sessions.terminalTarget(sessionId)
        const lines = await agents.resumeCommand(target.agentId, target, false)
        if (!run) return lines
        await sessions.resumingInTerminal(sessionId)
        return agents.resumeCommand(target.agentId, target, true)
      },
      'sessions.pin': ({ sessionId, pinned }) => sessions.pin(sessionId, pinned),
      'sessions.snooze': ({ sessionId, until }) => sessions.snooze(sessionId, until),
      'sessions.settle': ({ sessionId, settled }) => sessions.settle(sessionId, settled),
      'sessions.setNeverSettle': ({ sessionId, never }) =>
        sessions.setNeverSettle(sessionId, never),
      'sessions.archive': ({ sessionId, subSessions }) =>
        sessions.archive(sessionId, subSessions ?? true),
      'sessions.unarchive': ({ sessionId }) => sessions.unarchive(sessionId),
      'sessions.markUnread': ({ sessionId, unread }) => sessions.markUnread(sessionId, unread),
      'sessions.delete': async ({ sessionId }) => {
        await sessions.delete(sessionId)
        this.options.send({ type: 'host:media-revoke', sessionId })
      },
      'sessions.removeEmpty': ({ keep }) => sessions.removeEmptyOnce(keep),
      'sessions.takeReturned': ({ sessionId }, { portId }) =>
        sessions.takeReturned(sessionId, portId),
      'routines.list': () => routines.list(),
      'routines.create': (draft) => routines.create(draft),
      'routines.update': ({ routineId, changes }) => routines.update(routineId, changes),
      'routines.delete': ({ routineId }) => routines.delete(routineId),
      'routines.runNow': ({ routineId }) => routines.runNow(routineId),
      'routines.cancelRun': ({ runId }) => routines.cancelRun(runId),
      'routines.runs': ({ routineId, before }) => routines.runsOf(routineId, before),
      'routines.markSeen': ({ routineId }) => routines.markSeen(routineId),
      'routines.webhookSecret': ({ routineId }) => this.newWebhookSecret(routineId),
      'workflows.list': () => this.workflowLibrary.list(),
      'workflows.read': ({ workflowId }) => this.workflowLibrary.read(workflowId),
      'workflows.add': (source) => this.workflowLibrary.add(source),
      'workflows.update': ({ workflowId }) => this.workflowLibrary.update(workflowId),
      'workflows.approve': ({ workflowId, hash }) => this.workflowLibrary.approve(workflowId, hash),
      'workflows.remove': ({ workflowId }) => this.workflowLibrary.remove(workflowId),
      'workflows.suggestions': ({ sessionId }) => this.workflowSuggestions.forSession(sessionId),
      'workflows.suggestionFile': async ({ id }) => ({
        text: await this.workflowSuggestions.file(id),
      }),
      'workflows.answerSuggestion': async ({ id, answer, agentId, options }, { device }) => {
        const from = fromDevice(device)
        switch (answer) {
          case 'start': {
            const first = {
              ...(agentId ? { agentId } : {}),
              ...(options ? { options } : {}),
            }
            const { view, done } = await this.workflowSuggestions.start(id, first, from)
            void done.catch((error: unknown) =>
              this.diagnostics.log(
                'warn',
                `Workflow card ${id} stopped: ${(error as Error).message}`,
              ),
            )
            return view
          }
          case 'decline':
          case 'another':
            return this.workflowSuggestions.decline(id, from, answer === 'another')
          case 'reconsider':
            return this.workflowSuggestions.reconsider(id)
          case 'save':
            return this.workflowSuggestions.save(id, from)
          case 'not_save':
            return this.workflowSuggestions.notSave(id, from)
        }
      },
      'workflows.pin': async ({ workflowId, stepId, pick }) => {
        const entry = await this.workflowLibrary.setPin(workflowId, stepId, pick)
        this.tasks.recheck()
        return entry
      },
      'workflows.settings': () => this.workflowSettings(),
      'workflows.setSettings': (change) => {
        const suggested = this.workflowLibrary.suggest
        this.workflowLibrary.setSettings(change)
        if (this.workflowLibrary.suggest !== suggested) void this.ownSkillsChanged()
        this.tasks.recheck()
        return this.workflowSettings()
      },
      'tasks.list': () => this.tasks.list(),
      'tasks.get': ({ taskId }) => this.tasks.get(taskId),
      'tasks.sessions': ({ taskId }) => {
        const ids = new Set(this.tasks.get(taskId).rounds.flatMap((round) => round.sessionId ?? []))
        return [...ids].flatMap((id) => (sessions.has(id) ? [sessions.summary(id)] : []))
      },
      'tasks.start': ({ from, ...params }) => this.tasks.start(params, from),
      'tasks.review': ({ taskId, roundId, approve, note }) =>
        this.tasks.review(taskId, roundId, approve, note ?? null),
      'tasks.answer': ({ taskId, roundId, outcome, note }) =>
        this.tasks.answer(taskId, roundId, outcome, note ?? null),
      'tasks.retry': ({ taskId, stepId, note }) => this.tasks.retry(taskId, stepId, note ?? null),
      'tasks.cancel': ({ taskId }) => this.tasks.cancel(taskId),
      'tasks.delete': ({ taskId }) => this.tasks.delete(taskId),
      'tasks.note': ({ taskId, text }) => this.tasks.note(taskId, text),
      'tasks.pin': ({ taskId, stepId, pick }) => this.tasks.pinStep(taskId, stepId, pick),
      'tasks.update': ({ taskId, ...change }) => this.tasks.update(taskId, change),
      'tasks.saveWorkflow': ({ taskId }) => this.saveTaskWorkflow(taskId),
      'tasks.publishWorkflow': ({ taskId }) => this.publishTaskWorkflow(taskId),
      'sessions.removeAll': async () => {
        await sessions.removeAll()
        this.options.send({ type: 'host:media-revoke', sessionId: null })
      },
      'permissions.respond': (
        { sessionId, requestId, optionId, note, answers, values },
        { device },
      ) =>
        sessions.respond(
          sessionId,
          requestId,
          answers
            ? { answers }
            : values
              ? { values }
              : { optionId: optionId!, ...(note === undefined ? {} : { note }) },
          fromDevice(device),
        ),
      'git.status': async ({ projectPath, watcher }, { portId }) => {
        const git = this.requireGit()
        const canonical = await this.gitProject(projectPath)
        await this.env.ready()
        if (!this.hub.has(portId)) return this.gitCall((g) => g.status(canonical))
        const key = pathKey(canonical, this.options.platform)
        if (this.gitRetains.add(key, canonical, portId, watcher ?? '')) {
          git.retain(canonical, portId)
        }
        return this.gitCall((g) => g.status(canonical))
      },
      'git.unwatch': async ({ projectPath, watcher }, { portId }) => {
        const git = this.requireGit()
        // The folder may be gone by now; the retained entry still knows its canonical path.
        const canonical = await projects.resolveDirectory(projectPath).catch(() => projectPath)
        const key = pathKey(canonical, this.options.platform)
        const path = this.gitRetains.remove(key, portId, watcher ?? '')
        if (path !== null) git.release(path, portId)
      },
      'git.fetch': ({ projectPath }) => this.gitProjectCall(projectPath, (g, p) => g.fetch(p)),
      'git.pull': ({ projectPath }) => this.gitProjectCall(projectPath, (g, p) => g.pull(p)),
      'git.push': ({ projectPath, remote, branch }) =>
        this.gitProjectCall(projectPath, (g, p) => g.push(p, { remote, branch })),
      'git.publish': ({ projectPath, name, visibility }) =>
        this.gitProjectCall(projectPath, (g, p) => g.publish(p, name, visibility)),
      'git.createPullRequest': ({ projectPath, title, body, base, draft }) =>
        this.gitProjectCall(projectPath, (g, p) =>
          g.createPullRequest(p, { title, body, base, draft }),
        ),
      'git.commit': ({ projectPath, oid }) =>
        this.gitProjectCall(projectPath, (g, p) => g.commit(p, oid)),
      'git.changes': ({ projectPath }) => this.gitProjectCall(projectPath, (g, p) => g.changes(p)),
      'git.commitMessage': ({ projectPath, paths }) => this.commitMessage(projectPath, paths),
      'git.pullRequestDraft': ({ projectPath, base, sessionId, part }) =>
        this.pullRequestDraft(projectPath, base, sessionId, part),
      'git.suggestBranch': ({ projectPath, text, agentId }) =>
        this.suggestBranch(projectPath, text, agentId),
      'git.incoming': ({ projectPath, from }) =>
        this.gitProjectCall(projectPath, (g, p) => g.incoming(p, from)),
      'git.fileDiff': ({ projectPath, path, oldPath, ref }) =>
        this.gitProjectCall(projectPath, (g, p) => g.fileDiff(p, path, oldPath, ref)),
      'git.branches': ({ projectPath }) =>
        this.gitProjectCall(projectPath, (g, p) => g.branches(p)),
      'git.switchBranch': ({ projectPath, branch, create }) =>
        this.gitProjectCall(projectPath, (g, p) => g.switchBranch(p, branch, create)),
      'git.publishBranch': ({ projectPath, remote }) =>
        this.gitProjectCall(projectPath, (g, p) => g.publishBranch(p, remote)),
      'git.commitChanges': ({ projectPath, message, paths }) =>
        this.gitProjectCall(projectPath, (g, p) => g.commitChanges(p, message, paths)),
      'git.discardChanges': ({ projectPath, paths }) =>
        this.gitProjectCall(projectPath, (g, p) => g.discardChanges(p, paths)),
      'git.pullRequest': ({ url }) => this.gitCall((g) => g.pullRequest(url)),
      'git.issue': ({ url }) => this.gitCall((g) => g.issue(url)),
      'github.issues': ({ projectPath, filter }) =>
        this.gitCall(() => this.githubFlow.issues(projects.match(projectPath).path, filter)),
      'github.startIssue': async (params, { portId, device }) => {
        const projectPath = projects.match(params.projectPath).path
        const text = await this.gitCall(() => this.githubFlow.issuePrompt(projectPath, params.url))
        return sessions.create(
          {
            agentId: params.agentId,
            projectPath,
            ...(params.options ? { options: params.options } : {}),
            prompt: [{ type: 'text', text }],
            ...(params.worktree ? { worktree: params.worktree } : {}),
            issue: params.url,
            ...(device ? { device: fromDevice(device) } : {}),
          },
          portId,
        )
      },
      'git.watchReferences': ({ urls }, { portId }) => {
        if (this.hub.has(portId)) this.requireGit().watchReferences(portId, urls)
      },
      'git.avatarUrl': ({ login }) => this.gitCall((g) => g.avatarUrl(login)),
      'git.currentPullRequest': ({ projectPath }) =>
        this.gitProjectCall(projectPath, (g, p) => g.currentPullRequest(p)),
      'git.tools': () => this.gitCall((g) => g.tools()),
      'star.state': async () => {
        await this.env.ready()
        return this.star.state()
      },
      'star.add': async () => {
        await this.env.ready()
        return this.star.star()
      },
      'star.dismiss': () => this.star.dismiss(),
      'star.opened': () => this.star.opened(),
      'attachments.add': ({ source, thumb }, { device }) => {
        if ('projectPath' in source) {
          return this.filesCall(source.projectPath, async (root) => {
            const found = await this.files.locate(root, source.path)
            return this.attachments.addPath(found.path, found.kind, thumb)
          })
        }
        if ('upload' in source) {
          // Only a device's remote host has uploads to hand over; a window never names one.
          if (!device) throw new HostError('forbidden', 'Only a device hands over an upload')
          return this.attachments.addUpload(source, thumb)
        }
        return this.attachments.add(source, thumb)
      },
      'attachments.read': ({ id }) => this.attachments.read(id),
      'attachments.update': ({ id, thumb, scaled }) => this.attachments.update(id, thumb, scaled),
      'attachments.remove': ({ id }) => this.attachments.remove(id),
      'attachments.held': ({ ids }) => this.attachments.held(ids),
      'files.list': ({ projectPath }) =>
        this.filesCall(projectPath, (root) => this.files.list(root)),
      'files.read': ({ projectPath, path, asText }, { device }) =>
        // A device's media is read through its remote host, never main's media scheme.
        this.filesCall(projectPath, (root) => this.files.read(root, path, asText, device !== null)),
      'files.search': ({ projectPath, query }) =>
        this.filesCall(projectPath, (root) => this.files.search(root, query)),
      'files.agentFolder': ({ sessionId }) => this.agentFiles.folder(sessionId),
      'files.readAgentFile': ({ sessionId, path }) => this.agentFiles.read(sessionId, path),
      'files.readBytes': (params) => {
        const { path, offset, length, expect } = params
        const part = { offset, length, ...(expect ? { expect } : {}) }
        return 'sessionId' in params
          ? this.agentFiles.readBytes(params.sessionId, path, part)
          : this.filesCall(params.projectPath, (root) => this.files.readBytes(root, path, part))
      },
      'files.write': ({ projectPath, path, text, version }) =>
        this.filesCall(projectPath, (root) => this.files.write(root, path, text, version)),
      'files.create': ({ projectPath, path, kind }) =>
        this.filesCall(projectPath, (root) => this.files.create(root, path, kind)),
      'files.rename': ({ projectPath, from, to }) =>
        this.filesCall(projectPath, (root) => this.files.rename(root, from, to)),
      'files.copy': ({ projectPath, paths, folder }) =>
        this.filesCall(projectPath, (root) => this.files.copy(root, paths, folder)),
      'files.delete': ({ projectPath, paths, permanently }) =>
        this.filesCall(projectPath, (root) => this.files.delete(root, paths, permanently === true)),
      'media.open': async ({ projectPath, path, sessionId }) => {
        const root = await projects.resolveDirectory(projectPath)
        this.assertOpenFolder(root)
        return this.media.open(root, path, sessionId)
      },
      'media.authorize': async ({ projectPath, path, sessionId }, { device }) => {
        // A window has the media scheme; only a device's remote host streams from the path.
        if (!device) {
          throw new HostError('forbidden', 'Only a paired device may call "media.authorize"')
        }
        const root = await projects.resolveDirectory(projectPath)
        this.assertOpenFolder(root)
        return this.media.authorize(root, path, sessionId ?? null)
      },
      'usage.summary': ({ dayStarts, from, to, scope, clock }) =>
        this.usage.summary(dayStarts, from, to, scope, clock),
      'usage.total': ({ from, to }) => this.usage.total(from, to),
      'usage.status': () => this.usage.status(),
      'usage.sync': () => this.usage.sync(),
      'usage.reimport': ({ agentId }) => this.usage.reimport(agentId),
      'usage.clearRecord': () => this.usage.clearRecord(),
      'storage.usage': () => storageUsage(this.options.userDataPath, logFolder()),
      'storage.clearImages': async ({ scope, days, dryRun }) => {
        const before = scope === 'older' ? Date.now() - days * 24 * 60 * 60 * 1000 : null
        const sessionIds = sessions.imageClearTargets(scope === 'archived', before)
        if (!this.threads || sessionIds.length === 0) return { sessions: 0, images: 0, bytes: 0 }
        return this.threads.clearImages(sessionIds, dryRun)
      },
      'artifacts.list': async ({ deleted }) =>
        (await artifacts.list({ deleted: deleted ?? false })).map((artifact) => ({
          ...artifact,
          scratch: this.scratch.contains(artifact.project),
        })),
      'artifacts.read': async ({ id, version }) => {
        const read = await artifacts.read(id, version === undefined ? {} : { version })
        return {
          title: read.artifact.title,
          version: read.version.version,
          // A typed artifact's page is its type's viewer, which has no text of its own, and a
          // canvas document need not have an entry page.
          html:
            read.type || !read.files.some((f) => f.path === ARTIFACT_ENTRY)
              ? ''
              : await artifacts.entryText(read),
          type: read.type,
          seen: read.artifact.seen,
          files: read.files.map((file) => ({
            path: file.path,
            size: file.size,
            type: artifactFileType(file.path),
            hash: file.hash,
          })),
        }
      },
      'artifacts.file': async ({ id, version, path }) => {
        const found = await artifacts.read(id, { version })
        const file = found.files.find((f) => f.path === path)
        if (!file) throw new HostError('not_found', t('hostError.noArtifactFile', { path }))
        return {
          type: artifactFileType(path),
          bytes: toArrayBuffer(await artifacts.bytes(found, file)),
        }
      },
      'artifacts.content': async ({ id, version }, { device }) => {
        // A window has main's protocol; only a device's remote host serves the files from disk.
        if (!device) {
          throw new HostError('forbidden', 'Only a paired device may call "artifacts.content"')
        }
        return artifacts.content(id, version)
      },
      'artifacts.versions': async ({ id }) => (await artifacts.versions(id)).map(versionSummary),
      'artifacts.changes': async ({ id, from, to }) => ({
        changes: await artifacts.changes(id, from, to),
      }),
      'artifacts.rename': ({ id, title }) => artifacts.rename(id, title),
      'artifacts.delete': async ({ id, permanently }) => {
        if (permanently) await artifacts.erase(id)
        else await artifacts.delete(id)
      },
      'artifacts.undelete': ({ id }) => artifacts.undelete(id),
      'artifacts.restoreVersion': ({ id, version, baseVersion }) =>
        artifacts.restore({ id, version, baseVersion, author: null }),
      'artifacts.watch': async ({ id }, { portId }) => {
        await artifacts.watch(id, portId)
        // Opening a typed artifact moves its content to a newer format, as a new version.
        void upgradeContent(artifacts, this.artifactTypes, id, (level, message) =>
          this.diagnostics.log(level, message),
        ).catch(() => {})
      },
      'artifacts.export': async ({ id, version, format }) => {
        const found = await artifacts.read(id, { version })
        try {
          const files = await exportVersion(artifacts, found, format)
          return {
            title: found.artifact.title,
            files: files.map((file) => ({ path: file.path, bytes: toArrayBuffer(file.bytes) })),
          }
        } catch (error) {
          if (error instanceof ExportError) throw invalidParams(error.message)
          throw error
        }
      },
      'artifacts.unwatch': ({ id }, { portId }) => artifacts.unwatch(id, portId),
      'artifacts.comments': ({ id }) => artifacts.threads(id),
      'artifacts.comment': ({ id, anchor, body }) =>
        artifacts.addThread(id, { anchor, body, author: { person: OWNER, session: null } }),
      'artifacts.reply': ({ id, threadId, body }) =>
        artifacts.reply(id, threadId, { body, author: { person: OWNER, session: null } }),
      'artifacts.resolve': ({ id, threadId, resolved }) =>
        artifacts.resolve(id, threadId, resolved),
      'artifacts.markSent': ({ id, threadIds, sessionId }) =>
        artifacts.markSent(id, threadIds, sessionId),
      'artifacts.editElement': ({ id, baseVersion, path, offset, style, text }) =>
        artifacts.editElement({ id, baseVersion, path, offset, change: { style, text } }),
      'artifacts.view': ({ id, page }, { portId }) => artifacts.view(id, portId, page),
      'artifacts.seen': async ({ id, version }) => ({ seen: await artifacts.see(id, version) }),
      'artifacts.setParams': ({ id, baseVersion, path, values }) =>
        artifacts.setParams({ id, baseVersion, path, values }),
      'artifacts.canvas': ({ id }) => artifacts.canvases.state(id),
      'artifacts.canvasOps': ({ id, ops, client, clientSeq }) =>
        artifacts.canvases.apply(id, ops, client, clientSeq),
      'artifacts.runtime': ({ artifactId, message, stream }, { portId, device }) => {
        // A window's frames reach the runtime through main; only a device's remote host relays.
        if (!device) {
          throw new HostError('forbidden', 'Only a paired device may call "artifacts.runtime"')
        }
        return this.runtimeRequests.fromPort(portId, artifactId, message, stream, (answer) => {
          if (stream !== undefined) {
            this.hub.send([portId], { type: 'artifacts.runtime', stream, answer })
          }
        })
      },
      'artifacts.consent': ({ requestId, allow }, { portId }) =>
        this.consents.answer(requestId, allow, portId),
      'artifacts.consents': () => this.consents.list(),
      'artifacts.revokeConsent': ({ id }) => this.consents.revoke(id),
      'browser.answer': ({ callId, answer }, ctx) => {
        browserApp(ctx)
        if (!this.deviceBrowser.answer(ctx.portId, callId, answer)) {
          throw new HostError('not_found', 'This port was sent no such browser call')
        }
      },
      'browser.waiting': ({ callId, waiting }, ctx) => {
        browserApp(ctx)
        if (this.deviceBrowser.owns(ctx.portId, callId)) {
          this.artifactService.browserWaiting(callId, waiting)
        }
      },
      'browser.origin': ({ sessionId, requestId, origin }, ctx) => {
        browserApp(ctx)
        // Only the app the session's calls go to asks for its page.
        const target = browserTarget(sessions.browserSender(sessionId), this.hub)
        if (target.kind !== 'device' || target.portId !== ctx.portId) {
          throw new HostError('forbidden', 'This port does not drive the session’s browser')
        }
        sessions.browserOriginAsked(sessionId, requestId, origin, ctx.portId)
      },
      'browser.originSettled': ({ requestId, decision }, ctx) => {
        browserApp(ctx)
        sessions.browserOriginSettled(requestId, decision, ctx.portId, fromDevice(ctx.device))
      },
      'browser.handedBack': ({ sessionId, durationMs }, ctx) => {
        browserApp(ctx)
        const target = this.browserTurns.targetOf(sessionId)
        if (target?.kind !== 'device' || target.portId !== ctx.portId) {
          throw new HostError('forbidden', 'This port does not drive the session’s browser')
        }
        sessions.controlHandedBack(sessionId, 'browser', durationMs)
      },
      // The first answer goes to the page, whose waiting call then settles the card.
      'control.answerAsk': ({ sessionId, entryId, outcome }, { device }) => {
        sessions.answerControlAsk(sessionId, entryId, outcome, fromDevice(device))
        const target = this.browserTurns.targetOf(sessionId)
        if (!target || target.kind === 'main') {
          this.options.send({ type: 'host:browser-ask-answer', sessionId, outcome })
        } else {
          this.hub.send([target.portId], { type: 'browser.askAnswered', sessionId, outcome })
        }
      },
      'computer.answerApp': ({ sessionId, entryId, decision }, { device }) => {
        // Huli: administrator use and its risky steps are answered by someone at this computer,
        // where the administrator prompt and the app are.
        if (device && sessions.computerAppAsks(sessionId, entryId)) {
          throw new HostError('forbidden', 'This answer is given only on this computer.')
        }
        const requestId = sessions.answerComputerApp(
          sessionId,
          entryId,
          decision,
          fromDevice(device),
        )
        if (!this.computer?.answer(requestId, decision)) {
          throw new HostError('not_found', t('session.waiting.app.gone'))
        }
      },
      'sessions.answerProjectMcp': ({ sessionId, entryId, decision }, { device }) => {
        sessions.answerProjectMcp(sessionId, entryId, decision, fromDevice(device))
      },
      'sessions.answerProjectHooks': ({ sessionId, entryId, decision }, { device }) => {
        sessions.answerProjectHooks(sessionId, entryId, decision, fromDevice(device))
      },
      'sessions.answerReport': ({ sessionId, entryId, outcome }, { device }) =>
        sessions.answerReport(sessionId, entryId, outcome, fromDevice(device)),
      'sessions.answerMemory': ({ sessionId, entryId, decision }, { device }) =>
        memoryCall(() => sessions.answerMemory(sessionId, entryId, decision, fromDevice(device))),
      'sessions.undoMemory': ({ sessionId, entryId }) =>
        memoryCall(() => sessions.undoMemory(sessionId, entryId)),
      'memory.overview': () => memoryCall(() => memory.overview()),
      'memory.list': ({ scope }) => memoryCall(() => memory.list(scope)),
      'memory.save': ({ scope, id, draft }) =>
        memoryCall(async () => (await memory.save(scope, id, draft, BY_USER)).entry),
      'memory.remove': ({ scope, id }) =>
        memoryCall(async () => {
          await memory.remove(scope, id, BY_USER)
        }),
      'memory.moveToGlobal': ({ project, id }) =>
        memoryCall(() => memory.moveToGlobal(project, id)),
      'memory.setEnabled': ({ enabled }) =>
        memoryCall(async () => {
          const was = memory.enabled
          await memory.setEnabled(enabled)
          if (memory.enabled !== was) sessions.memorySwitched()
        }),
      'memory.importScan': () => memoryCall(() => memory.importScan()),
      'memory.import': ({ sources, global }) => memoryCall(() => memory.import(sources, global)),
      'computer.stop': ({ sessionId }) => {
        this.computer?.stop(sessionId)
      },
      'computer.stopElevated': ({ sessionId }) => {
        this.computer?.stopElevated(sessionId)
      },
      // Huli: the elevated helper's install, through Windows' administrator prompt, for someone
      // at this computer.
      'computer.elevatedStatus': async (_params, { device }) => {
        if (device) throw new HostError('forbidden', 'This works only on this computer.')
        return { state: (await this.elevatedInstall?.status()) ?? ('unsupported' as const) }
      },
      // Installing only while the user allows administrator use; removing whatever the setting.
      'computer.installElevated': async (_params, { device }) => {
        if (device) throw new HostError('forbidden', 'This works only on this computer.')
        if (!this.elevatedInstall) return { state: 'unsupported' as const, cancelled: false }
        try {
          return await this.elevatedInstall.install()
        } catch (error) {
          throw new HostError('forbidden', (error as Error).message)
        }
      },
      'computer.uninstallElevated': async (_params, { device }) => {
        if (device) throw new HostError('forbidden', 'This works only on this computer.')
        if (!this.elevatedInstall) return { state: 'unsupported' as const, cancelled: false }
        return this.elevatedInstall.uninstall()
      },
      'computer.takeOver': ({ sessionId }) => {
        this.computer?.takeOver(sessionId)
      },
      'computer.handBack': ({ sessionId }) => {
        this.computer?.handBack(sessionId)
      },
      'computer.show': async ({ sessionId }, { device }) => {
        // The window comes forward on this computer, for someone in front of it.
        if (device) throw new HostError('forbidden', t('hostError.showHere'))
        await this.computer?.show(sessionId)
      },
      'computer.declineSetup': ({ sessionId, entryId }, { device }) => {
        const requestId = sessions.declineComputerSetup(sessionId, entryId, fromDevice(device))
        if (!this.computer?.declineSetup(requestId)) {
          throw new HostError('not_found', t('session.waiting.setup.gone'))
        }
      },
      'agentHistory.list': ({ agentId, cursor, folder, source }) =>
        this.agentHistory.list(agentId, cursor ?? null, folder ?? null, source ?? null),
      'agentHistory.planCopy': ({ agentId, folder, sessionIds }) =>
        this.agentHistory.planCopy(agentId, folder, sessionIds),
      'agentHistory.copy': ({ token }) => this.agentHistory.copy(token),
      'moves.inspect': async ({ sessionId }, ctx) =>
        (await this.sessionMoves(ctx)).inspect(sessionId),
      'moves.pack': async ({ sessionId, moveId, haves, conversationOnly }, ctx) =>
        (await this.sessionMoves(ctx)).pack(sessionId, moveId, haves, conversationOnly === true),
      'moves.part': async ({ moveId, name, offset }, ctx) =>
        (await this.sessionMoves(ctx)).part(moveId, name, offset),
      'moves.finish': async ({ moveId, sessionId, to }, ctx) =>
        (await this.sessionMoves(ctx)).finish(moveId, sessionId, to),
      'moves.abort': async ({ moveId }, ctx) => (await this.sessionMoves(ctx)).abort(moveId),
      'moves.check': async (params, ctx) => (await this.sessionMoves(ctx)).check(params),
      'moves.prepare': async ({ moveId, project, url }, ctx) =>
        (await this.sessionMoves(ctx)).prepare(moveId, project, url),
      'moves.receive': async ({ moveId, name, offset, size, bytes }, ctx) =>
        (await this.sessionMoves(ctx)).receive(moveId, name, offset, size, bytes),
      'moves.apply': async (params, ctx) => (await this.sessionMoves(ctx)).apply(params),
      'moves.undo': async ({ moveId }, ctx) => (await this.sessionMoves(ctx)).undo(moveId),
      'moves.commit': async ({ moveId }, ctx) => (await this.sessionMoves(ctx)).commit(moveId),
      'sessions.clearMoved': ({ sessionId }) => sessions.setMovedTo(sessionId, null),
      // A device never gets to these: the allow-list refuses them to every device's port.
      'agentNetwork.status': () => this.nodeProxy.status(),
      'agentNetwork.addSubscription': ({ name, url }) => this.nodeProxy.addSubscription(name, url),
      'agentNetwork.importSubscription': ({ name, content }) =>
        this.nodeProxy.importSubscription(name, content),
      'agentNetwork.reimportSubscription': ({ id, content }) =>
        this.nodeProxy.reimportSubscription(id, content),
      'agentNetwork.renameSubscription': ({ id, name }) =>
        this.nodeProxy.renameSubscription(id, name),
      'agentNetwork.removeSubscription': ({ id }) => this.nodeProxy.removeSubscription(id),
      'agentNetwork.refresh': ({ id }) => this.nodeProxy.refresh(id),
      'agentNetwork.nodes': async () => ({ nodes: await this.nodeProxy.nodes() }),
      'agentNetwork.testLatency': async ({ nodes }) => ({
        results: await this.nodeProxy.testLatency(nodes),
      }),
      'agentNetwork.exitIp': ({ agentId, fresh }) => this.nodeProxy.exitIp(agentId, fresh),
      'agentNetwork.interfaces': async () => ({ interfaces: await this.nodeProxy.interfaces() }),
      // These two a device may call: they carry no subscription's address.
      'agentNetwork.deviceStatus': () => this.nodeProxy.deviceStatus(),
      'agentNetwork.deviceLatency': async ({ nodes }) => ({
        results: await this.nodeProxy.testLatency(nodes),
      }),
      'folders.list': () => this.sessionFolders.list(),
      'folders.create': ({ name, sessionIds }) => this.sessionFolders.create(name, sessionIds),
      'folders.rename': ({ folderId, name }) => this.sessionFolders.rename(folderId, name),
      'folders.update': ({ folderId, ...change }) => this.sessionFolders.update(folderId, change),
      'folders.delete': ({ folderId }) => this.sessionFolders.delete(folderId),
      'folders.reorder': ({ folderIds }) => this.sessionFolders.reorder(folderIds),
      'folders.move': ({ sessionIds, folderId }) => this.sessionFolders.move(sessionIds, folderId),
      'folders.order': ({ folderId, sessionIds }) =>
        this.sessionFolders.order(folderId, sessionIds),
      'browser.answerOrigin': ({ sessionId, entryId, decision }, { device }) => {
        const { owner, requestId } = sessions.answerOrigin(
          sessionId,
          entryId,
          decision,
          fromDevice(device),
        )
        if (owner === '') {
          this.options.send({ type: 'host:browser-origin-decide', sessionId, requestId, decision })
        } else {
          this.hub.send([owner], { type: 'browser.originDecided', sessionId, requestId, decision })
        }
      },
      'devices.answerAccess': ({ sessionId, entryId, decision }, { device }) => {
        sessions.answerDeviceAccess(sessionId, entryId, decision, fromDevice(device))
      },
      'surfaces.answerAccess': ({ sessionId, entryId, decision }, { device }) => {
        sessions.answerSurfaceAccess(sessionId, entryId, decision, fromDevice(device))
      },
      'terminals.revokeAccess': ({ sessionId, terminalId }) =>
        this.revokeTerminal(sessionId, terminalId),
      'devices.revokeAccess': ({ sessionId, deviceId }) => {
        this.artifactService.revokeDevice(sessionId, deviceId)
        sessions.deviceAccessRevoked(sessionId, deviceId)
      },
      'devices.allowed': async () => {
        await this.deviceAccess.ready
        return { deviceIds: this.deviceAccess.list() }
      },
      'devices.forget': ({ deviceId }) => this.deviceAccess.remove(deviceId),
    }
  }
}

/**
 * Huli: the elevated helper is not installed in Program Files for this Kite, is of another
 * protocol, or changed; only the user installs it, from Settings.
 */
function notInstalled(): ComputerToolError {
  return new ComputerToolError(
    'elevated',
    'The administrator helper is not installed for this Kite, is out of date, or changed. Ask ' +
      'the user to install it again under “Operate programs run as administrator” in Settings › ' +
      'Computer use.',
  )
}
