// Huli: the host's side of moving a session to another computer. As the source it says what the
// session holds and packs it in a staging folder that main reads in parts; as the target it
// clones or finds the project, takes the parts, and applies them, writing down each step it
// takes, so that a failure, an undo main asks for, or a crash found at the next move takes every
// one of them back. Nothing it writes lies outside the move's staging folder, the project's
// worktree root, Kite's clone folder and the agent's own session folders, and only under names
// it makes itself.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants, createReadStream, createWriteStream } from 'node:fs'
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'
import type { AgentStatus, SessionSummary } from '@shared/agent-host'
import { harnessOf, type AgentId } from '@shared/agents'
import type { Platform } from '@shared/platform'
import {
  isClonable,
  MOVE_FILE_NAME,
  MOVE_MAX_BYTES,
  MOVE_MAX_EXTRAS,
  MOVE_PART_BYTES,
  MOVE_STAGING_MS,
  remoteKey,
  repoName,
  withoutCredentials,
  type MoveApply,
  type MoveConversation,
  type MovedTo,
  type MoveNote,
  type MovePack,
  type MovePackFile,
  type MovePrepared,
  type MoveProblem,
  type MoveRemote,
  type MoveSource,
  type MoveTarget,
} from '@shared/session-move'
import { KETTU_HOME_FOLDER } from '@shared/storage'
import type { ThreadEntry } from '@shared/thread'
import { HostError } from '../errors'
import type { Exec } from '../git/exec'
import { findCodexRollout } from '../model-requests/codex'
import { canonicalizePath, folderName, isInside, samePath } from '../paths'
import { claudeProjectFolder, findClaudeTranscript } from '../prompt-cache'
import type { MoveAdoption, MoveFacts } from '../sessions'
import type { LogFn, WorktreeRecord } from '../storage'
import type { StoredBlob } from '../threads/model'
import {
  applyRepo,
  chooseRemote,
  cloneRepo,
  inspectRepo,
  packRepo,
  remotesOf,
  tipsOf,
  undoGitStep,
  type GitStep,
} from './git'
import { rewriteTranscriptFile, rewriteValue, type TranscriptRewrite } from './transcript'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Codex's rollout as the source sends it: never compressed. */
export const ROLLOUT_NAME =
  /^rollout-(\d{4})-(\d{2})-(\d{2})T[0-9-]{1,40}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
/** A segment of a file a Claude Code session keeps in its own folder, as a pack names it. */
const EXTRA_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/
const EXTRA_DEPTH = 4
/** Projects whose remotes are read for a match, at most, a few at a time. */
const MATCHED_PROJECTS = 300
const READS = 8
/** Thread entries a carried session brings, at most. */
const MAX_ENTRIES = 200_000

export interface MoveServiceDeps {
  platform: Platform
  homeDir: string
  /** Where moves stage what they carry, one folder each. */
  folder: string
  exec: Exec
  /** The environment git runs in is resolved. */
  ready(): Promise<void>
  sessions: {
    moveFacts(sessionId: string): MoveFacts
    moveThread(sessionId: string): Promise<{ entries: ThreadEntry[]; blobs: StoredBlob[] }>
    adoptMoved(input: MoveAdoption): Promise<SessionSummary>
    removeAdopted(sessionId: string): Promise<void>
    setMovedTo(sessionId: string, movedTo: MovedTo | null): void
    agentSessionIds(agentId: AgentId): Set<string>
    /** Huli: archives the session, its sub-sessions left in the list with `subSessions` false. */
    archive(sessionId: string, subSessions?: boolean): Promise<void>
  }
  agents: {
    statuses(): AgentStatus[]
    name(agentId: AgentId): string
    /** Claude Code's configuration folder, or Codex's home. */
    configFolder(agentId: AgentId): string | null
  }
  projects: {
    paths(): string[]
    add(folder: string): Promise<unknown>
    remove(folder: string): void
  }
  /** Where a project's worktrees go, made when missing, canonical. */
  worktreeRoot(projectPath: string): Promise<string>
  log: LogFn
  now?(): number
}

/** A step the target took, which its undo takes back. */
type Step =
  | { kind: 'clone'; folder: string }
  | { kind: 'project'; path: string }
  | GitStep
  | { kind: 'file'; path: string }
  /** A folder the move made, taken back once nothing else is in it. */
  | { kind: 'folder'; path: string }
  | { kind: 'session'; id: string }

interface Journal {
  role: 'source' | 'target'
  createdAt: number
  applied: boolean
  steps: Step[]
}

interface Move {
  id: string
  dir: string
  journal: Journal
  /** The source's pack's files, by name; the target's parts so far. */
  files: Map<string, { size: number; written: number }>
  /** The target's project; Huli: `conversationOnly` takes the conversation alone. */
  project: {
    path: string
    cloned: boolean
    remote: string | null
    conversationOnly?: boolean
  } | null
  /** Runs its requests one at a time. */
  chain: Promise<unknown>
}

