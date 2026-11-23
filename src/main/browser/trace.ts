// Huli: what `browser_trace` answers of a performance trace the DevTools protocol's Tracing domain
// recorded: the page's long tasks, the scripts that ran longest, the time layout and style took,
// and its largest contentful paint, read from the trace's events as the Performance panel reads
// them. No Lighthouse: these few numbers are what an agent acts on.

/** The trace's categories: the Performance panel's timeline, enough for the summary. */
export const TRACE_CATEGORIES = [
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'v8.execute',
  'blink.user_timing',
  'loading',
  'toplevel',
  '__metadata',
]

/** A task on the page's main thread longer than this blocks input, as the web's long tasks do. */
export const LONG_TASK_MS = 50

export interface TraceEvent {
  name?: string
  cat?: string
  ph?: string
  ts?: number
  dur?: number
  pid?: number
  tid?: number
  args?: Record<string, unknown>
}

export interface TraceSummary {
  /** How long the trace covers, in ms. */
  duration_ms: number
  long_tasks: { count: number; total_ms: number; longest: { at_ms: number; ms: number }[] }
  main_thread: { scripting_ms: number; layout_ms: number; style_ms: number; paint_ms: number }
  top_scripts: { url: string; ms: number }[]
  /** The largest contentful paint from the trace's navigation, or the page's own last report. */
  lcp: { ms: number; element: string | null; from: 'trace' | 'page' } | null
  /** The first contentful paint, likewise. */
  fcp_ms: number | null
}

const round = (ms: number): number => Math.round(ms * 10) / 10

