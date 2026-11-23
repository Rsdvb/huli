// Huli: a review of a session's changes and its findings, each pinned to a file's lines. They come
// from Codex's review mode or from a reply to Kite's review prompt, both untrusted text read here,
// and live with the session's thread so a restart keeps them. Desktop and phone place them on the
// lines of a diff and tell a finding whose line is gone as outdated.

export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low'

/** Worst first, the order findings are listed in. */
export const REVIEW_SEVERITIES: readonly ReviewSeverity[] = ['critical', 'high', 'medium', 'low']

/** Open, put aside by the user, or sent back to the agent to fix. */
export type ReviewFindingState = 'open' | 'dismissed' | 'sent'

export interface ReviewFinding {
  /** Unique within its review. */
  id: string
  severity: ReviewSeverity
  /** One line. */
  title: string
  /** What is wrong and how it could be fixed, as the reviewer wrote it; may be empty. */
  body: string
  /** The file, relative to the session's folder, with `/` between its parts. */
  path: string
  /** The first and last line, from 1, in the file as it was reviewed. */
  start: number
  end: number
  /**
   * The first line's text, trimmed, as the file had it when the review ended: where it is found
   * again the finding follows it, and where it is gone the finding is outdated. Null when the file
   * could not be read or the line was blank.
   */
  anchor: string | null
  state: ReviewFindingState
}

/** Codex's own review mode, or Kite's prompt answered with a JSON block. */
export type ReviewSource = 'codex' | 'prompt'
/** In a fork of its own beside the session, or as a turn of the session. */
export type ReviewMode = 'detached' | 'inline'
export type ReviewStatus = 'running' | 'done' | 'failed' | 'stopped'

/** A session's latest review; a new one replaces it. */
export interface ReviewRun {
  id: string
  source: ReviewSource
  mode: ReviewMode
  status: ReviewStatus
  startedAt: number
  endedAt: number | null
  /** The reviewer's overall verdict, when it gave one. */
  summary: string | null
  /** Why it failed, for a failed review. */
  error: string | null
  findings: ReviewFinding[]
  /** Findings the answer held that did not pass the checks and were left out. */
  dropped: number
}

export const MAX_FINDINGS = 30
export const FINDING_TITLE_CHARS = 160
export const FINDING_BODY_CHARS = 2000
export const REVIEW_SUMMARY_CHARS = 1000
export const ANCHOR_CHARS = 300
export const REVIEW_ID_CHARS = 64
const MAX_PATH = 1024
const MAX_LINE = 10_000_000
/** A finding covers at most this many lines past its first. */
const MAX_SPAN = 2000
/** A reply longer than this is not read for findings. */
const ANSWER_CHARS = 200_000

/** The tag of the fenced block Kite's review prompt asks the findings in. */
export const REVIEW_BLOCK = 'kite-review'

/** What a reviewer's reply held, before the host gives the findings ids and anchors. */
export interface ParsedReview {
  summary: string | null
  findings: Omit<ReviewFinding, 'id' | 'anchor' | 'state'>[]
  dropped: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isLine = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= MAX_LINE

const isId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= REVIEW_ID_CHARS

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

/** Text cut at `max` characters, never inside a surrogate pair. */
function cut(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('')
}

/** One line: control characters and runs of white space become single spaces. */
function oneLine(text: string, max: number): string {
  return cut(text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim(), max)
}

function paragraph(text: string, max: number): string {
  return cut(
    text
      .replace(/\r\n?/g, '\n')
      .replace(CONTROL, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    max,
  ).trimEnd()
}

const DRIVE = /^[a-z]:$/i

/** A path's parts with `.` and `..` resolved; null when `..` climbs above its start. */
function partsOf(path: string): string[] | null {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0 || (out.length === 1 && DRIVE.test(out[0]!))) return null
      out.pop()
      continue
    }
    out.push(part)
  }
  return out
}

/**
 * A file a reviewer named, as a path relative to `root`, the session's folder: a relative one
 * resolved inside it, an absolute one only when it lies under it. Null for a path that leaves the
 * folder, is empty, too long or holds control characters.
 */
