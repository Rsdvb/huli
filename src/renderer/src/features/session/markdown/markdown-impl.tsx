import { parseArtifactLink } from '@shared/artifact-links'
import 'streamdown/styles.css'
import {
  isValidElement,
  lazy,
  memo,
  Suspense,
  useContext,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react'
import type { CodeHighlighterPlugin, HighlightResult } from '@streamdown/code'
import { createCodePlugin } from './code-plugin'
import { Tick02Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import {
  defaultComponents,
  defaultRehypePlugins,
  Streamdown,
  type Components,
  type ExtraProps,
  type StreamdownProps,
} from 'streamdown'
import { githubIssueUrl } from '@shared/git'
import type { TextStep } from '@shared/thread'
import { Kbd } from '@renderer/components/ui/kbd'
import { AgentFileLink, FileLink } from '@renderer/features/files/file-link'
import {
  PreviewFileContext,
  ProjectPathContext,
  useAgentFileRef,
  useFileRef,
} from '@renderer/features/files/file-refs'
import { PreviewImage } from '@renderer/features/files/preview-image'
import { useProjectRepository } from '@renderer/features/git/gh-reference-data'
import { ConfirmedLink } from '@renderer/features/session/link-confirm'
import { EntryIdContext, SessionIdContext } from '@renderer/features/session/media/grants'
import { LocalMedia, MediaRows } from '@renderer/features/session/media/local-media'
import { MediaGrid } from '@renderer/features/session/media/media-grid'
import { useNearView } from '@renderer/features/session/media/near-view'
import {
  NamedMedia,
  NamedMediaContext,
  namedMedia,
  type MediaClaim,
} from '@renderer/features/session/media/named'
import { HAN } from '@renderer/lib/han'
import { cn } from '@renderer/lib/utils'
import { markdownHeight } from '@renderer/features/session/thread-items'
import { Blockquote } from './alert'
import { restoreIpv6Hrefs } from './bare-host-links'
import { splitIntoChunks } from './chunks'
import { codeThemeInput, useCodeThemes, type CodeThemes } from './code-themes'
import { localImageTarget, pictureRun, spacedImages } from './local-images'
import { ArtifactLink } from './artifact-link'
import { INCOMPLETE_LINK, localTarget, unopenedTarget } from './local-links'
import { githubAlerts } from './github-alerts'
import { bareReferenceNumber } from './github-refs'
import { cjkPlugin, remarkPlugins } from './remark'
import { BlockCode } from './code-frame'
import { MarkdownTable } from './markdown-table'
import {
  isRendered,
  KeepInPlace,
  saveParts,
  savedParts,
  slotOf,
  useRenderedChunks,
  type SavedParts,
  type Slot,
  type View,
} from './in-parts'
import { LiveContext } from './live'
import type { MarkdownProps } from './index'

// KaTeX, its styles and fonts load with the first formula, not with every reply.
const InlineMath = lazy(() => import('./math').then((m) => ({ default: m.InlineMath })))

/** Code as it is, one plain token a line: what Streamdown shows before Shiki has loaded. */
function plainTokens(code: string): HighlightResult {
  return {
    bg: 'transparent',
    fg: 'inherit',
    tokens: code
      .split('\n')
      .map((content) => [
        { content, color: 'inherit', bgColor: 'transparent', htmlStyle: {}, offset: 0 },
      ]),
  }
}

/**
 * Shiki for a closed block only: one still being written shows its code plain until its fence
 * closes, and is highlighted once then. Highlighting it on every chunk tokenized it again and
 * set the colors of all its spans anew, which restyled every one of them.
 */
function highlightClosed(shiki: CodeHighlighterPlugin): CodeHighlighterPlugin {
  return {
    ...shiki,
    highlight: (options, done) =>
      options.isIncomplete ? plainTokens(options.code) : shiki.highlight(options, done),
  }
}

// Fenced blocks go through BlockCode, which picks maths, SVG, diagrams or code by language.
function createPlugins({ light, dark }: CodeThemes) {
  return {
    code: highlightClosed(
      createCodePlugin({ themes: [codeThemeInput(light), codeThemeInput(dark)] }),
    ),
    cjk: cjkPlugin,
  }
}

type Plugins = ReturnType<typeof createPlugins>

// One set per pair of code themes, shared by every chunk: Streamdown's context depends on it, and
// a new object would re-render every code block. Keep only the latest couple of theme pairs.
const MAX_THEME_PLUGIN_SETS = 2
const pluginsByThemes = new Map<string, Plugins>()

function pluginsFor(themes: CodeThemes): Plugins {
  const key = `${themes.light} ${themes.dark}`
  let plugins = pluginsByThemes.get(key)
  if (plugins) {
    pluginsByThemes.delete(key)
    pluginsByThemes.set(key, plugins)
    return plugins
  }
  plugins = createPlugins(themes)
  pluginsByThemes.set(key, plugins)
  if (pluginsByThemes.size > MAX_THEME_PLUGIN_SETS) {
    pluginsByThemes.delete(pluginsByThemes.keys().next().value!)
  }
  return plugins
}

const DefaultImage = defaultComponents.img
const DefaultParagraph = defaultComponents.p
const DefaultListItem = defaultComponents.li

function isWebLink(href: string): boolean {
  const protocol = URL.parse(href)?.protocol
  return protocol === 'http:' || protocol === 'https:'
}

/** A `#12` in a reply: an issue or pull request of the project's own GitHub repository. */
function BareReference({ number, children }: { number: number; children: ReactNode }) {
  const repo = useProjectRepository()
  if (!repo) return children
  return (
    <ConfirmedLink url={githubIssueUrl(repo.owner, repo.repo, number)}>{children}</ConfirmedLink>
  )
}

/** A link: a project file, or a web link with its site's icon. */
export function Link(props: ComponentProps<'a'> & ExtraProps) {
  const raw = typeof props.href === 'string' ? props.href : ''
  const local = localTarget(raw)
  const href = local ?? raw
  const file = useFileRef(href, true)
  const own = useAgentFileRef(local)
  if (file) return <FileLink file={file} />
  if (own) return <AgentFileLink file={own} />
  // Any other local path has nowhere to go, and main opens nothing but web links.
  if (local !== null) return <span title={local}>{props.children}</span>
  const unopened = unopenedTarget(raw)
  const artifact = unopened !== null ? parseArtifactLink(unopened) : null
  if (artifact) return <ArtifactLink location={artifact}>{props.children}</ArtifactLink>
  if (unopened !== null) return <span title={unopened}>{props.children}</span>
  // A link still streaming in, drawn as a link that opens nothing.
  if (raw === INCOMPLETE_LINK) return <span className="thread-link">{props.children}</span>
  const bare = bareReferenceNumber(raw)
  if (bare !== null) return <BareReference number={bare}>{props.children}</BareReference>
  if (!isWebLink(raw)) return <span title={raw}>{props.children}</span>
  return <ConfirmedLink url={raw}>{props.children}</ConfirmedLink>
}

/**
 * An image: a local file from the media scheme, in the Files pane's preview a project file found
 * from the previewed file's folder, a remote one as a link to it, since the CSP loads nothing
 * remote, or a `data:` or `blob:` picture as it comes. Anything else, such as `//host/x.png`,
 * would resolve against the page, so it stays text.
 */
function MarkdownImage(props: ComponentProps<'img'> & ExtraProps) {
  const preview = useContext(PreviewFileContext)
  const src = typeof props.src === 'string' ? props.src : ''
  const local = localImageTarget(src)
  if (local !== null && preview) {
    return <PreviewImage key={local} file={preview} written={local} alt={props.alt ?? ''} />
  }
  if (local !== null) {
    return <LocalMedia key={local} path={local} origin="image" alt={props.alt ?? ''} />
  }
  const remote = /^https?:/i.test(src) ? URL.parse(src) : null
  if (remote) {
    return <ConfirmedLink url={src}>{remote.host}</ConfirmedLink>
  }
  if (/^(?:data|blob):/i.test(src)) return <DefaultImage {...props} />
  return <span title={src}>{props.alt}</span>
}

/** Inline code, which is a file chip when it is a path in the project, or a formula. */
function InlineCode({ className, children }: ComponentProps<'code'> & ExtraProps) {
  const math = !!className?.includes('language-math')
  const file = useFileRef(typeof children === 'string' && !math ? children : null)
  if (math) {
    const tex = textOf(children)
    return (
      <Suspense fallback={<code data-streamdown="inline-code">{tex}</code>}>
        <InlineMath tex={tex} />
      </Suspense>
    )
  }
  if (file) return <FileLink file={file} />
  return (
    <code className={className} data-streamdown="inline-code">
      {children}
    </code>
  )
}

/**
 * The media files a block's file references name, shown under it, each once per message and only
 * under the first block that names it.
 */
function MediaUnder({ node }: ExtraProps) {
  const named = useContext(NamedMediaContext)
  const projectPath = useContext(ProjectPathContext)
  const sessionId = useContext(SessionIdContext)
  const enabled = !!projectPath && !!sessionId && !!named
  const paths = namedMedia(node)
  const key = paths.join('\0')
  const ref = useRef<HTMLDivElement>(null)
  const [claim, setClaim] = useState<MediaClaim<Element> | null>(null)
  useSyncExternalStore(named?.subscribe ?? noSubscribe, named?.getVersion ?? noVersion)
  useLayoutEffect(() => {
    const at = ref.current
    if (!at || !named || key === '') return
    const next = { at, paths: key.split('\0') }
    setClaim(next)
    return named.claim(next)
  }, [named, key])
  const shown = enabled && claim && named ? named.shown(claim) : []
  const near = useNearView(ref, shown.length > 0)
  if (!enabled || paths.length === 0) return null
  return (
    // Empty, a box of no height, until the host finds a file it names (globals.css).
    <div ref={ref} data-media-block="" className="flex flex-col items-start gap-3">
      <MediaRows paths={shown} near={near} />
    </div>
  )
}

const noSubscribe = () => () => {}
const noVersion = () => 0

function Paragraph(props: ComponentProps<'p'> & ExtraProps) {
  const projectPath = useContext(ProjectPathContext)
  const sessionId = useContext(SessionIdContext)
  // Outside a session the pictures cannot be read, so they stay their alt text.
  const pictures = projectPath && sessionId ? pictureRun(props.node) : null
  if (pictures) {
    return (
      <div data-media-block="">
        <MediaGrid paths={pictures} images />
      </div>
    )
  }
  return (
    <>
      <DefaultParagraph {...props} />
      <MediaUnder node={props.node} />
    </>
  )
}

function ListItem({ children, ...props }: ComponentProps<'li'> & ExtraProps) {
  return (
    <DefaultListItem {...props}>
      {children}
      <MediaUnder node={props.node} />
    </DefaultListItem>
  )
}

function Table(props: ComponentProps<'table'> & ExtraProps) {
  return (
    <>
      <MarkdownTable {...props} />
      <MediaUnder node={props.node} />
    </>
  )
}

/** A task list's box: checked or not as the agent wrote it, and never something to click. */
function TaskCheckbox({ type, checked }: ComponentProps<'input'> & ExtraProps) {
  if (type !== 'checkbox') return null
  return (
    <span data-task-box="" role="checkbox" aria-checked={!!checked} aria-disabled>
      {checked && <HugeiconsIcon icon={Tick02Icon} strokeWidth={1.9} aria-hidden />}
    </span>
  )
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

function Emphasis({ children, className }: ComponentProps<'em'> & ExtraProps) {
  return (
    <em className={className} data-cjk-emphasis={HAN.test(textOf(children)) ? '' : undefined}>
      {children}
    </em>
  )
}

/** A key from `<kbd>`, as the interface draws its shortcuts, sized to the prose. */
function Key({ children }: ComponentProps<'kbd'> & ExtraProps) {
  return (
    <Kbd className="pointer-events-auto h-auto min-h-[1.5em] min-w-[1.5em] px-[0.45em] text-[0.8667em] select-text">
      {children}
    </Kbd>
  )
}

const components: Components = {
  a: Link,
  img: MarkdownImage,
  p: Paragraph,
  li: ListItem,
  table: Table,
  blockquote: Blockquote,
  code: BlockCode,
  inlineCode: InlineCode,
  input: TaskCheckbox,
  em: Emphasis,
  kbd: Key,
}

// Restore IPv6 host brackets before rehype-harden parses anchor URLs, and mark alerts after the
// sanitizer, which would drop the mark.
const rehypePlugins: NonNullable<StreamdownProps['rehypePlugins']> = [
  ...Object.entries(defaultRehypePlugins).flatMap(([name, plugin]) =>
    name === 'harden' ? [restoreIpv6Hrefs, plugin] : [plugin],
  ),
  githubAlerts,
]

// The link component opens links itself (web-link.tsx), so Streamdown's own check stays off.
const linkSafety = { enabled: false }

// The blocks and tables draw their own actions (code-frame.tsx, markdown-table.tsx).
const controls = false

// A `$$` still open is left open, so it shows as its source and KaTeX draws it once it closes
// (maths.ts, openMath), instead of being closed for KaTeX at every chunk.
const repair = { katex: false }

/**
 * How often, at most, a text being written renders what came: each render of the tail parses its
 * open block again and restyles and lays it out, and rendering at every chunk of a fast stream kept
 * Blink's heap growing by about 300 MB over a 300 KB reply.
 */
const WRITING_RENDER_MS = 50

interface Text {
  markdown: string
  step: TextStep | undefined
}

/** What has come since the text shown: the newest text, and one step to it from the one shown. */
interface Waiting {
  markdown: string
  id: number | null
  /** The id of the text shown. */
  from: number | null
  /** What was appended to the text shown, or null when it changed otherwise. */
  appended: string | null
  /** When the text shown was last replaced. */
  at: number
  timer: ReturnType<typeof setTimeout> | undefined
}

/**
 * The text a message renders: while it is written, what came at most every WRITING_RENDER_MS,
 * the newest always following within that time; the rest of the time, and as soon as the writing
 * ends, the text as it is. The step given to useChunks goes from the text shown, so it still reads
 * only what was appended.
 */
function useWritingCadence(markdown: string, step: TextStep | undefined, writing: boolean): Text {
  const [shown, setShown] = useState<Text>(() => ({ markdown, step }))
  if (!writing && (shown.markdown !== markdown || shown.step?.id !== step?.id)) {
    setShown({ markdown, step })
  }
  const waiting = useRef<Waiting>({
    markdown,
    id: step?.id ?? null,
    from: step?.id ?? null,
    appended: '',
    at: 0,
    timer: undefined,
  })
  useLayoutEffect(() => {
    const queue = waiting.current
    if (!writing) {
      clearTimeout(queue.timer)
      Object.assign(queue, { markdown, id: step?.id ?? null, appended: '', timer: undefined })
      queue.from = queue.id
      return
    }
    if (markdown === queue.markdown) return
    const id = step?.id ?? null
    const follows = step !== undefined && step.after !== null && step.after === queue.id
    queue.appended = follows && queue.appended !== null ? queue.appended + step.appended : null
    queue.markdown = markdown
    queue.id = id
    if (queue.timer !== undefined) return
    const show = (): void => {
      queue.timer = undefined
      queue.at = performance.now()
      const next: TextStep | undefined =
        queue.id === null
          ? undefined
          : {
              id: queue.id,
              after: queue.appended === null ? null : queue.from,
              appended: queue.appended ?? '',
            }
      setShown({ markdown: queue.markdown, step: next })
      queue.from = queue.id
      queue.appended = ''
    }
    const wait = queue.at + WRITING_RENDER_MS - performance.now()
    if (wait <= 0) show()
    else queue.timer = setTimeout(show, wait)
  })
  useEffect(() => {
    const queue = waiting.current
    return () => clearTimeout(queue.timer)
  }, [])
  return writing ? shown : { markdown, step }
}

/**
 * The text's chunks, kept from the previous render while the text only grows. A long message's are
 * kept while it is not shown too, with the places its chunks were laid out at (in-parts.ts).
 */
function useChunks(
  markdown: string,
  live: boolean,
  key: string | null,
  step: TextStep | undefined,
): SavedParts {
  const textId = step?.id ?? null
  const [split, setSplit] = useState<SavedParts & { textId: number | null }>(() => {
    const kept = savedParts(key, markdown)
    return {
      ...splitIntoChunks(markdown, live, kept ?? undefined),
      slots: kept?.slots ?? new Map(),
      textId,
    }
  })
  // The same string, as an entry changed otherwise keeps it, compares without reading it.
  if (split.markdown === markdown && split.live === live) {
    if (split.textId !== textId) setSplit({ ...split, textId })
    return split
  }
  const appended = step && step.after !== null && step.after === split.textId
  const next = {
    ...splitIntoChunks(markdown, live, split, appended ? step.appended : undefined),
    slots: split.slots,
    textId,
  }
  setSplit(next)
  return next
}

/** Holds the place of a chunk not rendered: as it was last laid out, else at about its height. */
const ChunkPlaceholder = memo(function ChunkPlaceholder({
  markdown,
  slot,
}: {
  markdown: string
  slot: Slot | null
}) {
  const estimate = useMemo(() => (slot ? 0 : markdownHeight(markdown)), [markdown, slot])
  const style = slot
    ? { height: slot.height, marginTop: slot.before, marginBottom: slot.after }
    : { height: estimate }
  return <div aria-hidden className="markdown-chunk" data-part-placeholder="" style={style} />
})

/**
 * While the message is written, marks its last block, the last child of the last chunk that is
 * not an empty media block, for the last-block rules in globals.css, which find it by position
 * only once it is written: a position rule tested while it streams restyled the whole subtrees of
 * the blocks before each block added.
 */
function useLastBlockMark(root: RefObject<HTMLElement | null>, live: boolean): void {
  const marked = useRef<Element | null>(null)
  useLayoutEffect(() => {
    let last = live ? (root.current?.lastElementChild?.lastElementChild ?? null) : null
    while (last?.hasAttribute('data-media-block') && !last.hasChildNodes()) {
      last = last.previousElementSibling
    }
    if (last === marked.current) return
    marked.current?.removeAttribute('data-last-block')
    last?.setAttribute('data-last-block', '')
    marked.current = last
  })
}

type ChunkOptions = Pick<MarkdownProps, 'components' | 'remarkPlugins'>

/** The chunk at `index`, rendered or holding its place. */
function chunkElement(
  index: number,
  markdown: string,
  rendered: boolean,
  view: View,
  live: boolean,
  { components, remarkPlugins }: ChunkOptions,
): ReactElement {
  // By position: when the tail settles, the chunk in its place keeps its rendered blocks.
  return rendered ? (
    <Chunk
      key={index}
      markdown={markdown}
      live={live}
      components={components}
      remarkPlugins={remarkPlugins}
    />
  ) : (
    <ChunkPlaceholder key={index} markdown={markdown} slot={slotOf(view, index, markdown.length)} />
  )
}

/**
 * Agent prose. Raw HTML goes through the sanitizer, and an inline `<svg>` is first written as an
 * `svg` code block (`inline-svg.ts`) and a `\[...\]` on lines of its own as a `$$` block
 * (`maths.ts`). A long text renders in chunks (`chunks.ts`), so a streamed update re-renders, lays
 * out and paints the live tail instead of the whole message, and only its chunks near the view
 * render (`in-parts.ts`). The settled chunks' elements are kept while only the tail changes, so an
 * update renders the tail alone. Streaming mode splits each chunk into memoized blocks, and the
 * mode never changes: static mode renders one tree, so switching when a message finishes would
 * rebuild all of it. Finishing only turns off incomplete-markdown repair.
 */
function MarkdownImpl({
  markdown,
  step,
  streaming = false,
  className,
  components: customComponents,
  remarkPlugins: customRemarkPlugins,
}: MarkdownProps) {
  // Finishing re-renders every code block and table to enable their controls; deferring it lets
  // React split that work across frames instead of blocking one.
  const live = useDeferredValue(streaming)
  // A message's, so a long one keeps its chunks and their places while it is not shown.
  const sessionId = useContext(SessionIdContext)
  const entryId = useContext(EntryIdContext)
  const key = sessionId !== null && entryId !== null ? `${sessionId}\0${entryId}` : null
  const text = useWritingCadence(markdown, step, streaming)
  const split = useChunks(text.markdown, live, key, text.step)
  const { settled, tail, slots } = split
  const count = settled.length + 1
  const root = useRef<HTMLDivElement>(null)
  const view = useRenderedChunks(split, streaming, root, slots)
  useLastBlockMark(root, streaming)
  useEffect(() => {
    if (count > 1) saveParts(key, split)
  }, [key, split, count])
  const [named] = useState(() => new NamedMedia())
  const options = useMemo(
    () => ({ components: customComponents, remarkPlugins: customRemarkPlugins }),
    [customComponents, customRemarkPlugins],
  )
  const settledElements = useMemo(
    () =>
      settled.map((chunk, i) =>
        chunkElement(i, chunk, isRendered(view, i, count, streaming), view, live, options),
      ),
    [settled, view, count, streaming, live, options],
  )
  const last = settled.length
  const tailElement = chunkElement(
    last,
    tail,
    isRendered(view, last, count, streaming),
    view,
    live,
    options,
  )
  return (
    <div ref={root} className={cn('markdown', !streaming && 'markdown-written', className)}>
      <NamedMediaContext value={named}>
        <KeepInPlace root={root} view={view}>
          {count === 1 ? [tailElement] : [...settledElements, tailElement]}
        </KeepInPlace>
      </NamedMediaContext>
    </div>
  )
}

/**
 * A chunk of the text. Huli: streamed words show as they arrive, without affectUI's fade: each
 * word's fade ran on the main thread for 420 ms, so with words arriving all the time a streaming
 * reply restyled and repainted at the display's rate, not at the stream's.
 */
const Chunk = memo(function Chunk({
  markdown,
  live,
  components: customComponents,
  remarkPlugins: customRemarkPlugins,
}: Pick<MarkdownProps, 'components' | 'remarkPlugins'> & {
  markdown: string
  live: boolean
}) {
  const mergedComponents = useMemo(
    () => (customComponents ? { ...components, ...customComponents } : components),
    [customComponents],
  )
  const mergedRemarkPlugins = useMemo(
    () => (customRemarkPlugins ? [...remarkPlugins, ...customRemarkPlugins] : remarkPlugins),
    [customRemarkPlugins],
  )
  const source = useMemo(() => spacedImages(markdown), [markdown])
  const themes = useCodeThemes()
  const plugins = useMemo(() => pluginsFor(themes), [themes])
  return (
    <LiveContext value={live}>
      {/* The last-block rules in globals.css name the chunks by this class. */}
      <Streamdown
        className="markdown-chunk"
        mode="streaming"
        parseIncompleteMarkdown={live}
        remend={repair}
        isAnimating={live}
        animated={false}
        skipHtml
        plugins={plugins}
        remarkPlugins={mergedRemarkPlugins}
        rehypePlugins={rehypePlugins}
        components={mergedComponents}
        linkSafety={linkSafety}
        controls={controls}
        codeBlockMaxHeight={0}
        tableMaxHeight={0}
        lineNumbers={false}
      >
        {source}
      </Streamdown>
    </LiveContext>
  )
})

export default memo(MarkdownImpl)