function data(event: TraceEvent): Record<string, unknown> {
  const value = event.args?.data
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** The events of a trace file, whether it is an array or an object holding `traceEvents`. */
export function traceEvents(json: unknown): TraceEvent[] {
  if (Array.isArray(json)) return json as TraceEvent[]
  if (typeof json === 'object' && json !== null) {
    const events = (json as { traceEvents?: unknown }).traceEvents
    if (Array.isArray(events)) return events as TraceEvent[]
  }
  return []
}

/**
 * The summary of a trace's events. The page's main threads are the renderer main threads of the
 * processes its frames ran in, as `TracingStartedInBrowser` names them, or every renderer main
 * thread when the trace does not say. `pageLcp` is the page's own LCP, for a trace without a
 * navigation.
 */
export function summarizeTrace(
  events: readonly TraceEvent[],
  pageLcp: { ms: number; element: string | null } | null = null,
  pageFcp: number | null = null,
): TraceSummary {
  const pagePids = new Set<number>()
  for (const event of events) {
    if (event.name !== 'TracingStartedInBrowser') continue
    for (const frame of (data(event).frames as { processId?: number }[] | undefined) ?? []) {
      if (typeof frame.processId === 'number') pagePids.add(frame.processId)
    }
  }
  const mainThreads = new Set<string>()
  for (const event of events) {
    if (event.ph !== 'M' || event.name !== 'thread_name') continue
    if (event.args?.name !== 'CrRendererMain') continue
    if (pagePids.size > 0 && !pagePids.has(event.pid ?? -1)) continue
    mainThreads.add(`${event.pid}:${event.tid}`)
  }
  const onMain = (event: TraceEvent): boolean =>
    mainThreads.size === 0 || mainThreads.has(`${event.pid}:${event.tid}`)

  let first = Infinity
  let last = -Infinity
  const long: { at: number; ms: number }[] = []
  const totals = { scripting: 0, layout: 0, style: 0, paint: 0 }
  const scripts = new Map<string, number>()
  let navigationStart: number | null = null
  let lcp: { ts: number; element: string | null } | null = null
  let fcp: number | null = null
  for (const event of events) {
    const ts = event.ts
    if (typeof ts !== 'number' || event.ph === 'M') continue
    first = Math.min(first, ts)
    last = Math.max(last, ts + (event.dur ?? 0))
    const ms = (event.dur ?? 0) / 1000
    // Older traces say whether a navigation loads the main frame; newer ones name its URL.
    const nav = data(event)
    if (
      event.name === 'navigationStart' &&
      nav.isLoadingMainFrame !== false &&
      typeof nav.documentLoaderURL === 'string' &&
      /^https?:/.test(nav.documentLoaderURL)
    ) {
      navigationStart = ts
      lcp = null
      fcp = null
    }
    if (event.name === 'firstContentfulPaint' && navigationStart !== null && fcp === null) fcp = ts
    if (event.name === 'largestContentfulPaint::Candidate') {
      const node = data(event)
      if (navigationStart !== null && (lcp === null || ts >= lcp.ts)) {
        lcp = { ts, element: typeof node.nodeName === 'string' ? node.nodeName : null }
      }
    }
    if (event.ph !== 'X' || !onMain(event)) continue
    switch (event.name) {
      case 'RunTask':
        if (ms > LONG_TASK_MS) long.push({ at: ts, ms })
        break
      case 'Layout':
        totals.layout += ms
        break
      case 'UpdateLayoutTree':
      case 'RecalculateStyles':
        totals.style += ms
        break
      case 'Paint':
      case 'PaintImage':
      case 'Layerize':
        totals.paint += ms
        break
      case 'EvaluateScript':
      case 'FunctionCall':
      case 'v8.compile':
      case 'TimerFire':
      case 'EventDispatch': {
        // The outermost script of a task counts once; its calls nest inside it.
        if (event.name === 'EvaluateScript' || event.name === 'FunctionCall') {
          const at = data(event)
          const url = typeof at.url === 'string' && at.url !== '' ? at.url : '(inline or eval)'
          // Electron's own setup of a sandboxed page is not the page's.
          if (url.startsWith('node:')) break
          totals.scripting += ms
          scripts.set(url, (scripts.get(url) ?? 0) + ms)
        }
        break
      }
      default:
        break
    }
  }
  const start = Number.isFinite(first) ? first : 0
  long.sort((a, b) => b.ms - a.ms)
  return {
    duration_ms: Number.isFinite(first) ? round((last - first) / 1000) : 0,
    long_tasks: {
      count: long.length,
      total_ms: round(long.reduce((sum, task) => sum + task.ms, 0)),
      longest: long.slice(0, 5).map((task) => ({
        at_ms: round((task.at - start) / 1000),
        ms: round(task.ms),
      })),
    },
    main_thread: {
      scripting_ms: round(totals.scripting),
      layout_ms: round(totals.layout),
      style_ms: round(totals.style),
      paint_ms: round(totals.paint),
    },
    top_scripts: [...scripts]
      .filter(([, ms]) => ms >= 0.5)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([url, ms]) => ({ url, ms: round(ms) })),
    lcp:
      lcp && navigationStart !== null
        ? { ms: round((lcp.ts - navigationStart) / 1000), element: lcp.element, from: 'trace' }
        : pageLcp
          ? { ms: round(pageLcp.ms), element: pageLcp.element, from: 'page' }
          : null,
    fcp_ms:
      fcp !== null && navigationStart !== null
        ? round((fcp - navigationStart) / 1000)
        : pageFcp === null
          ? null
          : round(pageFcp),
  }
}

/** The summary in a few lines, for the result's text. */
export function traceText(summary: TraceSummary): string {
  const { long_tasks: long, main_thread: main, lcp } = summary
  const lines = [
    `Traced ${summary.duration_ms} ms.`,
    long.count === 0
      ? 'No long tasks (over 50 ms).'
      : `${long.count} long task${long.count === 1 ? '' : 's'} (over 50 ms), ${long.total_ms} ms in all; the longest ${long.longest.map((t) => `${t.ms} ms at ${t.at_ms} ms`).join(', ')}.`,
    `Main thread: scripting ${main.scripting_ms} ms, style ${main.style_ms} ms, layout ${main.layout_ms} ms, paint ${main.paint_ms} ms.`,
  ]
  if (summary.top_scripts.length > 0) {
    lines.push(
      `Longest scripts: ${summary.top_scripts.map((s) => `${s.url} ${s.ms} ms`).join('; ')}.`,
    )
  }
  lines.push(
    lcp
      ? `Largest contentful paint: ${lcp.ms} ms${lcp.element ? ` (${lcp.element})` : ''}${lcp.from === 'page' ? ', as the page last reported it' : ''}.`
      : 'No largest contentful paint was reported; trace with reload to measure the page loading, while the page shows in the pane.',
  )
  if (summary.fcp_ms !== null) lines.push(`First contentful paint: ${summary.fcp_ms} ms.`)
  return lines.join('\n')
}
