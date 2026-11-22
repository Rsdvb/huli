// Huli: Agent sync. It reads the agents' user-level files only when Marketplace › Sync asks, turns
// the page's changes into the exact text each file would get, and writes that text only once the
// page confirms the preview, and only while every file is still as the preview read it: the old
// files are copied into Kite's data first, and each is replaced whole through a file beside it.

import { randomUUID } from 'node:crypto'
import { open, readdir } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import path from 'node:path'
import {
  SYNC_SNIPPET_BODY_CHARS,
  SYNC_SNIPPET_TITLE_CHARS,
  SYNC_ID,
  type AgentSyncState,
  type SyncApplied,
  type SyncChange,
  type SyncFilePreview,
  type SyncFormat,
  type SyncInstructionsPlace,
  type SyncMcpPlace,
  type SyncNote,
  type SyncPreview,
  type SyncProblem,
  type SyncReadProblem,
  type SyncServerView,
  type SyncSkillPlace,
  type SyncSkillView,
  type SyncSnippet,
} from '@shared/agent-sync'
import type { Platform } from '@shared/platform'
import type { AgentId, HarnessId } from '@shared/thread'
import { HostError } from '../errors'
import { t } from '../i18n'
import { frontmatter } from '../marketplace/frontmatter'
import { SKILL_FILE, SKILL_MD_BYTES } from '../marketplace/skill-catalog'
import { JsonFile, type LogFn } from '../storage'
import { diffHunks } from './diff'
import {
  backUp,
  copyFolder,
  existsAt,
  FolderError,
  hashOf,
  listFolder,
  readExact,
  stampOf,
  writeAtomic,
  type FileRead,
  type FolderList,
} from './files'
import { CODECS, containerOf, fingerprint, type NeutralServer } from './formats'
import { JsoncError, parseJsonc, removeMember, setMember } from './jsonc'
import { BlockError, blockBody, blockContent, withBlock } from './managed-block'
import { maskLine, maskValue, namedSecrets, secretsOf, targetOf } from './mask'
import { agentPlaces } from './places'
import { addTomlTable, parseToml, removeTomlTable, TomlError } from './toml'

/** What Agent sync needs to find an agent's files. */
export interface SyncAgentContext {
  agentId: AgentId
  harness: HarnessId
  getEnv(name: string): string | undefined
  chosen: string | null
  /** Whether the agent's program is installed; asked only when its folder is missing. */
  installed(): Promise<boolean>
}

export interface AgentSyncDeps {
  userDataPath: string
  home: string
  platform: Platform
  log: LogFn
  agents(): SyncAgentContext[]
  now?: () => number
}

/** Kite's own part: the snippet library, and what each instructions file was given. */
export interface AgentSyncFile {
  version: 1
  snippets: SyncSnippet[]
  /** By instructions file: the snippets chosen, and the hash of the block body Kite wrote. */
  files: Record<string, { snippetIds: string[]; written: string }>
}

const PLAN_MS = 15 * 60_000
const MAX_PLANS = 8

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function parseAgentSyncFile(data: Record<string, unknown>): AgentSyncFile | string {
  if (!Array.isArray(data.snippets)) return 'snippets is not a list'
  const snippets: SyncSnippet[] = []
  for (const item of data.snippets) {
    if (!isRecord(item)) return 'a snippet is not an object'
    const { id, title, body } = item
    if (typeof id !== 'string' || !SYNC_ID.test(id)) return 'a snippet has no id'
    if (typeof title !== 'string' || title.length > SYNC_SNIPPET_TITLE_CHARS) return 'bad title'
    if (typeof body !== 'string' || body.length > SYNC_SNIPPET_BODY_CHARS) return 'bad body'
    snippets.push({ id, title, body })
  }
  const files: AgentSyncFile['files'] = {}
  if (isRecord(data.files)) {
    for (const [file, entry] of Object.entries(data.files)) {
      if (!isRecord(entry) || !Array.isArray(entry.snippetIds)) continue
      files[file] = {
        snippetIds: entry.snippetIds.filter((id): id is string => typeof id === 'string'),
        written: typeof entry.written === 'string' ? entry.written : '',
      }
    }
  }
  return { version: 1, snippets, files }
}