export function relativeFindingPath(file: string, root: string): string | null {
  // eslint-disable-next-line no-control-regex
  if (file.length === 0 || file.length > MAX_PATH || /[\u0000-\u001f\u007f]/.test(file)) {
    return null
  }
  const text = file.trim().replace(/\\/g, '/')
  const absolute = text.startsWith('/') || /^[a-z]:\//i.test(text)
  if (!absolute) {
    const parts = partsOf(text)
    return parts && parts.length > 0 && !DRIVE.test(parts[0]!) ? parts.join('/') : null
  }
  const own = partsOf(text)
  const base = partsOf(root.replace(/\\/g, '/'))
  if (!own || !base || own.length <= base.length) return null
  // A Windows path's case does not tell files apart.
  const windows = DRIVE.test(base[0] ?? '') || DRIVE.test(own[0] ?? '')
  const same = (a: string, b: string): boolean =>
    windows ? a.toLowerCase() === b.toLowerCase() : a === b
  if (!base.every((part, i) => same(part, own[i]!))) return null
  return own.slice(base.length).join('/')
}

const SEVERITY_WORDS: Record<string, ReviewSeverity> = {
  critical: 'critical',
  blocker: 'critical',
  p0: 'critical',
  high: 'high',
  major: 'high',
  p1: 'high',
  medium: 'medium',
  moderate: 'medium',
  p2: 'medium',
  low: 'low',
  minor: 'low',
  nit: 'low',
  p3: 'low',
}

function severityOf(value: unknown): ReviewSeverity | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3) {
    return REVIEW_SEVERITIES[value]!
  }
  if (typeof value !== 'string') return null
  return SEVERITY_WORDS[value.trim().toLowerCase()] ?? null
}

/** The finding's lines; null when they are no line numbers. */
function spanOf(start: unknown, end: unknown): { start: number; end: number } | null {
  if (!isLine(start)) return null
  const last = end === undefined || end === null ? start : end
  if (!isLine(last) || last < start) return { start, end: start }
  return { start, end: Math.min(last, start + MAX_SPAN) }
}

/** A finding as a reply gave it, with its place checked; null for one that does not pass. */
function findingOf(
  value: unknown,
  root: string,
): Omit<ReviewFinding, 'id' | 'anchor' | 'state'> | null {
  if (!isRecord(value)) return null
  const severity = severityOf(value.severity ?? value.priority)
  const rawTitle = value.title
  const rawFile = value.file ?? value.path
  if (severity === null || typeof rawTitle !== 'string' || typeof rawFile !== 'string') return null
  const title = oneLine(rawTitle.split('\n')[0] ?? '', FINDING_TITLE_CHARS)
  const path = relativeFindingPath(rawFile, root)
  const span = spanOf(value.line ?? value.start, value.endLine ?? value.end)
  if (title === '' || path === null || span === null) return null
  const rawBody = value.detail ?? value.body
  const body = typeof rawBody === 'string' ? paragraph(rawBody, FINDING_BODY_CHARS) : ''
  return { severity, title, body, path, ...span }
}

/** The findings that pass, at most MAX_FINDINGS, worst first, each place once. */
function keep(
  candidates: readonly (Omit<ReviewFinding, 'id' | 'anchor' | 'state'> | null)[],
): Pick<ParsedReview, 'findings' | 'dropped'> {
  const seen = new Set<string>()
  const findings: ParsedReview['findings'] = []
  let dropped = 0
  for (const finding of candidates) {
    const key = finding && `${finding.path}\0${finding.start}\0${finding.title}`
    if (!finding || !key || seen.has(key) || findings.length >= MAX_FINDINGS) {
      dropped++
      continue
    }
    seen.add(key)
    findings.push(finding)
  }
  const rank = (severity: ReviewSeverity): number => REVIEW_SEVERITIES.indexOf(severity)
  findings.sort((a, b) => rank(a.severity) - rank(b.severity))
  return { findings, dropped }
}

/** The JSON a reply holds: its last `kite-review` block, else its last JSON block. */
function answerBlock(text: string): string | null {
  const blocks = [...text.matchAll(/```[ \t]*([\w-]*)[^\n]*\n([\s\S]*?)\n[ \t]*```/g)]
  const tagged = blocks.filter((match) => match[1] === REVIEW_BLOCK)
  const json = blocks.filter((match) => match[1] === 'json' && match[2]!.includes('findings'))
  const block = tagged.at(-1) ?? json.at(-1)
  if (block) return block[2]!
  const whole = text.trim()
  return whole.startsWith('{') && whole.endsWith('}') ? whole : null
}

