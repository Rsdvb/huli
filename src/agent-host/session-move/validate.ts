// Huli: the guards of the move methods. The source and the target are each other's peers over an
// encrypted channel, yet each checks what the other sends as any request: ids by their shape,
// paths only where they are the other computer's (never used as paths here), names of the pack's
// files by MOVE_FILE_NAME, sizes against the limits.

import type { HostParams } from '@shared/agent-host'
import { isAgentId } from '@shared/agents'
import type { Platform } from '@shared/platform'
import {
  MOVE_FILE_NAME,
  MOVE_ID,
  MOVE_MAX_BYTES,
  MOVE_MAX_EXTRAS,
  MOVE_MAX_HAVES,
  MOVE_PART_BYTES,
  remoteKey,
  type MoveConversation,
  type MovedTo,
  type MoveGitPack,
  type MovePackFile,
  type MoveRemote,
} from '@shared/session-move'
import { invalidParams } from '../errors'
import { isAbsolutePath } from '../paths'
import type { Validators } from '../rpc'

export type MoveMethod =
  | 'moves.inspect'
  | 'moves.pack'
  | 'moves.part'
  | 'moves.finish'
  | 'moves.abort'
  | 'moves.check'
  | 'moves.prepare'
  | 'moves.receive'
  | 'moves.apply'
  | 'moves.undo'
  | 'moves.commit'
  | 'sessions.clearMoved'

type Fields = Record<string, unknown>

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const SHA256 = /^[0-9a-f]{64}$/
const SESSION_ID = /^[A-Za-z0-9_-]{1,256}$/
const AGENT_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HOST_ID = /^[0-9a-f]{32}$/
const BRANCH_CHARS = 255
const NAME_CHARS = 200
const TITLE_CHARS = 1_000
const PATH_CHARS = 4_096
const URL_CHARS = 2_048
const REMOTES = 32
const PLATFORMS: ReadonlySet<string> = new Set<Platform>([
  'aix',
  'android',
  'cygwin',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'netbsd',
  'openbsd',
  'sunos',
  'win32',
])
const ROLLOUT_FILE = /^rollout-[0-9A-Za-z:.T-]{1,64}-[0-9a-f-]{36}\.jsonl$/i

function fields(value: unknown, key = 'params'): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidParams(`${key} must be an object`)
  }
  return value as Fields
}

function text(o: Fields, key: string, max: number): string {
  const value = o[key]
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    value.includes('\0')
  ) {
    throw invalidParams(`${key} must be text of 1 to ${max} characters`)
  }
  return value
}

function matching(o: Fields, key: string, pattern: RegExp): string {
  const value = o[key]
  if (typeof value !== 'string' || !pattern.test(value)) throw invalidParams(`${key} is malformed`)
  return value
}

function whole(o: Fields, key: string, max: number): number {
  const value = o[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw invalidParams(`${key} must be a whole number from 0 to ${max}`)
  }
  return value
}