function moveError(reason: MoveProblem | 'unknownMove', message: string): HostError {
  return new HostError(reason === 'busy' ? 'busy' : 'restricted', message, { reason })
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  )
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** A UUID version 7 for now, as Codex makes its thread ids. */
function uuidV7(now: number): string {
  const bytes = randomBytes(16)
  let ms = now
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256
    ms = Math.floor(ms / 256)
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The files under `folder`, relative with `/`, that a pack can name; at most `limit`. */
async function extraFiles(folder: string, limit: number): Promise<string[]> {
  const found: string[] = []
  const walk = async (relative: string[]): Promise<void> => {
    if (relative.length >= EXTRA_DEPTH) return
    const entries = await readdir(path.join(folder, ...relative), { withFileTypes: true }).catch(
      () => [],
    )
    for (const entry of entries) {
      if (found.length >= limit) return
      if (!EXTRA_SEGMENT.test(entry.name)) continue
      const next = [...relative, entry.name]
      if (entry.isDirectory()) await walk(next)
      else if (entry.isFile()) found.push(next.join('/'))
    }
  }
  await walk([])
  return found
}

export class SessionMoves {
  private readonly moves = new Map<string, Move>()
  private recovered: Promise<void> | null = null

  constructor(private readonly deps: MoveServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private get cloneRoot(): string {
    return path.join(this.deps.homeDir, KETTU_HOME_FOLDER, 'projects')
  }

  // The source's side.

  /** What the session holds and whether it can move now; only reads. */
  async inspect(sessionId: string): Promise<MoveSource> {
    await this.ready()
    const facts = this.deps.sessions.moveFacts(sessionId)
    const problems: MoveProblem[] = [...facts.problems]
    const notes: MoveNote[] = []
    const repo = await inspectRepo(this.deps.exec, facts.cwd).catch(() => ({
      problem: 'noGit' as const,
    }))
    let git: MoveSource['git'] = null
    if ('problem' in repo) {
      if (!problems.includes('noProject')) problems.push(repo.problem)
    } else {
      if (repo.operation) problems.push('operation')
      const remote = chooseRemote(repo.remotes, repo.upstream?.remote ?? null)
      git = {
        remotes: repo.remotes,
        remote: remote?.name ?? null,
        branch: repo.branch,
        head: repo.head,
        upstream: repo.upstream ? `${repo.upstream.remote}/${repo.upstream.branch}` : null,
        changes: repo.changes,
      }
      notes.push('ignoredFiles')
      if (repo.submodules) notes.push('submodules')
      if (repo.lfs) notes.push('lfs')
    }
    const conversation = await this.conversationOf(facts)
    if (conversation.kind === 'carry') notes.push('carry')
    return {
      sessionId,
      title: facts.title,
      agentId: facts.agentId,
      harness: harnessOf(facts.agentId),
      agentName: this.deps.agents.name(facts.agentId),
      platform: this.deps.platform,
      cwd: facts.cwd,
      projectPath: facts.projectPath,
      projectName: folderName(facts.projectPath, this.deps.platform),
      createdAt: facts.createdAt,
      worktree: facts.worktree,
      conversation: conversation.kind,
      git,
      problems,
      notes,
    }
  }

  /** How the session's conversation goes across, and the file it goes from. */
  private async conversationOf(
    facts: MoveFacts,
  ): Promise<{ kind: MoveConversation['kind']; file: string | null }> {
    const harness = harnessOf(facts.agentId)
    // Only a UUID names a transcript or rollout another computer's agent resumes.
    if (facts.carry || !UUID.test(facts.acpSessionId)) return { kind: 'carry', file: null }
    const folder = facts.configDir ?? this.deps.agents.configFolder(facts.agentId)
    if (harness === 'claude-code' && folder) {
      const file = await findClaudeTranscript(
        path.join(folder, 'projects'),
        facts.cwd,
        facts.acpSessionId,
      )
      if (file) return { kind: 'claude', file }
    }
    if (harness === 'codex' && folder) {
      const file = await findCodexRollout(folder, facts.acpSessionId)
      if (file) return { kind: 'codex', file }
    }
    return { kind: 'carry', file: null }
  }

  /**
   * Packs the session for the target, which has `haves`: the Git bundle, and the agent's own
   * transcript or Kite's copy of the thread, each in the move's staging folder.
   */
  async pack(
    sessionId: string,
    moveId: string,
    haves: string[],
    conversationOnly = false,
  ): Promise<MovePack> {
    await this.ready()
    if (this.moves.has(moveId)) throw new HostError('conflict', 'That move is under way already')
    const facts = this.deps.sessions.moveFacts(sessionId)
    if (facts.problems.length > 0) throw moveError(facts.problems[0]!, facts.problems[0]!)
    // Huli: the conversation alone leaves the code, so a worktree with work in it is not left.
    if (conversationOnly && facts.worktree) {
      throw moveError('worktree', 'The session works in a worktree of its repository')
    }
    const repo = conversationOnly ? null : await inspectRepo(this.deps.exec, facts.cwd)
    if (repo && 'problem' in repo) throw moveError(repo.problem, repo.problem)
    if (repo?.operation) throw moveError('operation', 'A merge or rebase is under way')
    const move = await this.begin(moveId, 'source')
    try {
      let git: MovePack['git'] = null
      if (repo) {
        const scratch = path.join(move.dir, 'scratch')
        await mkdir(scratch, { recursive: true })
        git = await packRepo(this.deps.exec, {
          cwd: facts.cwd,
          moveId,
          haves,
          bundle: path.join(move.dir, 'bundle'),
          scratch,
          facts: repo,
        })
        await rm(scratch, { recursive: true, force: true })
      }
      const found = await this.conversationOf(facts)
      const conversation: MoveConversation = {
        kind: found.kind,
        acpSessionId: found.kind === 'carry' ? '' : facts.acpSessionId,
        cwd: facts.cwd,
        platform: this.deps.platform,
      }
      const names = git?.bundled ? ['bundle'] : []
      if (found.kind === 'claude' && found.file) {
        await copyFile(found.file, path.join(move.dir, 'transcript'))
        names.push('transcript')
        const own = path.join(path.dirname(found.file), facts.acpSessionId)
        for (const relative of await extraFiles(own, MOVE_MAX_EXTRAS)) {
          const name = `extra/${relative}`
          if (!MOVE_FILE_NAME.test(name)) continue
          const to = path.join(move.dir, 'extra', ...relative.split('/'))
          await mkdir(path.dirname(to), { recursive: true })
          await copyFile(path.join(own, ...relative.split('/')), to)
          names.push(name)
        }
      } else if (found.kind === 'codex' && found.file) {
        const to = path.join(move.dir, 'transcript')
        if (found.file.endsWith('.zst')) {
          await pipeline(
            createReadStream(found.file),
            createZstdDecompress(),
            createWriteStream(to),
          )
        } else {
          await copyFile(found.file, to)
        }
        names.push('transcript')
        conversation.fileName = path.basename(found.file).replace(/\.zst$/i, '')
      } else {
        const { entries, blobs } = await this.deps.sessions.moveThread(sessionId)
        const thread = {
          entries,
          blobs: blobs.map((blob) => ({
            hash: blob.hash,
            mime: blob.mime,
            data: Buffer.from(blob.data).toString('base64'),
          })),
        }
        await writeFile(path.join(move.dir, 'thread'), JSON.stringify(thread), { mode: 0o600 })
        names.push('thread')
      }
      const files: MovePackFile[] = []
      let total = 0
      for (const name of names) {
        const file = path.join(move.dir, ...name.split('/'))
        const size = (await stat(file)).size
        // An empty file of a session's folder carries nothing; a part is never empty.
        if (size === 0 && name.startsWith('extra/')) continue
        total += size
        if (total > MOVE_MAX_BYTES) throw moveError('tooLarge', 'The session is too large to move')
        files.push({ name, size, sha256: await sha256Of(file) })
        move.files.set(name, { size, written: size })
      }
      return { files, git, conversation }
    } catch (error) {
      await this.drop(move)
      throw error
    }
  }

  /** A part of a packed file, at most MOVE_PART_BYTES from `offset`. */
  async part(moveId: string, name: string, offset: number): Promise<{ bytes: Uint8Array }> {
    const move = this.moveOf(moveId, 'source')
    const file = move.files.get(name)
    if (!file || offset > file.size) throw new HostError('not_found', 'No such part')
    const length = Math.min(MOVE_PART_BYTES, file.size - offset)
    const handle = await open(path.join(move.dir, ...name.split('/')), 'r')
    try {
      const bytes = Buffer.alloc(length)
      const { bytesRead } = await handle.read(bytes, 0, length, offset)
      return { bytes: bytes.subarray(0, bytesRead) }
    } finally {
      await handle.close()
    }
  }

  /** The move went through: the session here says where it went, and the pack goes. */
  async finish(moveId: string, sessionId: string, to: MovedTo): Promise<void> {
    const move = this.moveOf(moveId, 'source')
    const facts = this.deps.sessions.moveFacts(sessionId)
    // A turn that started since the pack would be left behind.
    if (facts.problems.includes('busy')) throw moveError('busy', 'The session started working')
    this.deps.sessions.setMovedTo(sessionId, to)
    // Huli: within one computer the session goes on in the other project's list, so the one it
    // left leaves its own, archived with where it went; its sub-sessions stay.
    if (to.sameComputer) await this.deps.sessions.archive(sessionId, false)
    await this.drop(move)
  }

  /** Gives a move up: what it staged here goes; for the target, everything it did. */
  async abort(moveId: string): Promise<void> {
    const move = this.moves.get(moveId)
    if (!move) return
    if (move.journal.role === 'target') await this.undo(moveId)
    else await this.drop(move)
  }

  // The target's side.

  /** What this computer would do with the session: its agent, and its project or a clone. */
  async check(params: {
    agentId: AgentId
    remotes: MoveRemote[]
    remote: string | null
    project?: string
  }): Promise<MoveTarget> {
    await this.ready()
    if (params.project !== undefined)
      return this.checkProject({ ...params, project: params.project })
    const problems: MoveProblem[] = []
    const version = await this.deps.exec('git', ['--version'], { timeoutMs: 20_000 })
    const hasGit = version.failure === null && version.code === 0
    if (!hasGit) problems.push('gitMissing')
    const agent = this.pickAgent(params.agentId)
    if (!agent) problems.push('agentMissing')
    else if (agent.state === 'off') problems.push('agentOff')
    else if (agent.state === 'notInstalled') problems.push('agentNotInstalled')
    else if (agent.state === 'signedOut') problems.push('signedOut')
    const chosen = params.remotes.find((remote) => remote.name === params.remote) ?? null
    const ordered = chosen ? [chosen, ...params.remotes.filter((r) => r !== chosen)] : []
    const project = hasGit && ordered.length > 0 ? await this.matchProject(ordered) : null
    const clone =
      project === null && chosen && isClonable(chosen.url) && hasGit
        ? await this.cloneTarget(chosen.url)
        : null
    if (!project && !clone && hasGit) problems.push('noRemote')
    return {
      platform: this.deps.platform,
      agent,
      project: project ?? (clone?.kind === 'match' ? clone.match : null),
      clonePath: clone?.kind === 'new' ? clone.folder : null,
      problems,
    }
  }

  /**
   * Huli: the project named for a move within one computer: the same repository moves as to
   * another computer, into a worktree of it; another one, or none, takes the conversation alone.
   */
  private async checkProject(params: {
    agentId: AgentId
    remotes: MoveRemote[]
    project: string
  }): Promise<MoveTarget> {
    const folder = await this.knownProject(params.project)
    const problems: MoveProblem[] = []
    const agent = this.pickAgent(params.agentId)
    if (!agent) problems.push('agentMissing')
    else if (agent.state === 'off') problems.push('agentOff')
    else if (agent.state === 'notInstalled') problems.push('agentNotInstalled')
    else if (agent.state === 'signedOut') problems.push('signedOut')
    const keys = params.remotes.map((remote) => remoteKey(remote.url))
    const own = await remotesOf(this.deps.exec, folder).catch(() => [])
    const remote = own.find((item) => keys.includes(remoteKey(item.url)) && keys.length > 0)
    return {
      platform: this.deps.platform,
      agent,
      project: { path: folder, remote: remote?.name ?? '' },
      clonePath: null,
      problems,
      ...(remote ? {} : { conversationOnly: true }),
    }
  }

  /** Huli: one of this computer's projects by its folder, canonical; refused otherwise. */
  private async knownProject(value: string): Promise<string> {
    const folder = await canonicalizePath(value, this.deps.platform, realpath).catch(() => {
      throw new HostError('not_found', 'No such project here')
    })
    const known = this.deps.projects
      .paths()
      .some((item) => samePath(item, folder, this.deps.platform))
    if (!known) throw new HostError('not_found', 'No such project here')
    return folder
  }

  /** The agent of the session's kind here: the same one, else the kind's own, else any. */
  private pickAgent(agentId: AgentId): MoveTarget['agent'] {
    const harness = harnessOf(agentId)
    const candidates = this.deps.agents
      .statuses()
      .filter((s) => s.harnessId === harness && s.registered !== false && !s.uninstalled)
    const status =
      candidates.find((s) => s.id === agentId) ??
      candidates.find((s) => s.isDefault) ??
      candidates[0]
    if (!status) return null
    const state: NonNullable<MoveTarget['agent']>['state'] = status.disabled
      ? 'off'
      : status.state === 'not-installed' ||
          status.state === 'node-missing' ||
          status.state === 'node-outdated'
        ? 'notInstalled'
        : status.signIn === 'required'
          ? 'signedOut'
          : status.signIn === 'unknown'
            ? 'signInUnknown'
            : 'ready'
    return { agentId: status.id, name: status.name, state }
  }

  /** A project here whose remote is the same repository. */
  private async matchProject(
    remotes: readonly MoveRemote[],
  ): Promise<{ path: string; remote: string } | null> {
    const keys = remotes.map((remote) => remoteKey(remote.url)).filter((key) => key !== null)
    if (keys.length === 0) return null
    const paths = this.deps.projects.paths().slice(0, MATCHED_PROJECTS)
    const found: ({ path: string; remote: string; rank: number } | null)[] = []
    for (let i = 0; i < paths.length; i += READS) {
      const batch = paths.slice(i, i + READS)
      found.push(
        ...(await Promise.all(
          batch.map(async (folder) => {
            const own = await remotesOf(this.deps.exec, folder).catch(() => [])
            for (const remote of own) {
              const rank = keys.indexOf(remoteKey(remote.url) as string)
              if (rank >= 0) return { path: folder, remote: remote.name, rank }
            }
            return null
          }),
        )),
      )
    }
    const best = found.filter((item) => item !== null).sort((a, b) => a.rank - b.rank)[0]
    return best ? { path: best.path, remote: best.remote } : null
  }

  /** Where a clone of `url` goes in Kite's clone folder, or a clone already there. */
  private async cloneTarget(
    url: string,
  ): Promise<
    | { kind: 'new'; folder: string }
    | { kind: 'match'; match: { path: string; remote: string } }
    | null
  > {
    const name = repoName(url) ?? 'project'
    const key = remoteKey(url)
    for (let n = 1; n <= 100; n++) {
      const folder = path.join(this.cloneRoot, n === 1 ? name : `${name}-${n}`)
      if (!(await exists(folder))) return { kind: 'new', folder }
      const remote = (await remotesOf(this.deps.exec, folder).catch(() => [])).find(
        (item) => remoteKey(item.url) === key,
      )
      if (remote) return { kind: 'match', match: { path: folder, remote: remote.name } }
    }
    return null
  }

  /**
   * The move's project here: one of this computer's own whose remote is the repository, or a
   * clone of it made now in Kite's clone folder, with this computer's own sign-in.
   */
  async prepare(
    moveId: string,
    project: { path: string; conversationOnly?: true } | { clone: true },
    url: string | null,
  ): Promise<MovePrepared> {
    await this.ready()
    if (this.moves.has(moveId)) throw new HostError('conflict', 'That move is under way already')
    // Huli: the conversation alone goes into one of this computer's projects as it is.
    if ('path' in project && project.conversationOnly) {
      const folder = await this.knownProject(project.path)
      const move = await this.begin(moveId, 'target')
      move.project = { path: folder, cloned: false, remote: null, conversationOnly: true }
      return { projectPath: folder, cloned: false, haves: [], remote: null }
    }
    if (url === null) throw new HostError('invalid_params', 'url must name a repository')
    const key = remoteKey(url)
    if (key === null || withoutCredentials(url) !== url) {
      throw new HostError('invalid_params', 'url must name a repository without credentials')
    }
    const move = await this.begin(moveId, 'target')
    try {
      let folder: string
      let cloned = false
      let remote: string | null
      if ('path' in project) {
        folder = await canonicalizePath(project.path, this.deps.platform, realpath)
        const known = this.deps.projects
          .paths()
          .some((known) => samePath(known, folder, this.deps.platform))
        if (!known && !isInside(folder, this.cloneRoot, this.deps.platform)) {
          throw new HostError('forbidden', 'The project is not one of this computer’s')
        }
        const own = await remotesOf(this.deps.exec, folder)
        remote = own.find((item) => remoteKey(item.url) === key)?.name ?? null
        if (remote === null) throw new HostError('conflict', 'The project has another remote')
        if (!known) {
          await this.deps.projects.add(folder)
          await this.took(move, { kind: 'project', path: folder })
        }
      } else {
        if (!isClonable(url)) throw moveError('noRemote', 'The remote cannot be cloned here')
        const target = await this.cloneTarget(url)
        if (target?.kind !== 'new') throw new HostError('conflict', 'No free folder to clone into')
        await mkdir(this.cloneRoot, { recursive: true })
        await this.took(move, { kind: 'clone', folder: target.folder })
        await cloneRepo(this.deps.exec, url, target.folder)
        folder = await canonicalizePath(target.folder, this.deps.platform, realpath)
        cloned = true
        remote = 'origin'
        await this.deps.projects.add(folder)
        await this.took(move, { kind: 'project', path: folder })
      }
      move.project = { path: folder, cloned, remote }
      return { projectPath: folder, cloned, haves: await tipsOf(this.deps.exec, folder), remote }
    } catch (error) {
      await this.undo(moveId)
      throw error
    }
  }

  /** A part of a packed file, written after the parts before it. */
  async receive(
    moveId: string,
    name: string,
    offset: number,
    size: number,
    bytes: Uint8Array,
  ): Promise<void> {
    const move = this.moveOf(moveId, 'target')
    return this.serial(move, async () => {
      if (move.journal.applied) throw new HostError('conflict', 'The move was applied already')
      const known = move.files.get(name)
      const total = [...move.files.entries()]
        .filter(([other]) => other !== name)
        .reduce((sum, [, file]) => sum + file.size, 0)
      if (known && known.size !== size) throw new HostError('invalid_params', 'size changed')
      if (total + size > MOVE_MAX_BYTES) throw moveError('tooLarge', 'The pack is too large')
      const written = known?.written ?? 0
      if (offset !== written || offset + bytes.byteLength > size) {
        throw new HostError('invalid_params', 'The part does not follow the one before')
      }
      const file = this.stagedFile(move, name)
      await mkdir(path.dirname(file), { recursive: true })
      const handle = await open(file, offset === 0 ? 'wx' : 'r+', 0o600)
      try {
        await handle.write(bytes, 0, bytes.byteLength, offset)
      } finally {
        await handle.close()
      }
      move.files.set(name, { size, written: written + bytes.byteLength })
    })
  }

  private stagedFile(move: Move, name: string): string {
    if (!MOVE_FILE_NAME.test(name) || name.split('/').some((part) => part === '..')) {
      throw new HostError('invalid_params', 'Not a file of a pack')
    }
    const file = path.join(move.dir, 'files', ...name.split('/'))
    if (!isInside(file, move.dir, this.deps.platform)) {
      throw new HostError('invalid_params', 'Not a file of a pack')
    }
    return file
  }

  /**
   * Makes the session here from the pack: the branch and its worktree (or the clone checked out),
   * the uncommitted changes, the agent's transcript under this folder's name, and the session.
   * A failure takes back every step, the project's clone too.
   */
  async apply(params: MoveApply): Promise<{ sessionId: string; projectPath: string }> {
    await this.ready()
    const move = this.moveOf(params.moveId, 'target')
    return this.serial(move, async () => {
      const project = move.project
      if (!project) throw new HostError('conflict', 'The move has no project yet')
      if (move.journal.applied) throw new HostError('conflict', 'The move was applied already')
      try {
        return await this.applyNow(move, project, params)
      } catch (error) {
        const undone = await this.undoSteps(move)
        if (error instanceof HostError) {
          throw new HostError(error.code, error.message, {
            ...(typeof error.data === 'object' ? error.data : {}),
            undone,
          })
        }
        throw new HostError('internal', (error as Error)?.message ?? String(error), { undone })
      }
    })
  }

  private async applyNow(
    move: Move,
    project: NonNullable<Move['project']>,
    params: MoveApply,
  ): Promise<{ sessionId: string; projectPath: string }> {
    const { platform } = this.deps
    for (const file of params.files) {
      if (file.size === 0 && !move.files.has(file.name)) {
        // No part carries an empty file.
        const empty = this.stagedFile(move, file.name)
        await mkdir(path.dirname(empty), { recursive: true })
        await writeFile(empty, '', { flag: 'wx' })
        move.files.set(file.name, { size: 0, written: 0 })
      }
      const staged = move.files.get(file.name)
      if (!staged || staged.written !== file.size || staged.size !== file.size) {
        throw new HostError('invalid_params', `The pack's ${file.name} did not arrive whole`)
      }
      if ((await sha256Of(this.stagedFile(move, file.name))) !== file.sha256) {
        throw new HostError('invalid_params', `The pack's ${file.name} arrived changed`)
      }
    }
    const has = (name: string): boolean => params.files.some((file) => file.name === name)
    const conversation = params.conversation
    if (conversation.kind !== 'carry' && !has('transcript')) {
      throw new HostError('invalid_params', 'The pack has no transcript')
    }
    if (conversation.kind === 'carry' && !has('thread')) {
      throw new HostError('invalid_params', 'The pack has no thread')
    }
    const resumer = conversation.kind === 'claude' ? 'claude-code' : 'codex'
    if (conversation.kind !== 'carry' && harnessOf(params.agentId) !== resumer) {
      throw new HostError('invalid_params', 'The agent cannot resume that conversation')
    }
    // Huli: the conversation alone, which goes on in the project's own folder.
    if (params.git === null || project.conversationOnly) {
      if (params.git !== null || !project.conversationOnly || has('bundle')) {
        throw new HostError('invalid_params', 'The pack does not match the move')
      }
      const cwd = await canonicalizePath(project.path, platform, realpath)
      const rewrite: TranscriptRewrite = {
        from: { root: conversation.cwd, platform: conversation.platform },
        to: { root: cwd, platform },
      }
      const resume = await this.placeConversation(move, params, cwd, rewrite)
      const summary = await this.deps.sessions.adoptMoved({
        agentId: params.agentId,
        projectPath: project.path,
        worktree: null,
        title: params.title,
        createdAt: params.createdAt,
        resume,
      })
      await this.took(move, { kind: 'session', id: summary.id })
      move.journal.applied = true
      await this.saveJournal(move)
      return { sessionId: summary.id, projectPath: project.path }
    }
    const git = params.git
    // A clone made for a session that worked in the project's folder is that folder.
    const mode =
      params.worktree || !project.cloned
        ? { kind: 'worktree' as const, root: await this.deps.worktreeRoot(project.path) }
        : { kind: 'checkout' as const }
    const applied = await applyRepo(this.deps.exec, {
      project: project.path,
      platform,
      mode,
      bundle: has('bundle') ? this.stagedFile(move, 'bundle') : null,
      pack: git,
      remote: project.remote,
      took: (step) => void this.took(move, step),
    })
    const cwd = await canonicalizePath(applied.cwd, platform, realpath)
    let worktree: WorktreeRecord | null = null
    if (mode.kind === 'worktree') {
      const base = params.worktree ?? (await this.defaultBase(project.path, project.remote))
      worktree = {
        path: cwd,
        branch: applied.branch,
        base: base?.base ?? 'HEAD',
        baseOid: base?.baseOid ?? git.head,
      }
    }
    const rewrite: TranscriptRewrite = {
      from: { root: conversation.cwd, platform: conversation.platform },
      to: { root: cwd, platform },
      ...(git.branch && git.branch !== applied.branch
        ? { branch: { from: git.branch, to: applied.branch } }
        : {}),
    }
    const resume = await this.placeConversation(move, params, cwd, rewrite)
    const summary = await this.deps.sessions.adoptMoved({
      agentId: params.agentId,
      projectPath: project.path,
      worktree,
      title: params.title,
      createdAt: params.createdAt,
      resume,
    })
    await this.took(move, { kind: 'session', id: summary.id })
    move.journal.applied = true
    await this.saveJournal(move)
    return { sessionId: summary.id, projectPath: project.path }
  }

  /** What a worktree made for a session that had none is cut from: the remote's default branch. */
  private async defaultBase(
    project: string,
    remote: string | null,
  ): Promise<{ base: string; baseOid: string } | null> {
    if (remote === null) return null
    const run = (args: string[]) => this.deps.exec('git', args, { cwd: project, timeoutMs: 20_000 })
    const head = await run(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`])
    const base = head.code === 0 ? head.stdout.trim() : ''
    if (base === '') return null
    const oid = await run(['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
    return oid.code === 0 ? { base, baseOid: oid.stdout.trim() } : null
  }

  /** Writes the agent's transcript where it resumes it here; Kite's thread for a carried one. */
  private async placeConversation(
    move: Move,
    params: MoveApply,
    cwd: string,
    rewrite: TranscriptRewrite,
  ): Promise<MoveAdoption['resume']> {
    const { conversation, agentId } = params
    if (conversation.kind === 'carry') {
      const text = await readFile(this.stagedFile(move, 'thread'), 'utf8')
      return this.carried(text, rewrite)
    }
    const home = this.deps.agents.configFolder(agentId)
    if (!home) throw new HostError('agent_unavailable', 'The agent has no folder for its sessions')
    const id = conversation.acpSessionId
    if (!UUID.test(id)) throw new HostError('invalid_params', 'Not a session id')
    const taken = this.deps.sessions.agentSessionIds(agentId).has(id)
    const transcript = this.stagedFile(move, 'transcript')
    if (conversation.kind === 'claude') {
      const projects = path.join(home, 'projects')
      const folder = path.join(projects, claudeProjectFolder(cwd.normalize('NFC')))
      const elsewhere = await findClaudeTranscript(projects, cwd, id)
      const fresh = taken || elsewhere !== null || (await exists(path.join(folder, id)))
      const newId = fresh ? randomUUID() : id
      const full: TranscriptRewrite = {
        ...rewrite,
        ...(newId !== id ? { sessionId: { from: id, to: newId } } : {}),
      }
      await this.makeFolder(move, folder)
      const file = path.join(folder, `${newId}.jsonl`)
      await this.took(move, { kind: 'file', path: file })
      await rewriteTranscriptFile(transcript, file, full)
      const extras = params.files.filter((item) => item.name.startsWith('extra/'))
      if (extras.length > 0) {
        const own = path.join(folder, newId)
        await this.makeFolder(move, own)
        for (const extra of extras) {
          const to = path.join(own, ...extra.name.slice('extra/'.length).split('/'))
          if (!isInside(to, own, this.deps.platform)) continue
          await this.makeFolder(move, path.dirname(to))
          await this.took(move, { kind: 'file', path: to })
          const from = this.stagedFile(move, extra.name)
          if (to.endsWith('.jsonl')) await rewriteTranscriptFile(from, to, full)
          else await copyFile(from, to, constants.COPYFILE_EXCL)
        }
      }
      return { acpSessionId: newId }
    }
    const name = conversation.fileName ?? ''
    const match = ROLLOUT_NAME.exec(name)
    if (!match || match[4]!.toLowerCase() !== id.toLowerCase()) {
      throw new HostError('invalid_params', 'Not a Codex rollout of the session')
    }
    const fresh = taken || (await findCodexRollout(home, id)) !== null
    const newId = fresh ? uuidV7(this.now()) : id
    const fileName = fresh ? name.replace(match[4]!, newId) : name
    const folder = path.join(home, 'sessions', match[1]!, match[2]!, match[3]!)
    await this.makeFolder(move, folder)
    const file = path.join(folder, fileName)
    await this.took(move, { kind: 'file', path: file })
    await rewriteTranscriptFile(transcript, file, {
      ...rewrite,
      ...(newId !== id ? { sessionId: { from: id, to: newId } } : {}),
    })
    return { acpSessionId: newId }
  }

  /** Kite's thread as the source sent it, its paths rewritten. */
  private carried(text: string, rewrite: TranscriptRewrite): MoveAdoption['resume'] {
    const parsed = JSON.parse(text) as { entries?: unknown; blobs?: unknown }
    const entries = parsed.entries
    if (
      !Array.isArray(entries) ||
      entries.length > MAX_ENTRIES ||
      !entries.every(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { id?: unknown }).id === 'string' &&
          typeof (entry as { kind?: unknown }).kind === 'string',
      )
    ) {
      throw new HostError('invalid_params', 'The thread does not read')
    }
    const blobs: StoredBlob[] = (Array.isArray(parsed.blobs) ? parsed.blobs : []).flatMap(
      (blob: unknown) => {
        const item = blob as { hash?: unknown; mime?: unknown; data?: unknown }
        return typeof item.hash === 'string' &&
          /^[0-9a-f]{64}$/.test(item.hash) &&
          typeof item.mime === 'string' &&
          typeof item.data === 'string'
          ? [
              {
                hash: item.hash,
                mime: item.mime,
                data: new Uint8Array(Buffer.from(item.data, 'base64')),
              },
            ]
          : []
      },
    )
    return {
      entries: entries.map((entry) => rewriteValue(entry, rewrite, false) as ThreadEntry),
      blobs,
    }
  }

  /** Makes a folder, writing down the first one it had to make. */
  private async makeFolder(move: Move, folder: string): Promise<void> {
    const missing: string[] = []
    for (let at = folder; !(await exists(at)); at = path.dirname(at)) {
      missing.unshift(at)
      if (path.dirname(at) === at) break
    }
    for (const made of missing) {
      await this.took(move, { kind: 'folder', path: made })
      await mkdir(made).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
    }
  }

  /** Takes back every step the target took for the move, the clone too, and drops its staging. */
  async undo(moveId: string): Promise<{ undone: boolean }> {
    const move = this.moves.get(moveId)
    if (!move) return { undone: true }
    return this.serial(move, async () => {
      const undone = await this.undoSteps(move)
      if (undone) await this.drop(move)
      return { undone }
    })
  }

  private async undoSteps(move: Move): Promise<boolean> {
    let undone = true
    while (move.journal.steps.length > 0) {
      const step = move.journal.steps.at(-1)!
      const done = await this.undoStep(step).catch((error: unknown) => {
        this.deps.log('warn', `A move's ${step.kind} could not be undone: ${String(error)}`)
        return false
      })
      if (!done) undone = false
      move.journal.steps.pop()
      await this.saveJournal(move)
    }
    move.journal.applied = false
    return undone
  }

  private async undoStep(step: Step): Promise<boolean> {
    switch (step.kind) {
      case 'session':
        await this.deps.sessions.removeAdopted(step.id)
        return true
      case 'file':
        await rm(step.path, { force: true })
        return true
      case 'folder':
        // Anything another program wrote in it meanwhile stays, and so does the folder.
        await rmdir(step.path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') {
            throw error
          }
        })
        return true
      case 'project':
        this.deps.projects.remove(step.path)
        return true
      case 'clone':
        // Only Kite's clone folder holds clones a move made.
        if (!isInside(step.folder, this.cloneRoot, this.deps.platform)) return false
        await rm(step.folder, { recursive: true, force: true, maxRetries: 3 })
        return true
      default:
        return undoGitStep(this.deps.exec, step)
    }
  }

  /** Main has the move through: what it did stays, and its staging goes. */
  async commit(moveId: string): Promise<void> {
    const move = this.moveOf(moveId, 'target')
    if (!move.journal.applied) throw new HostError('conflict', 'The move was not applied')
    await this.drop(move)
  }

  // Both sides.

  private moveOf(moveId: string, role: Journal['role']): Move {
    this.sweep()
    const move = this.moves.get(moveId)
    if (!move || move.journal.role !== role) throw moveError('unknownMove', 'No such move here')
    return move
  }

  private async begin(moveId: string, role: Journal['role']): Promise<Move> {
    const dir = path.join(this.deps.folder, moveId)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const move: Move = {
      id: moveId,
      dir,
      journal: { role, createdAt: this.now(), applied: false, steps: [] },
      files: new Map(),
      project: null,
      chain: Promise.resolve(),
    }
    this.moves.set(moveId, move)
    await this.saveJournal(move)
    return move
  }

  private async took(move: Move, step: Step): Promise<void> {
    move.journal.steps.push(step)
    await this.saveJournal(move)
  }

  private async saveJournal(move: Move): Promise<void> {
    if (!this.moves.has(move.id)) return
    await writeFile(path.join(move.dir, 'journal.json'), JSON.stringify(move.journal), {
      mode: 0o600,
    }).catch((error: unknown) =>
      this.deps.log('warn', `Could not write a move's journal: ${String(error)}`),
    )
  }

  private async drop(move: Move): Promise<void> {
    this.moves.delete(move.id)
    await rm(move.dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
  }

  private serial<T>(move: Move, run: () => Promise<T>): Promise<T> {
    const next = move.chain.then(run)
    move.chain = next.catch(() => undefined)
    return next
  }

  /** Gives up moves left too long: a pack or parts go, an apply not yet committed stays. */
  private sweep(): void {
    const cutoff = this.now() - MOVE_STAGING_MS
    for (const move of [...this.moves.values()]) {
      if (move.journal.createdAt > cutoff) continue
      if (move.journal.role === 'target' && !move.journal.applied) void this.undo(move.id)
      else void this.serial(move, () => this.drop(move))
    }
  }

  /**
   * Before the first move of this run: what an earlier run left in the staging folder goes, and a
   * target's steps it never applied are taken back from its journal.
   */
  private ready(): Promise<void> {
    this.recovered ??= (async () => {
      await this.deps.ready()
      const names = await readdir(this.deps.folder).catch(() => [])
      for (const name of names) {
        if (this.moves.has(name)) continue
        const dir = path.join(this.deps.folder, name)
        const journal = await readFile(path.join(dir, 'journal.json'), 'utf8')
          .then((text) => JSON.parse(text) as Journal)
          .catch(() => null)
        if (journal?.role === 'target' && !journal.applied && Array.isArray(journal.steps)) {
          const move: Move = {
            id: name,
            dir,
            journal,
            files: new Map(),
            project: null,
            chain: Promise.resolve(),
          }
          this.moves.set(name, move)
          const undone = await this.undoSteps(move)
          this.moves.delete(name)
          if (!undone) {
            this.deps.log('warn', `A move left by an earlier run could not be fully undone`)
          }
        }
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
      }
    })()
    return this.recovered
  }
}