/**
 * The findings in a reply to Kite's review prompt, which is untrusted: the JSON in its
 * `kite-review` block, `{ summary, findings: [{ severity, title, detail, file, line, endLine }] }`,
 * each finding checked on its own and dropped when it does not pass. Null when the reply holds no
 * such block or it does not parse.
 */
export function parseReviewAnswer(text: string, root: string): ParsedReview | null {
  if (text.length > ANSWER_CHARS) return null
  const block = answerBlock(text.replace(/\r\n?/g, '\n'))
  if (block === null) return null
  let data: unknown
  try {
    data = JSON.parse(block)
  } catch {
    return null
  }
  if (Array.isArray(data)) data = { findings: data }
  if (!isRecord(data) || !Array.isArray(data.findings)) return null
  const summary =
    typeof data.summary === 'string' ? paragraph(data.summary, REVIEW_SUMMARY_CHARS) : ''
  return {
    summary: summary === '' ? null : summary,
    ...keep(data.findings.map((value) => findingOf(value, root))),
  }
}

// Codex writes each finding as `- <title> — <absolute path>:<start>-<end>`, its body indented by
// two spaces under it (codex-rs, core/src/review_format.rs), after the overall explanation.
const CODEX_HEADER = /^(?:Full review comments|Review comment):\s*$/
const CODEX_ITEM = /^- (?:\[[ xX]\] )?(.+) — (.+):(\d+)-(\d+)\s*$/
const CODEX_PRIORITY = /^\[P([0-3])\]\s*/i
const CODEX_FALLBACK = 'Reviewer failed to output a response.'

/**
 * The findings in Codex's review as its review mode renders it, which is untrusted text: each
 * item's priority tag (`[P0]` to `[P3]`) gives its severity, and its path must lie under `root`.
 */
export function parseCodexReview(text: string, root: string): ParsedReview {
  const lines = text.slice(0, ANSWER_CHARS).replace(/\r\n?/g, '\n').split('\n')
  const header = lines.findIndex((line) => CODEX_HEADER.test(line.trim()))
  const firstItem = lines.findIndex((line) => CODEX_ITEM.test(line))
  const end = header >= 0 ? header : firstItem >= 0 ? firstItem : lines.length
  const explanation = paragraph(lines.slice(0, end).join('\n'), REVIEW_SUMMARY_CHARS)
  const candidates: (Omit<ReviewFinding, 'id' | 'anchor' | 'state'> | null)[] = []
  for (let i = Math.max(end, 0); i < lines.length; i++) {
    const match = CODEX_ITEM.exec(lines[i]!)
    if (!match) continue
    const body: string[] = []
    while (i + 1 < lines.length && (lines[i + 1]!.startsWith('  ') || lines[i + 1] === '')) {
      // A blank line between items ends the body unless more of it follows.
      if (lines[i + 1] === '' && !lines[i + 2]?.startsWith('  ')) break
      body.push(lines[++i]!.slice(2))
    }
    const rawTitle = match[1]!
    const priority = CODEX_PRIORITY.exec(rawTitle)
    candidates.push(
      findingOf(
        {
          severity: priority ? Number(priority[1]) : 'medium',
          title: rawTitle.replace(CODEX_PRIORITY, ''),
          detail: body.join('\n'),
          file: match[2]!,
          line: Number(match[3]),
          endLine: Number(match[4]),
        },
        root,
      ),
    )
  }
  const summary = explanation === '' || explanation === CODEX_FALLBACK ? null : explanation
  return { summary, ...keep(candidates) }
}

/** The text a line is told by, as `anchor` keeps it. */
export function anchorText(line: string): string {
  return cut(line.trim(), ANCHOR_CHARS)
}

/** Where a finding sits in the file as it is now: its lines, and whether they moved. */
export interface FindingPlace {
  start: number
  end: number
  moved: boolean
}

/**
 * Where the finding's lines are in `lines`, the file as it is now: where it was when its first line
 * still reads the same, else at the nearest line that does. Null when that line is gone, or, for a
 * finding without an anchor, when the file is now shorter than its first line.
 */
