// What the conversation's work says, as the desktop words it: a tool call's verb and target, a run
// of steps summed up in one line ("读取了 a.ts 及另外 2 个文件 · 运行了 5 条命令"), a thought's
// heading, how a tool's text result reads, the running turn's phase, and the times and token
// counts the rows show. Ported from the desktop's entries/helpers.ts, tool-call-model.ts,
// read-code.ts, turn-phase.ts and tool-times.ts.

import {
  isDiffContentItem,
  toolContentItems,
  type DiffContentItem,
  type ThreadEntry,
  type ThreadState,
  type ToolContent,
  type ToolEntry,
  type ToolKind,
} from '@shared/thread'
import { turnDoing, type TurnDoing, type TurnPhaseName } from '@shared/turn-phase'

export { writingId } from '@shared/turn-phase'
import { diffTexts } from '../../diff'
import { baseName, durationText, relativePath } from './format'
import { toolTitle } from './toolNames'

type FileKind = 'read' | 'edit' | 'delete' | 'move'

const FILE_KINDS: Partial<Record<ToolKind, FileKind>> = {
  read: 'read',
  edit: 'edit',
  delete: 'delete',
  move: 'move',
}

const VERB: Record<FileKind | 'run', string> = {
  read: '读取',
  edit: '编辑',
  delete: '删除',
  move: '移动',
  run: '运行',
}

const VERB_DONE: Record<FileKind | 'run', string> = {
  read: '读取了',
  edit: '编辑了',
  delete: '删除了',
  move: '移动了',
  run: '运行了',
}

export interface ToolLabel {
  verb: string | null
  target: string | null
  kind: 'path' | 'command' | 'title'
}

/**
 * What a call's line names: a verb with a path or command, or the agent's own title. A finished
 * call's verb is in the past tense ("编辑了", "运行了").
 */
export function toolLabel(
  entry: Pick<ToolEntry, 'toolKind' | 'title' | 'locations' | 'rawInput'>,
  root: string | null,
  done = false,
): ToolLabel {
  const verbs = done ? VERB_DONE : VERB
  const fileKind = FILE_KINDS[entry.toolKind]
  const location = entry.locations[0]?.path
  if (fileKind && location) {
    return { verb: verbs[fileKind], target: relativePath(location, root), kind: 'path' }
  }
  if (entry.toolKind === 'execute') {
    // Without the input, the title is the agent's own label and may already say "Run".
    const target = entry.rawInput ?? entry.title.replace(/^run\s+/i, '')
    return { verb: verbs.run, target, kind: 'command' }
  }
  return { verb: null, target: toolTitle(entry.title), kind: 'title' }
}

const FENCED = /^(`{3,})[^\n`]*\n([\s\S]*?)\n?\1$/

/**
 * What a command printed, when its result is one fenced block of text, as agents send a shell's
 * output; null for anything else, which shows as Markdown.
 */
export function commandOutput(content: readonly ToolContent[]): string | null {
  const first = content[0]
  if (first?.type !== 'markdown') return null
  const match = FENCED.exec(first.markdown.trim())
  if (!match) return null
  const [, fence, body] = match
  if (body!.split('\n').some((line) => line.trimStart().startsWith(fence!))) return null
  return body!
}