export function agentSyncFile(userDataPath: string, log: LogFn): JsonFile<AgentSyncFile> {
  return new JsonFile<AgentSyncFile>({
    file: path.join(userDataPath, 'agent-sync.json'),
    version: 1,
    migrations: {},
    parse: parseAgentSyncFile,
    empty: () => ({ version: 1, snippets: [], files: {} }),
    log,
    debounceMs: 100,
  })
}

interface McpDef {
  id: string
  candidates: string[]
  format: SyncFormat
  agentIds: AgentId[]
}

interface SkillDef {
  id: string
  owners: AgentId[]
  readers: AgentId[]
}

interface InstructionsDef {
  candidates: string[]
  fallback: string
  agentIds: AgentId[]
}

interface Places {
  mcp: Map<string, McpDef>
  skills: Map<string, SkillDef>
  instructions: Map<string, InstructionsDef>
}

/** An MCP file as read: its servers' native entries, or why it cannot be read. */
interface McpFile {
  file: string
  read: FileRead
  format: SyncFormat
  root: Record<string, unknown> | null
  entries: [string, unknown][]
  problem: SyncReadProblem | null
  detail: string | null
}

interface PlannedWrite {
  file: string
  stamp: string
  text: string
  mode: number
}

interface PlannedCopy {
  from: string
  to: string
  list: FolderList
}

interface Plan {
  createdAt: number
  writes: PlannedWrite[]
  copies: PlannedCopy[]
  /** The instructions files' new choices, saved once they are written. */
  chosen: { key: string; snippetIds: string[]; written: string }[]
}

function getPath(root: Record<string, unknown>, keys: readonly string[]): unknown {
  let value: unknown = root
  for (const key of keys) {
    if (!isRecord(value)) return undefined
    value = value[key]
  }
  return value
}