export function placeFinding(
  finding: Pick<ReviewFinding, 'start' | 'end' | 'anchor'>,
  lines: readonly string[],
): FindingPlace | null {
  const span = finding.end - finding.start
  const at = (start: number): FindingPlace => ({
    start,
    end: Math.max(start, Math.min(start + span, lines.length)),
    moved: start !== finding.start,
  })
  const { anchor } = finding
  if (anchor === null) return finding.start <= lines.length ? at(finding.start) : null
  if (anchorText(lines[finding.start - 1] ?? '') === anchor) return at(finding.start)
  let best = 0
  for (let i = 0; i < lines.length; i++) {
    if (anchorText(lines[i]!) !== anchor) continue
    const line = i + 1
    if (best === 0 || Math.abs(line - finding.start) < Math.abs(best - finding.start)) best = line
  }
  return best > 0 ? at(best) : null
}

const SOURCES: ReadonlySet<unknown> = new Set(['codex', 'prompt'])
const MODES: ReadonlySet<unknown> = new Set(['detached', 'inline'])
const STATUSES: ReadonlySet<unknown> = new Set(['running', 'done', 'failed', 'stopped'])
const STATES: ReadonlySet<unknown> = new Set(['open', 'dismissed', 'sent'])

function storedFinding(value: unknown): ReviewFinding | null {
  if (!isRecord(value)) return null
  const { id, severity, title, body, path, start, end, anchor, state } = value
  if (
    !isId(id) ||
    !REVIEW_SEVERITIES.includes(severity as ReviewSeverity) ||
    typeof title !== 'string' ||
    title === '' ||
    typeof body !== 'string' ||
    typeof path !== 'string' ||
    path === '' ||
    path.length > MAX_PATH ||
    !isLine(start) ||
    !isLine(end) ||
    end < start ||
    !(anchor === null || typeof anchor === 'string') ||
    !STATES.has(state)
  ) {
    return null
  }
  return {
    id,
    severity: severity as ReviewSeverity,
    title: cut(title, FINDING_TITLE_CHARS),
    body: cut(body, FINDING_BODY_CHARS),
    path,
    start,
    end,
    anchor: anchor === null ? null : cut(anchor, ANCHOR_CHARS),
    state: state as ReviewFindingState,
  }
}

const isTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/**
 * A review as the thread stored it, which an older or newer app may have written: damaged
 * findings are dropped one by one, and one still running when the host stopped never ends, so it
 * reads as stopped. Null for none or one that does not parse.
 */
export function parseStoredReview(value: unknown): ReviewRun | null {
  if (!isRecord(value)) return null
  const { id, source, mode, status, startedAt, endedAt, summary, error, findings, dropped } = value
  if (
    !isId(id) ||
    !SOURCES.has(source) ||
    !MODES.has(mode) ||
    !STATUSES.has(status) ||
    !isTime(startedAt) ||
    !(endedAt === null || isTime(endedAt)) ||
    !(summary === null || typeof summary === 'string') ||
    !(error === null || typeof error === 'string') ||
    !Array.isArray(findings)
  ) {
    return null
  }
  const kept = findings.flatMap((finding) => storedFinding(finding) ?? []).slice(0, MAX_FINDINGS)
  return {
    id,
    source: source as ReviewSource,
    mode: mode as ReviewMode,
    status: status === 'running' ? 'stopped' : (status as ReviewStatus),
    startedAt,
    endedAt,
    summary: summary === null ? null : cut(summary, REVIEW_SUMMARY_CHARS),
    error: error === null ? null : cut(error, REVIEW_SUMMARY_CHARS),
    findings: kept,
    dropped: isTime(dropped) && Number.isInteger(dropped) ? dropped : 0,
  }
}

/** The findings still to look at: neither put aside nor sent. */
export function openFindings(review: ReviewRun | null | undefined): ReviewFinding[] {
  return review ? review.findings.filter((finding) => finding.state === 'open') : []
}

/** The findings shown on a diff, open or sent, in the order they are listed. */
export function shownFindings(review: ReviewRun | null | undefined): ReviewFinding[] {
  return review ? review.findings.filter((finding) => finding.state !== 'dismissed') : []
}

/** What the user does with findings: put them aside, take them back, or send them to be fixed. */
export type ReviewAction = 'dismiss' | 'restore' | 'fix'
export const REVIEW_ACTIONS: readonly ReviewAction[] = ['dismiss', 'restore', 'fix']