const FENCE = /^(`{3,})[^\n]*\n([\s\S]*?)\n?\1\s*$/
// Claude Code numbers each line of a file it reads: the number, then a tab or an arrow.
const NUMBERED = /^\s*(\d+)(?:\t|→)(.*)$/

/** The text inside a result that is one fenced block, else the result as it is. */
export function fenceBody(markdown: string): string {
  return FENCE.exec(markdown.trim())?.[2] ?? markdown
}

/**
 * A file read whose result numbers every line, as one block in the file's language that numbers
 * its lines itself from the first one read. Null when the result is not one such block.
 */
export function numberedRead(markdown: string, path: string | undefined): string | null {
  const body = FENCE.exec(markdown.trim())?.[2]
  if (body === undefined) return null
  let start = 0
  const code: string[] = []
  for (const [i, line] of body.split('\n').entries()) {
    const match = NUMBERED.exec(line)
    if (!match) return null
    const n = Number(match[1])
    if (i === 0) start = n
    else if (n !== start + i) return null
    code.push(match[2]!)
  }
  const name = path ? baseName(path) : ''
  const language = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  let fence = '```'
  for (const [run] of code.join('\n').matchAll(/`{3,}/g)) {
    while (run.length >= fence.length) fence += '`'
  }
  return `${fence}${language} startLine=${start}\n${code.join('\n')}\n${fence}`
}

// Huli: an edit's diff, or the counts a lean page holds of a large one.
type Diff = DiffContentItem

/** Huli: whether an edit made its file, from its diff or a lean page's digest of it. */
export function madeFile(diff: Diff): boolean {
  return diff.type === 'diff' ? diff.oldText === null : diff.created === true
}

/** A step of a folded run, as its summary counts it. */
export type RunStep =
  | { kind: 'thought'; durationMs?: number; streaming?: boolean }
  | { kind: 'memory' }
  | {
      kind: 'tool'
      toolKind: ToolKind
      status: ToolEntry['status']
      paths: string[]
      diffs?: Diff[]
      description?: string
      label?: string
    }

export function toolStep(entry: ToolEntry): RunStep {
  const base = { kind: 'tool' as const, toolKind: entry.toolKind, status: entry.status }
  const description = {
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.label !== undefined ? { label: entry.label } : {}),
  }
  if (entry.toolKind !== 'edit') {
    const first = entry.locations[0]?.path
    return { ...base, paths: first !== undefined ? [first] : [], ...description }
  }
  const diffs = toolContentItems(entry).filter(isDiffContentItem)
  const paths = diffs.length > 0 ? diffs.map((d) => d.path) : entry.locations.map((l) => l.path)
  return { ...base, paths: [...new Set(paths)], diffs, ...description }
}

export function stepOf(entry: ThreadEntry): RunStep | null {
  if (entry.kind === 'thought') {
    return { kind: 'thought', durationMs: entry.durationMs, streaming: entry.streaming }
  }
  if (entry.kind === 'tool') return toolStep(entry)
  if (entry.kind === 'memory') return { kind: 'memory' }
  return null
}

export interface SummaryPart {
  text: string
  kind?: RunPart
  diffs?: Diff[]
}

type FilePart = 'read' | 'create' | 'edit' | 'delete' | 'move'
type RunPart = FilePart | 'thought' | 'plan' | 'memory' | 'execute' | 'search' | 'fetch' | 'other'

interface Unit {
  part: RunPart
  step: RunStep
  path?: string
  diffs?: Diff[]
}

function unitsOf(step: RunStep, created: Set<string>): Unit[] {
  if (step.kind !== 'tool') return [{ part: step.kind, step }]
  switch (step.toolKind) {
    case 'edit':
      if (step.paths.length === 0) return [{ part: 'edit', step, diffs: step.diffs ?? [] }]
      return step.paths.map((path) => ({
        part: created.has(path) ? 'create' : 'edit',
        step,
        path,
        diffs: step.diffs?.filter((d) => d.path === path) ?? [],
      }))
    case 'read':
    case 'delete':
    case 'move':
      return [{ part: step.toolKind, step, ...(step.paths[0] ? { path: step.paths[0] } : {}) }]
    case 'execute':
    case 'search':
    case 'fetch':
      return [{ part: step.toolKind, step }]
    default:
      return [{ part: 'other', step }]
  }
}

/** The folders a path sits in, outermost first, for either separator. */
function parentsOf(path: string): string[] {
  return path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]+/)
    .slice(0, -1)
    .filter(Boolean)
}