/** Equal as data, whatever the order of keys. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b)
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => same(item, b[i]))
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && same(a[key], b[key]))
    )
  }
  return false
}

const clone = <T>(value: T): T => structuredClone(value)

export class AgentSync {
  private readonly file: JsonFile<AgentSyncFile>
  private data: Promise<AgentSyncFile> | null = null
  private readonly plans = new Map<string, Plan>()
  /** Previews and writes run one at a time. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: AgentSyncDeps) {
    this.file = agentSyncFile(deps.userDataPath, deps.log)
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private key(file: string): string {
    const resolved = path.resolve(file)
    return this.deps.platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  private load(): Promise<AgentSyncFile> {
    this.data ??= this.file.load().catch((error: unknown) => {
      this.deps.log('warn', `Could not read agent-sync.json: ${(error as Error).message}`)
      return { version: 1, snippets: [], files: {} } satisfies AgentSyncFile
    })
    return this.data
  }

  private save(next: AgentSyncFile): void {
    this.data = Promise.resolve(next)
    this.file.save(next)
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run)
    this.queue = next.catch(() => undefined)
    return next
  }

  /** The places of the agents turned on that were used or installed here, grouped by path. */
  private async places(): Promise<Places> {
    const { home, platform } = this.deps
    const out: Places = { mcp: new Map(), skills: new Map(), instructions: new Map() }
    const contexts = this.deps.agents()
    const resolved = await Promise.all(
      contexts.map(async (context) => {
        const places = agentPlaces(
          context.harness,
          (name) => context.getEnv(name),
          home,
          platform,
          context.chosen,
        )
        if (!places.mcp && !places.skills && !places.instructions) return null
        const used = places.folder !== null && (await existsAt(places.folder))
        if (!used && !(await context.installed().catch(() => false))) return null
        return { context, places }
      }),
    )
    for (const entry of resolved) {
      if (!entry) continue
      const { context, places } = entry
      const { agentId } = context
      if (places.mcp) {
        const key = this.key(places.mcp.candidates[0]!)
        const def = out.mcp.get(key)
        if (def) def.agentIds.push(agentId)
        else
          out.mcp.set(key, {
            id: places.mcp.candidates[0]!,
            candidates: places.mcp.candidates,
            format: places.mcp.format,
            agentIds: [agentId],
          })
      }
      if (places.skills) {
        for (const [index, dir] of places.skills.reads.entries()) {
          const key = this.key(dir)
          let def = out.skills.get(key)
          if (!def) {
            def = { id: dir, owners: [], readers: [] }
            out.skills.set(key, def)
          }
          const list = index === 0 ? def.owners : def.readers
          if (!list.includes(agentId)) list.push(agentId)
        }
      }
      if (places.instructions) {
        const key = places.instructions.candidates.map((c) => this.key(c)).join('|')
        const def = out.instructions.get(key)
        if (def) def.agentIds.push(agentId)
        else
          out.instructions.set(key, {
            candidates: places.instructions.candidates,
            fallback: places.instructions.fallback,
            agentIds: [agentId],
          })
      }
    }
    return out
  }

  private async firstExisting(candidates: readonly string[], fallback: string): Promise<string> {
    for (const candidate of candidates) if (await existsAt(candidate)) return candidate
    return fallback
  }

  private async readMcp(def: McpDef): Promise<McpFile> {
    const file = await this.firstExisting(def.candidates, def.candidates[0]!)
    const read = await readExact(file)
    const base = { file, read, root: null, entries: [], detail: null }
    if (read.problem) return { ...base, format: def.format, problem: read.problem }
    const codec = CODECS[def.format]
    let root: Record<string, unknown>
    try {
      const value =
        codec.kind === 'toml' ? parseToml(read.text ?? '').value : parseJsonc(read.text ?? '')
      if (!isRecord(value)) throw new JsoncError('not an object', 0)
      root = value
    } catch (error) {
      if (error instanceof JsoncError || error instanceof TomlError) {
        return { ...base, format: def.format, problem: 'parse', detail: error.message }
      }
      throw error
    }
    let format = def.format
    // OpenCode's newer form keeps the servers under mcp.servers, each a table of its own.
    if (format === 'opencode') {
      const servers = getPath(root, ['mcp', 'servers'])
      if (isRecord(servers) && typeof servers.type !== 'string') format = 'opencode-v2'
    }
    const container = getPath(root, containerOf(format))
    const entries = isRecord(container) ? Object.entries(container) : []
    return { file, read, format, root, entries, problem: null, detail: null }
  }

  private view(name: string, server: NeutralServer, extras: string[]): SyncServerView {
    const pairs = (map: Record<string, string>) =>
      Object.entries(map).map(([key, value]) => ({ name: key, value: maskValue(value) }))
    return {
      name,
      transport: server.transport,
      target: targetOf(server),
      env: pairs(server.env),
      headers: pairs(server.headers),
      enabled: server.enabled,
      extras,
      fingerprint: hashOf(fingerprint(server)).slice(0, 16),
    }
  }

  private async mcpPlace(def: McpDef): Promise<SyncMcpPlace> {
    const read = await this.readMcp(def)
    const codec = CODECS[read.format]
    const servers: SyncServerView[] = []
    const unreadable: string[] = []
    for (const [name, entry] of read.entries) {
      const result = codec.read(entry)
      if (result.ok) servers.push(this.view(name, result.server, result.extras))
      else unreadable.push(name)
    }
    return {
      id: def.id,
      path: read.file,
      agentIds: def.agentIds,
      format: read.format,
      exists: read.read.stamp !== 'missing',
      transports: [...codec.transports],
      servers,
      unreadable,
      problem: read.problem,
      detail: read.detail,
    }
  }

  private async skillPlace(def: SkillDef): Promise<SyncSkillPlace> {
    const skills: SyncSkillView[] = []
    let exists = true
    let entries: Dirent[]
    try {
      entries = await readdir(def.id, { withFileTypes: true })
    } catch {
      exists = false
      entries = []
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue
      const text = await readHead(path.join(def.id, entry.name, SKILL_FILE))
      if (text === null) continue
      const fields = frontmatter(text)
      skills.push({
        name: entry.name,
        title: (fields.name ?? entry.name).trim() || entry.name,
        description: (fields.description ?? '').replace(/\s+/g, ' ').trim(),
      })
    }
    skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return { id: def.id, owners: def.owners, readers: def.readers, exists, skills }
  }

  private async instructionsPlace(
    def: InstructionsDef,
    data: AgentSyncFile,
    snippets: Map<string, SyncSnippet>,
  ): Promise<SyncInstructionsPlace> {
    const file = await this.firstExisting(def.candidates, def.fallback)
    const read = await readExact(file)
    const kept = data.files[this.key(file)]
    const snippetIds = (kept?.snippetIds ?? []).filter((id) => snippets.has(id))
    const place: SyncInstructionsPlace = {
      id: file,
      agentIds: def.agentIds,
      exists: read.stamp !== 'missing',
      block: 'none',
      snippetIds,
      problem: read.problem,
    }
    if (read.problem || read.text === null) return place
    let content: string | null
    try {
      content = blockContent(read.text)
    } catch (error) {
      if (error instanceof BlockError) return { ...place, problem: error.code }
      throw error
    }
    if (content === null) return place
    const eol = read.text.includes('\r\n') ? '\r\n' : '\n'
    const wanted = blockBody(
      snippetIds.map((id) => snippets.get(id)!.body),
      eol,
    )
    const block =
      content === wanted
        ? 'synced'
        : kept && hashOf(content.replace(/\r\n/g, '\n')) === kept.written
          ? 'outdated'
          : 'edited'
    return { ...place, block }
  }

  /** Everything the page shows, read now. */
  async read(): Promise<AgentSyncState> {
    const [places, data] = await Promise.all([this.places(), this.load()])
    const snippets = new Map(data.snippets.map((snippet) => [snippet.id, snippet]))
    const [mcp, skills, instructions] = await Promise.all([
      Promise.all([...places.mcp.values()].map((def) => this.mcpPlace(def))),
      Promise.all([...places.skills.values()].map((def) => this.skillPlace(def))),
      Promise.all(
        [...places.instructions.values()].map((def) => this.instructionsPlace(def, data, snippets)),
      ),
    ])
    return {
      home: this.deps.home,
      mcp,
      // A folder that no agent here writes to shows only while it holds skills.
      skills: skills.filter((place) => place.owners.length > 0 || place.skills.length > 0),
      instructions,
      snippets: data.snippets,
    }
  }

  /** Replaces the snippet library, which is Kite's own and written without a preview. */
  async saveSnippets(snippets: SyncSnippet[]): Promise<void> {
    const data = await this.load()
    this.save({ ...data, snippets })
  }

  preview(changes: readonly SyncChange[]): Promise<SyncPreview> {
    return this.serial(() => this.buildPreview(changes))
  }

  apply(id: string): Promise<SyncApplied> {
    return this.serial(() => this.applyPlan(id))
  }

  private async buildPreview(changes: readonly SyncChange[]): Promise<SyncPreview> {
    const [places, data] = await Promise.all([this.places(), this.load()])
    const snippets = new Map(data.snippets.map((snippet) => [snippet.id, snippet]))
    const problems: SyncProblem[] = []
    const fail = (change: SyncChange, code: SyncProblem['code'], detail: string | null = null) => {
      problems.push({ change, code, detail })
    }
    const mcpFiles = new Map<string, McpFile>()
    const readMcp = async (id: string): Promise<{ def: McpDef; file: McpFile } | null> => {
      // A place is named by its first candidate, or by the file of it that exists.
      const def =
        places.mcp.get(this.key(id)) ??
        [...places.mcp.values()].find((item) =>
          item.candidates.some((candidate) => this.key(candidate) === this.key(id)),
        )
      if (!def) return null
      const key = this.key(def.id)
      let file = mcpFiles.get(key)
      if (!file) {
        file = await this.readMcp(def)
        mcpFiles.set(key, file)
      }
      return { def, file }
    }

    // Each MCP file's edits, applied to its text in turn, with the value it must read back as.
    interface McpEdit {
      def: McpDef
      file: McpFile
      text: string
      expected: Record<string, unknown>
      changes: SyncChange[]
      notes: SyncNote[]
      secrets: string[]
    }
    const edits = new Map<string, McpEdit>()
    const editOf = (def: McpDef, file: McpFile): McpEdit => {
      const key = this.key(file.file)
      let edit = edits.get(key)
      if (!edit) {
        edit = {
          def,
          file,
          text: file.read.text ?? '',
          expected: clone(file.root ?? {}),
          changes: [],
          notes: [],
          secrets: [],
        }
        edits.set(key, edit)
      }
      return edit
    }
    // A change stays only when the file reads back as exactly the asked change, so a server
    // written in a form the edit does not take apart leaves the file alone.
    const commit = (
      edit: McpEdit,
      change: SyncChange,
      next: string | null,
      mutate: (expected: Record<string, unknown>) => void,
    ): boolean => {
      const expected = clone(edit.expected)
      mutate(expected)
      let readBack: unknown
      try {
        if (next !== null) {
          readBack =
            CODECS[edit.file.format].kind === 'toml' ? parseToml(next).value : parseJsonc(next)
        }
      } catch {
        readBack = undefined
      }
      if (next === null || !same(readBack, expected)) {
        fail(change, 'unsupported', 'layout')
        return false
      }
      edit.text = next
      edit.expected = expected
      edit.changes.push(change)
      return true
    }
    const copies: PlannedCopy[] = []
    const copyPreviews: SyncFilePreview[] = []
    const instructionWrites: { write: PlannedWrite; preview: SyncFilePreview }[] = []
    const chosen: Plan['chosen'] = []

    for (const change of changes) {
      if (change.kind === 'mcp-add' || change.kind === 'mcp-remove') {
        const targetId = change.kind === 'mcp-add' ? change.to : change.place
        const target = await readMcp(targetId)
        if (!target) {
          fail(change, 'unknown-place')
          continue
        }
        if (target.file.problem) {
          fail(change, 'unreadable', target.file.problem)
          continue
        }
        const edit = editOf(target.def, target.file)
        const container = containerOf(target.file.format)
        const present = isRecord(getPath(edit.expected, container))
          ? Object.prototype.hasOwnProperty.call(getPath(edit.expected, container), change.server)
          : false
        if (change.kind === 'mcp-remove') {
          if (!present) {
            fail(change, 'missing')
            continue
          }
          const entry = (getPath(edit.expected, container) as Record<string, unknown>)[
            change.server
          ]
          const parsed = CODECS[target.file.format].read(entry)
          if (parsed.ok) edit.secrets.push(...secretsOf(parsed.server))
          const removed = editText(() =>
            CODECS[target.file.format].kind === 'toml'
              ? removeTomlTable(edit.text, container[0]!, change.server)
              : removeMember(edit.text, container, change.server),
          )
          commit(edit, change, removed, (expected) => {
            delete (getPath(expected, container) as Record<string, unknown>)[change.server]
          })
          continue
        }
        const source = await readMcp(change.from)
        if (!source) {
          fail(change, 'unknown-place')
          continue
        }
        if (source.file.problem) {
          fail(change, 'unreadable', source.file.problem)
          continue
        }
        const entry = source.file.entries.findLast(([name]) => name === change.server)?.[1]
        if (entry === undefined) {
          fail(change, 'missing')
          continue
        }
        if (present) {
          fail(change, 'exists')
          continue
        }
        const read = CODECS[source.file.format].read(entry)
        if (!read.ok) {
          fail(change, 'unsupported', read.reason)
          continue
        }
        const codec = CODECS[target.file.format]
        if (!codec.transports.includes(read.server.transport)) {
          fail(change, 'transport', read.server.transport)
          continue
        }
        const sameFormat = source.file.format === target.file.format
        const native = sameFormat
          ? (clone(entry) as Record<string, unknown>)
          : codec.write(read.server)
        const notes: SyncNote[] = []
        if (!sameFormat) {
          notes.push({
            kind: 'converted',
            server: change.server,
            from: source.file.format,
            to: target.file.format,
            dropped: [...new Set([...read.extras, ...codec.loses(read.server)])],
          })
        }
        const added = editText(() =>
          codec.kind === 'toml'
            ? addTomlTable(edit.text, container[0]!, change.server, native)
            : setMember(edit.text, container, change.server, native),
        )
        const done = commit(edit, change, added, (expected) => {
          let holder = expected
          for (const step of container) {
            if (!isRecord(holder[step])) holder[step] = {}
            holder = holder[step] as Record<string, unknown>
          }
          holder[change.server] = clone(native)
        })
        if (done) {
          edit.secrets.push(...secretsOf(read.server))
          edit.notes.push(...notes)
        }
        continue
      }

      if (change.kind === 'skill-copy') {
        const from = places.skills.get(this.key(change.from))
        const to = places.skills.get(this.key(change.to))
        if (!from || !to) {
          fail(change, 'unknown-place')
          continue
        }
        const source = path.join(from.id, change.skill)
        const target = path.join(to.id, change.skill)
        if ((await readHead(path.join(source, SKILL_FILE))) === null) {
          fail(change, 'missing')
          continue
        }
        if (await existsAt(target)) {
          fail(change, 'exists')
          continue
        }
        let list: FolderList
        try {
          list = await listFolder(source)
        } catch (error) {
          if (error instanceof FolderError) {
            fail(change, error.code === 'link' ? 'skill-link' : 'skill-too-large', error.detail)
            continue
          }
          throw error
        }
        copies.push({ from: source, to: target, list })
        copyPreviews.push({
          path: target,
          agentIds: [...to.owners, ...to.readers],
          action: 'copy',
          hunks: [],
          notes: [],
          files: list.files.length,
          bytes: list.bytes,
        })
        continue
      }

      const def = [...places.instructions.values()].find(
        (item) =>
          item.candidates.some((c) => this.key(c) === this.key(change.place)) ||
          this.key(item.fallback) === this.key(change.place),
      )
      if (!def) {
        fail(change, 'unknown-place')
        continue
      }
      const file = await this.firstExisting(def.candidates, def.fallback)
      const read = await readExact(file)
      if (read.problem) {
        fail(change, 'unreadable', read.problem)
        continue
      }
      const ids = change.snippetIds.filter((id) => snippets.has(id))
      const bodies = ids.map((id) => snippets.get(id)!.body)
      const before = read.text ?? ''
      let after: string
      let current: string | null
      try {
        current = blockContent(before)
        after = withBlock(before, bodies)
      } catch (error) {
        if (error instanceof BlockError) {
          fail(change, 'unreadable', error.code)
          continue
        }
        throw error
      }
      const eol = before.includes('\r\n') ? '\r\n' : '\n'
      const written = hashOf(blockBody(bodies, '\n'))
      chosen.push({ key: this.key(file), snippetIds: ids, written })
      if (after === before) continue
      const kept = data.files[this.key(file)]
      const notes: SyncNote[] = []
      if (read.text === null) notes.push({ kind: 'new-file' })
      if (
        current !== null &&
        (!kept || hashOf(current.replace(/\r\n/g, '\n')) !== kept.written) &&
        current !== blockBody(bodies, eol)
      ) {
        notes.push({ kind: 'outside-edit' })
      }
      instructionWrites.push({
        write: { file, stamp: read.stamp, text: after, mode: 0o644 },
        preview: {
          path: file,
          agentIds: def.agentIds,
          action: read.text === null ? 'create' : 'edit',
          hunks: diffHunks(before, after),
          notes,
          files: 0,
          bytes: 0,
        },
      })
    }

    const writes: PlannedWrite[] = []
    const previews: SyncFilePreview[] = []
    for (const edit of edits.values()) {
      const { file } = edit
      const before = file.read.text ?? ''
      if (edit.changes.length === 0 || edit.text === before) continue
      const secrets = [
        ...edit.secrets,
        ...file.entries.flatMap(([, entry]) => {
          const read = CODECS[file.format].read(entry)
          return read.ok ? secretsOf(read.server) : []
        }),
        ...namedSecrets(Object.entries(file.root ?? {})),
      ]
      const hunks = diffHunks(before, edit.text).map((hunk) => ({
        ...hunk,
        lines: hunk.lines.map((line) => ({ ...line, text: maskLine(line.text, secrets) })),
      }))
      writes.push({ file: file.file, stamp: file.read.stamp, text: edit.text, mode: 0o600 })
      previews.push({
        path: file.file,
        agentIds: edit.def.agentIds,
        action: file.read.text === null || file.read.stamp === 'missing' ? 'create' : 'edit',
        hunks,
        notes: [
          ...(file.read.stamp === 'missing' ? [{ kind: 'new-file' } as const] : []),
          ...edit.notes,
        ],
        files: 0,
        bytes: 0,
      })
    }
    for (const item of instructionWrites) {
      writes.push(item.write)
      previews.push(item.preview)
    }

    const now = this.now()
    for (const [planId, plan] of this.plans) {
      if (now - plan.createdAt > PLAN_MS) this.plans.delete(planId)
    }
    while (this.plans.size >= MAX_PLANS) this.plans.delete(this.plans.keys().next().value!)
    const id = randomUUID()
    if (writes.length + copies.length > 0 || chosen.length > 0) {
      this.plans.set(id, { createdAt: now, writes, copies, chosen })
    }
    return { id, files: [...previews, ...copyPreviews], problems }
  }

  private async applyPlan(id: string): Promise<SyncApplied> {
    const plan = this.plans.get(id)
    this.plans.delete(id)
    if (!plan || this.now() - plan.createdAt > PLAN_MS) {
      throw new HostError('invalid_params', t('agentSync.expired'))
    }
    const changed: string[] = []
    for (const write of plan.writes) {
      if ((await stampOf(write.file)) !== write.stamp) changed.push(write.file)
    }
    for (const copy of plan.copies) {
      const now = await listFolder(copy.from).catch(() => null)
      if (now?.stamp !== copy.list.stamp || (await existsAt(copy.to))) changed.push(copy.to)
    }
    if (changed.length > 0) {
      return { ok: false, changed, written: [], backup: null, failed: null }
    }
    const existing = plan.writes.filter((write) => write.stamp !== 'missing').map((w) => w.file)
    const backup =
      existing.length > 0
        ? (
            await backUp(
              path.join(this.deps.userDataPath, 'agent-sync', 'backups'),
              existing,
              this.now(),
            )
          ).dir
        : null
    const written: string[] = []
    let failed: SyncApplied['failed'] = null
    for (const write of plan.writes) {
      try {
        await writeAtomic(write.file, write.text, write.mode)
        written.push(write.file)
      } catch (error) {
        failed = { path: write.file, message: (error as Error).message }
        break
      }
    }
    if (!failed) {
      for (const copy of plan.copies) {
        try {
          await copyFolder(copy.from, copy.to, copy.list)
          written.push(copy.to)
        } catch (error) {
          failed = { path: copy.to, message: (error as Error).message }
          break
        }
      }
    }
    const writtenKeys = new Set(written.map((file) => this.key(file)))
    const done = plan.chosen.filter(
      (item) =>
        writtenKeys.has(item.key) || !plan.writes.some((w) => this.key(w.file) === item.key),
    )
    if (done.length > 0) {
      const data = await this.load()
      const files = { ...data.files }
      for (const item of done)
        files[item.key] = { snippetIds: item.snippetIds, written: item.written }
      this.save({ ...data, files })
    }
    this.deps.log(
      'info',
      `Agent sync wrote ${written.length} of ${plan.writes.length + plan.copies.length}`,
    )
    return { ok: true, changed: [], written, backup, failed }
  }
}

/** The edit's text, or null when the file's layout keeps it from being made. */
function editText(edit: () => string): string | null {
  try {
    return edit()
  } catch (error) {
    if (error instanceof JsoncError || error instanceof TomlError) return null
    throw error
  }
}

/** The start of a SKILL.md, enough for its frontmatter; null when there is no such file. */
async function readHead(file: string): Promise<string | null> {
  let handle
  try {
    handle = await open(file, 'r')
    if (!(await handle.stat()).isFile()) return null
    const buffer = Buffer.alloc(SKILL_MD_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, SKILL_MD_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}