/** A branch name as the other computer sends it; git checks it again before it is used. */
function branch(o: Fields, key: string): string | null {
  const value = o[key]
  if (value === null) return null
  const name = text(o, key, BRANCH_CHARS)
  if (name.startsWith('-') || /[\s~^:?*[\\\0]|\.\.|@\{/.test(name)) {
    throw invalidParams(`${key} is not a branch name`)
  }
  return name
}

function remotes(value: unknown): MoveRemote[] {
  if (!Array.isArray(value) || value.length > REMOTES) {
    throw invalidParams(`remotes must be a list of at most ${REMOTES}`)
  }
  return value.map((item, index) => {
    const o = fields(item, `remotes[${index}]`)
    const url = text(o, 'url', URL_CHARS)
    if (remoteKey(url) === null) throw invalidParams(`remotes[${index}] names no repository`)
    return { name: text(o, 'name', NAME_CHARS), url }
  })
}

function movedTo(value: unknown): MovedTo {
  const o = fields(value, 'to')
  const hostId = o.hostId === null ? null : matching(o, 'hostId', HOST_ID)
  const at = o.at
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) throw invalidParams('to.at')
  return {
    hostId,
    name: text(o, 'name', NAME_CHARS),
    sessionId: matching(o, 'sessionId', SESSION_ID),
    at,
  }
}

function packFiles(value: unknown): MovePackFile[] {
  if (!Array.isArray(value) || value.length > MOVE_MAX_EXTRAS + 3) {
    throw invalidParams('files must be a list of the pack’s files')
  }
  let total = 0
  const files = value.map((item, index) => {
    const o = fields(item, `files[${index}]`)
    const file = {
      name: matching(o, 'name', MOVE_FILE_NAME),
      size: whole(o, 'size', MOVE_MAX_BYTES),
      sha256: matching(o, 'sha256', SHA256),
    }
    total += file.size
    return file
  })
  if (total > MOVE_MAX_BYTES) throw invalidParams('The pack is too large')
  if (new Set(files.map((file) => file.name)).size !== files.length) {
    throw invalidParams('files names a file twice')
  }
  return files
}

function gitPack(value: unknown): MoveGitPack {
  const o = fields(value, 'git')
  const wip = o.wip === null ? null : fields(o.wip, 'git.wip')
  if (typeof o.bundled !== 'boolean') throw invalidParams('git.bundled must be true or false')
  return {
    head: matching(o, 'head', OID),
    branch: branch(o, 'branch'),
    upstream: branch(o, 'upstream'),
    wip: wip ? { index: matching(wip, 'index', OID), tree: matching(wip, 'tree', OID) } : null,
    bundled: o.bundled,
  }
}

function conversation(value: unknown): MoveConversation {
  const o = fields(value, 'conversation')
  const kind = o.kind
  if (kind !== 'claude' && kind !== 'codex' && kind !== 'carry') {
    throw invalidParams('conversation.kind is not one')
  }
  const platform = o.platform
  if (typeof platform !== 'string' || !PLATFORMS.has(platform)) {
    throw invalidParams('conversation.platform is not one')
  }
  const cwd = text(o, 'cwd', PATH_CHARS)
  // The source's folder, compared with and replaced in its transcript, never opened here.
  if (!isAbsolutePath(cwd, platform as Platform)) throw invalidParams('conversation.cwd')
  const acpSessionId =
    kind === 'carry' ? '' : matching(o, 'acpSessionId', AGENT_SESSION_ID).toLowerCase()
  if (kind === 'codex') {
    return {
      kind,
      acpSessionId,
      cwd,
      platform: platform as Platform,
      fileName: matching(o, 'fileName', ROLLOUT_FILE),
    }
  }
  return { kind, acpSessionId, cwd, platform: platform as Platform }
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (value instanceof Uint8Array) return value
  throw invalidParams('bytes must be binary')
}

export function moveValidators(platform: Platform): Pick<Validators, MoveMethod> {
  const moveId = (o: Fields): string => matching(o, 'moveId', MOVE_ID)
  const session = (o: Fields): string => matching(o, 'sessionId', SESSION_ID)
  return {
    'moves.inspect': (params) => ({ sessionId: session(fields(params)) }),
    'moves.pack': (params) => {
      const o = fields(params)
      const haves = o.haves
      if (!Array.isArray(haves) || haves.length > MOVE_MAX_HAVES) {
        throw invalidParams(`haves must be a list of at most ${MOVE_MAX_HAVES} commits`)
      }
      return {
        sessionId: session(o),
        moveId: moveId(o),
        haves: haves.map((oid: unknown) => matching({ oid }, 'oid', OID)),
      }
    },
    'moves.part': (params) => {
      const o = fields(params)
      return {
        moveId: moveId(o),
        name: matching(o, 'name', MOVE_FILE_NAME),
        offset: whole(o, 'offset', MOVE_MAX_BYTES),
      }
    },
    'moves.finish': (params) => {
      const o = fields(params)
      return { moveId: moveId(o), sessionId: session(o), to: movedTo(o.to) }
    },
    'moves.abort': (params) => ({ moveId: moveId(fields(params)) }),
    'moves.check': (params) => {
      const o = fields(params)
      const agentId = text(o, 'agentId', NAME_CHARS)
      if (!isAgentId(agentId)) throw invalidParams(`Unknown agent ${agentId}`)
      return {
        agentId,
        remotes: remotes(o.remotes),
        remote: o.remote === null ? null : text(o, 'remote', NAME_CHARS),
      }
    },
    'moves.prepare': (params) => {
      const o = fields(params)
      const project = fields(o.project, 'project')
      let chosen: HostParams<'moves.prepare'>['project']
      if (Object.keys(project).length !== 1) throw invalidParams('project names one project')
      if (project.clone === true) chosen = { clone: true }
      else {
        const folder = text(project, 'path', PATH_CHARS)
        if (!isAbsolutePath(folder, platform)) throw invalidParams('project.path must be absolute')
        chosen = { path: folder }
      }
      const url = text(o, 'url', URL_CHARS)
      if (remoteKey(url) === null) throw invalidParams('url names no repository')
      return { moveId: moveId(o), project: chosen, url }
    },
    'moves.receive': (params) => {
      const o = fields(params)
      const data = bytes(o.bytes)
      if (data.byteLength === 0 || data.byteLength > MOVE_PART_BYTES) {
        throw invalidParams(`bytes must be 1 to ${MOVE_PART_BYTES} bytes`)
      }
      return {
        moveId: moveId(o),
        name: matching(o, 'name', MOVE_FILE_NAME),
        offset: whole(o, 'offset', MOVE_MAX_BYTES),
        size: whole(o, 'size', MOVE_MAX_BYTES),
        bytes: data,
      }
    },
    'moves.apply': (params) => {
      const o = fields(params)
      const agentId = text(o, 'agentId', NAME_CHARS)
      if (!isAgentId(agentId)) throw invalidParams(`Unknown agent ${agentId}`)
      const createdAt = o.createdAt
      if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) {
        throw invalidParams('createdAt must be a time')
      }
      const worktree = o.worktree === null ? null : fields(o.worktree, 'worktree')
      return {
        moveId: moveId(o),
        files: packFiles(o.files),
        git: gitPack(o.git),
        conversation: conversation(o.conversation),
        agentId,
        title: o.title === null ? null : text(o, 'title', TITLE_CHARS),
        createdAt,
        worktree: worktree
          ? {
              base: text(worktree, 'base', BRANCH_CHARS),
              baseOid: matching(worktree, 'baseOid', OID),
            }
          : null,
      }
    },
    'moves.undo': (params) => ({ moveId: moveId(fields(params)) }),
    'moves.commit': (params) => ({ moveId: moveId(fields(params)) }),
    'sessions.clearMoved': (params) => ({ sessionId: session(fields(params)) }),
  }
}