/** The fewest trailing parent folders that tell paths with the same name apart. */
function nameHints(paths: readonly string[]): Map<string, string> {
  const byName = new Map<string, string[]>()
  for (const path of paths) {
    const name = baseName(path)
    byName.set(name, [...(byName.get(name) ?? []), path])
  }
  const hints = new Map<string, string>()
  for (const group of byName.values()) {
    if (group.length < 2) continue
    const parents = group.map(parentsOf)
    const deepest = Math.max(...parents.map((p) => p.length))
    for (let depth = 1; depth <= deepest; depth++) {
      const tails = parents.map((p) => p.slice(-depth).join('/'))
      if (depth < deepest && new Set(tails).size < tails.length) continue
      group.forEach((path, i) => {
        if (tails[i]) hints.set(path, tails[i])
      })
      break
    }
  }
  return hints
}

const FILE_COUNT: Record<FilePart, string> = {
  read: '读取了 {count} 个文件',
  create: '创建了 {count} 个文件',
  edit: '编辑了 {count} 个文件',
  delete: '删除了 {count} 个文件',
  move: '移动了 {count} 个文件',
}

function filesText(part: FilePart, paths: (string | undefined)[]): SummaryPart {
  const known = [...new Set(paths.filter((p): p is string => p !== undefined))]
  const files = known.length + paths.filter((p) => p === undefined).length
  if (known.length === 0) return { text: FILE_COUNT[part].replace('{count}', String(files)) }
  const shown = known.slice(0, 2)
  const hints = nameHints(shown)
  const names = shown
    .map((path) => {
      const hint = hints.get(path)
      return hint ? `${hint}/${baseName(path)}` : baseName(path)
    })
    .join('、')
  const more = files - shown.length
  const done = part === 'create' ? '创建了' : VERB_DONE[part]
  const text = more === 0 ? `${done} ${names}` : `${done} ${names} 及另外 ${more} 个文件`
  return { text }
}

function partsOf(part: RunPart, units: Unit[]): Omit<SummaryPart, 'kind'>[] {
  const n = units.length
  switch (part) {
    case 'thought': {
      const ms = units.reduce(
        (sum, u) => sum + (u.step.kind === 'thought' ? (u.step.durationMs ?? 0) : 0),
        0,
      )
      return [{ text: ms >= 1000 ? `思考了 ${durationText(ms)}` : '思考' }]
    }
    case 'plan':
      return [{ text: '更新了计划' }]
    case 'memory':
      return [{ text: `更新了 ${n} 次记忆` }]
    case 'execute': {
      const only = units[0]?.step
      const description = n === 1 && only?.kind === 'tool' ? only.description : undefined
      return [{ text: description ?? `运行了 ${n} 条命令` }]
    }
    case 'search':
      return [{ text: `搜索了 ${n} 次` }]
    case 'fetch':
      return [{ text: `获取了 ${n} 个网页` }]
    case 'other':
      return [{ text: `使用了 ${n} 个工具` }]
    default: {
      const files = filesText(
        part,
        units.map((u) => u.path),
      )
      if (part !== 'create' && part !== 'edit') return [files]
      return [{ ...files, diffs: units.flatMap((u) => u.diffs ?? []) }]
    }
  }
}

/**
 * A folded run's summary: one part per kind in the order it first appears; a lone command is
 * named by its description. Thoughts name a part only in a run of nothing else.
 */
export function runSummary(steps: RunStep[]): {
  parts: SummaryPart[]
  failed: number
  running: boolean
} {
  const created = new Set<string>()
  for (const step of steps) {
    if (step.kind !== 'tool') continue
    for (const diff of step.diffs ?? []) if (madeFile(diff)) created.add(diff.path)
  }
  const byPart = new Map<RunPart, Unit[]>()
  for (const unit of steps.flatMap((step) => unitsOf(step, created))) {
    byPart.set(unit.part, [...(byPart.get(unit.part) ?? []), unit])
  }
  const named = byPart.size > 1 ? [...byPart].filter(([part]) => part !== 'thought') : [...byPart]
  const parts = named.flatMap(([part, units]): SummaryPart[] =>
    partsOf(part, units).map((text) => ({ ...text, kind: part })),
  )
  return {
    parts,
    failed: steps.filter((s) => s.kind === 'tool' && s.status === 'failed').length,
    running: steps.some((s) => {
      if (s.kind === 'memory') return false
      if (s.kind === 'thought') return !!s.streaming
      return s.status === 'pending' || s.status === 'in_progress'
    }),
  }
}

