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
  type ReactNode,
} from 'react'
import { cjk } from '@streamdown/cjk'
import {
  createCodePlugin,
  type CodeHighlighterPlugin,
  type HighlightResult,
} from '@streamdown/code'
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
import { Kbd } from '@renderer/components/ui/kbd'
import { AgentFileLink, FileLink } from '@renderer/features/files/file-link'
import { ProjectPathContext, useAgentFileRef, useFileRef } from '@renderer/features/files/file-refs'
import { useProjectRepository } from '@renderer/features/git/gh-reference-data'
import { ConfirmedLink } from '@renderer/features/session/link-confirm'
import { EntryIdContext, SessionIdContext } from '@renderer/features/session/media/grants'
import { LocalMedia, MediaRows } from '@renderer/features/session/media/local-media'
import { MediaGrid } from '@renderer/features/session/media/media-grid'
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
import { splitIntoChunks } from './chunks'
import { codeThemeInput, useCodeThemes, type CodeThemes } from './code-themes'
import { localImageTarget, pictureRun, spacedImages } from './local-images'
import { INCOMPLETE_LINK, localTarget, unopenedTarget } from './local-links'
import { githubAlerts } from './github-alerts'
import { bareReferenceNumber } from './github-refs'
import { fenceInlineSvg } from './inline-svg'
import { fenceBracketMath } from './maths'
import { remarkPlugins } from './remark'
import { BlockCode } from './code-frame'
import { MarkdownTable } from './markdown-table'
import {
  KeepInPlace,
  saveParts,
  savedParts,
  useRenderedChunks,
  type SavedParts,
  type Slot,
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
    cjk,
  }
}

type Plugins = ReturnType<typeof createPlugins>

// One set per pair of code themes, shared by every chunk: Streamdown's context depends on it, and
// a new object would re-render every code block.
const pluginsByThemes = new Map<string, Plugins>()

function pluginsFor(themes: CodeThemes): Plugins {
  const key = `${themes.light} ${themes.dark}`
  let plugins = pluginsByThemes.get(key)
  if (!plugins) {
    plugins = createPlugins(themes)
    pluginsByThemes.set(key, plugins)
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
  if (unopened !== null) return <span title={unopened}>{props.children}</span>
  // A link still streaming in, drawn as a link that opens nothing.
  if (raw === INCOMPLETE_LINK) return <span className="thread-link">{props.children}</span>
  const bare = bareReferenceNumber(raw)
  if (bare !== null) return <BareReference number={bare}>{props.children}</BareReference>
  if (!isWebLink(raw)) return <span title={raw}>{props.children}</span>
  return <ConfirmedLink url={raw}>{props.children}</ConfirmedLink>
}

/**
 * An image: a local file from the media scheme, a remote one as a link to it, since the CSP
 * loads nothing remote, or a `data:` or `blob:` picture as it comes. Anything else, such as
 * `//host/x.png`, would resolve against the page, so it stays text.
 */
function MarkdownImage(props: ComponentProps<'img'> & ExtraProps) {
  const src = typeof props.src === 'string' ? props.src : ''
  const local = localImageTarget(src)
  if (local !== null) return <LocalMedia key={local} path={local} alt={props.alt ?? ''} image />
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
  if (!enabled || paths.length === 0) return null
  const shown = claim && named ? named.shown(claim) : []
  return (
    // Empty until it shows a file, which hides it (globals.css).
    <div ref={ref} data-media-block="" className="flex flex-col items-start gap-3">
      <MediaRows paths={shown} />
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

// The alerts are marked after the sanitizer, which would drop the mark.
const rehypePlugins: NonNullable<StreamdownProps['rehypePlugins']> = [
  ...Object.values(defaultRehypePlugins),
  githubAlerts,
]

// The link component opens links itself (web-link.tsx), so Streamdown's own check stays off.
const linkSafety = { enabled: false }

// The blocks and tables draw their own actions (code-frame.tsx, markdown-table.tsx).
const controls = false

/**
 * The text's chunks, kept from the previous render while the text only grows. A long message's are
 * kept while it is not shown too, with the places its chunks were laid out at (in-parts.ts).
 */
function useChunks(markdown: string, key: string | null): SavedParts {
  const [split, setSplit] = useState<SavedParts>(() => {
    const kept = savedParts(key, markdown)
    const chunks = splitIntoChunks(markdown, kept ?? undefined)
    return { slots: kept?.slots ?? new Map(), markdown, ...chunks }
  })
  if (split.markdown === markdown) return split
  const next = { slots: split.slots, markdown, ...splitIntoChunks(markdown, split) }
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
 * Agent prose. Raw HTML goes through the sanitizer, and an inline `<svg>` is first written as an
 * `svg` code block (`inline-svg.ts`) and a `\[...\]` on lines of its own as a `$$` block
 * (`maths.ts`). A long text renders in chunks (`chunks.ts`), so a streamed update re-renders, lays
 * out and paints the live tail instead of the whole message, and only its chunks near the view
 * render (`in-parts.ts`). Streaming mode splits each chunk into memoized blocks, and the mode never
 * changes: static mode renders one tree, so switching when a message finishes would rebuild all
 * of it. Finishing only turns off incomplete-markdown repair.
 */
function MarkdownImpl({
  markdown,
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
  const split = useChunks(
    useMemo(() => fenceBracketMath(fenceInlineSvg(markdown, live), live), [markdown, live]),
    key,
  )
  const { chunks, slots } = split
  const root = useRef<HTMLDivElement>(null)
  const { view, rendered, slot } = useRenderedChunks(chunks, streaming, root, slots)
  useEffect(() => {
    if (chunks.length > 1) saveParts(key, split)
  }, [key, split, chunks.length])
  const [named] = useState(() => new NamedMedia())
  return (
    <div ref={root} className={cn('markdown', className)}>
      <NamedMediaContext value={named}>
        <KeepInPlace root={root} view={view}>
          {chunks.map((chunk, i) =>
            // By position: when the tail settles, the chunk in its place keeps its rendered blocks.
            rendered(i) ? (
              <Chunk
                key={i}
                markdown={chunk}
                live={live}
                components={customComponents}
                remarkPlugins={customRemarkPlugins}
              />
            ) : (
              <ChunkPlaceholder key={i} markdown={chunk} slot={slot(i)} />
            ),
          )}
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