/** The names an agent gave the work of a run's tool calls, each once, in order. */
export function runLabels(steps: RunStep[]): string[] {
  const labels = new Set<string>()
  for (const step of steps) if (step.kind === 'tool' && step.label) labels.add(step.label)
  return [...labels]
}

/** A thought's heading: its leading bold text, else its first sentence, as plain text. */
export function thoughtTitle(markdown: string): string | null {
  const text = markdown.trim()
  const bold = /^(?:\*\*|__)(.+?)(?:\*\*|__)/.exec(text)
  let first = bold?.[1]
  if (first === undefined) {
    const line = text.split('\n', 1)[0]!
    const end = line.search(/[.!?。！？]/)
    first = end < 0 ? line : line.slice(0, end + 1)
  }
  const title = first.replace(/[*_`#>]/g, '').trim()
  return title === '' ? null : title
}

/** Lines added and removed by an edit's diffs, counted once per diff. */
const statsKept = new WeakMap<Diff, { insertions: number; deletions: number }>()

export function diffStats(diffs: readonly Diff[]): { insertions: number; deletions: number } {
  let insertions = 0
  let deletions = 0
  for (const diff of diffs) {
    let known = statsKept.get(diff)
    if (!known) {
      if (diff.type === 'digest') {
        known = { insertions: diff.added ?? 0, deletions: diff.removed ?? 0 }
      } else {
        const made = diffTexts(diff.oldText, diff.newText)
        known = { insertions: made.insertions, deletions: made.deletions }
      }
      statsKept.set(diff, known)
    }
    insertions += known.insertions
    deletions += known.deletions
  }
  return { insertions, deletions }
}

// ---- Times and counts ----

export { durationText }

/** A step's time, as every duration reads: 「0.4 秒」「12.3 秒」「2 分 5 秒」. */
export function formatMs(ms: number): string {
  return durationText(Math.max(ms, 100), true)
}

/** A count as Chinese shortens it: "980", "4.1万", "1.2亿". */
export function compactCount(n: number): string {
  const trim = (value: number) => {
    const text = value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
    return text.replace(/\.0$/, '')
  }
  if (n < 10_000) return String(Math.round(n))
  if (n < 100_000_000) return `${trim(n / 10_000)}万`
  return `${trim(n / 100_000_000)}亿`
}

// ---- When each tool call ran ----

// When this phone saw each tool call start and finish. The thread carries no times for tool
// calls, so a call already running or done when its session first loaded has none, and its row
// shows no time rather than a guess.

interface Seen {
  running: boolean
  start?: number
  end?: number
}

const bySession = new Map<string, { state: ThreadState; tools: Map<string, Seen> }>()

// The times of calls that finished while their session was shown, kept when it is left, so they
// show again on its next visit. A call still running then is let go: it ended out of sight, so
// its time is not known. The sessions left longest ago go first.
const left = new Map<string, Map<string, Seen>>()
const LEFT_KEPT = 20

// Statuses change near the thread's end, so a patch is read no further back.
const LOOKBACK = 64

const isRunning = (entry: ToolEntry) =>
  (entry.status === 'pending' || entry.status === 'in_progress') && !entry.permission

/** Notes which tool calls of `state` started or finished since the last state seen. */
export function observeTools(sessionId: string, state: ThreadState): void {
  const known = bySession.get(sessionId)
  if (known?.state === state) return
  const tools = known?.tools ?? left.get(sessionId) ?? new Map<string, Seen>()
  left.delete(sessionId)
  const { order, byId } = state
  const from = known ? Math.max(0, order.length - LOOKBACK) : 0
  const now = Date.now()
  for (let i = from; i < order.length; i++) {
    const entry = byId[order[i]!]
    if (entry?.kind !== 'tool') continue
    const seen = tools.get(entry.id)
    const running = isRunning(entry)
    if (!known) {
      if (!seen) tools.set(entry.id, { running })
      continue
    }
    if (!seen) {
      tools.set(entry.id, running ? { running, start: now } : { running })
      continue
    }
    if (seen.running === running) continue
    if (running && seen.start === undefined) seen.start = now
    if (!running && seen.start !== undefined) seen.end = now
    seen.running = running
  }
  bySession.set(sessionId, { state, tools })
}

/**
 * Leaves a session the phone no longer shows: it starts over as if loaded first, keeping the
 * times of the calls it saw finish.
 */
export function forgetTools(sessionId: string): void {
  const known = bySession.get(sessionId)
  bySession.delete(sessionId)
  if (!known) return
  const finished = new Map<string, Seen>()
  for (const [id, seen] of known.tools) {
    if (seen.start !== undefined && seen.end !== undefined) finished.set(id, seen)
  }
  if (finished.size === 0) return
  left.delete(sessionId)
  left.set(sessionId, finished)
  if (left.size > LEFT_KEPT) left.delete(left.keys().next().value!)
}

/** When a tool call started and how long it took, as far as this phone saw it. */
export function toolTime(
  sessionId: string,
  entryId: string,
): { startedAt?: number; durationMs?: number } {
  const seen = bySession.get(sessionId)?.tools.get(entryId)
  if (seen?.start === undefined) return {}
  return seen.end === undefined
    ? { startedAt: seen.start }
    : { startedAt: seen.start, durationMs: seen.end - seen.start }
}

// ---- The running turn ----

export type Phase = TurnPhaseName

/** What the agent does now in its running turn, with what it works on (`turnDoing`). */
export { turnDoing }

export function phaseText(phase: Phase, count: number): string {
  switch (phase) {
    case 'thinking':
      return '正在思考'
    case 'execute':
      return `正在运行 ${count} 条命令`
    case 'read':
      return `正在读取 ${count} 个文件`
    case 'search':
      return '正在搜索'
    case 'fetch':
      return `正在获取 ${count} 个网页`
    case 'edit':
      return `正在编辑 ${count} 个文件`
    case 'writing':
      return '正在回复'
    case 'compacting':
      return '正在压缩上下文'
    case 'approval':
      return '等待你的授权'
    case 'working':
      return '处理中'
  }
}

/**
 * The phase as a person says it, with what it works on: 「正在读取 index.tsx」, 「正在运行 3 条命令：
 * ssh mac」, 「正在搜索“tok/s”」, 「正在思考：额度为什么查不到」; the phase alone when there is
 * nothing to name.
 */
export function doingText(doing: TurnDoing): string {
  const { phase, count, detail, quoted } = doing
  if (detail === null) return phaseText(phase, count)
  switch (phase) {
    case 'thinking':
      return `正在思考：${detail}`
    case 'execute':
      return count > 1 ? `正在运行 ${count} 条命令：${detail}` : `正在运行 ${detail}`
    case 'read':
      return count > 1 ? `正在读取 ${count} 个文件：${detail}` : `正在读取 ${detail}`
    case 'edit':
      return count > 1 ? `正在编辑 ${count} 个文件：${detail}` : `正在编辑 ${detail}`
    case 'search':
      return quoted ? `正在搜索“${detail}”` : `正在搜索 ${detail}`
    case 'fetch':
      return quoted ? `正在搜索网页“${detail}”` : `正在获取 ${detail}`
    default:
      return phaseText(phase, count)
  }
}

const ASKS: Record<string, string> = {
  sign_in: '等你登录',
  code: '等你输入验证码',
  check: '等你通过验证',
  other: '等你做完这一步',
}

/** What the agent asked the user to do on a surface, while its card waits; else null. */
export function askedText(state: ThreadState | null): string | null {
  if (!state) return null
  const { order, byId } = state
  for (let i = order.length - 1; i >= Math.max(0, order.length - LOOKBACK); i--) {
    const entry = byId[order[i]!]
    if (entry?.kind === 'control_ask') {
      return entry.outcome === null ? (ASKS[entry.step] ?? ASKS.other!) : null
    }
    if (entry?.kind === 'user') return null
  }
  return null
}
