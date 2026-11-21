// Agents' replies as a phone reads them: comfortable type, headings, lists with hanging indents,
// quotes, tables that scroll sideways with their numbers on the right, and code in cards with their
// language or file, a copy button and a light tint, long ones folded past 20 lines. Links and
// inline code that name a file of the session's folder open it, and an `#anchor` link scrolls to
// its heading. A reply still streaming ends in a caret. A sent prompt's mentions and links read as
// chips.

import {
  memo,
  use,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type ComponentRef,
  type Ref,
} from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native'
import { Image } from 'expo-image'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { cacheFor } from '../ui/memory'
import {
  anchorSlug,
  findHeading,
  headingSlug,
  inlineText,
  keepHeading,
  RevealContext,
  type AnchorTarget,
} from '../ui/session/anchors'
import { findChips, type Chip, type MentionTarget } from '../ui/session/chips'
import { textKey, useDisclosure } from '../ui/session/disclosure'
import { ContextMenu } from '../ui/ContextMenu'
import { LongPressView } from '../ui/LongPressView'
import type { MenuNode } from '../ui/menu'
import { copyText } from '../ui/session/feedback'
import {
  knownFileRef,
  openFile,
  parseFileRef,
  useFileRefs,
  type FileRefsContext,
} from '../ui/session/fileRefs'
import { showNotice } from '../ui/NoticeBar'
import { highlight } from '../ui/session/highlight'
import { G, Icon } from '../ui/session/icons'
import {
  keepBlocks,
  parseBlocks,
  inline,
  streamBlocks,
  type Block,
  type Inline,
  type Settled,
} from '../ui/session/markdown'
import { MONO, useSessionTokens, type SessionTokens } from '../ui/session/palette'
import { PressScale } from '../ui/session/Press'
import { selectText } from '../ui/session/SelectText'
import { openUrl } from '../system/openUrl'

export type MarkdownSize = 'body' | 'compact'

/** How a sent prompt's mentions resolve, and what a chip opens. */
export interface MarkdownChips {
  resolve(token: string): MentionTarget | null
  onOpen(chip: Chip): void
}

interface Look {
  t: SessionTokens
  color: string
  size: MarkdownSize
  body: TextStyle
  /** Where a picture's target lies, for a paragraph that is one picture; null shows its label. */
  image?: (href: string) => string | null
  /** Opens a link; links open as the session's file refs say, or in the browser, without one. */
  link?: (href: string) => void
  refs: FileRefsContext | null
  chips: MarkdownChips | null
  /** The text whose headings a `#anchor` link goes to. */
  scope: string
  /** Brings a heading into view; null where the screen cannot. */
  reveal: ((target: AnchorTarget) => void) | null
}

const SIZES: Record<MarkdownSize, { fontSize: number; lineHeight: number; gap: number }> = {
  body: { fontSize: 16, lineHeight: 24, gap: 12 },
  compact: { fontSize: 15, lineHeight: 22, gap: 8 },
}
/** Room between a list's items. */
const ITEM_GAP: Record<MarkdownSize, number> = { body: 8, compact: 5 }

/**
 * The room above a part of a long reply (splitReply), as the whole reply left it there: between
 * two blocks, or between two items of a list cut there.
 */
export function partGap(joint: 'block' | 'item', size: MarkdownSize = 'body'): number {
  return joint === 'item' ? ITEM_GAP[size] : SIZES[size].gap
}

/** Blocks longer than this many lines start folded, showing FOLDED_LINES of them. */
const FOLD_OVER = 20
const FOLDED_LINES = 7

const SCHEME = /^[a-z][a-z\d+.-]*:/i

/**
 * Opens a link: a file of the session's folder on the file screen, a web address in the browser.
 * A link that looks tappable never does nothing: one that leads nowhere the phone can go says so.
 */
function openLink(href: string, refs: FileRefsContext | null) {
  if (href === '') return
  const local = !SCHEME.test(href) || /^file:/i.test(href)
  if (local || /^[a-z]:[\\/]/i.test(href)) {
    // A file of the folder opens even before the folder's list came, which may never come.
    const ref = knownFileRef(href, refs) ?? (refs?.root ? parseFileRef(href, refs.root) : null)
    if (ref && refs) openFile(refs.sessionId, ref.path, ref.line)
    else showNotice({ text: '这个文件不在会话的文件夹里，请在电脑上查看' })
    return
  }
  openUrl(href)
}

/** Follows a link: an `#anchor` to its heading in the same text, any other as openLink does. */
function follow(href: string, look: Look) {
  if (!href.startsWith('#')) {
    if (look.link) look.link(href)
    else openLink(href, look.refs)
    return
  }
  const target = href.length > 1 ? findHeading(look.scope, anchorSlug(href)) : null
  if (target && look.reveal) look.reveal(target)
  else showNotice({ text: '没找到这一节，请滑动查找' })
}

/**
 * A run with a background, padded and spaced so that a line never ends in a space of its own: iOS
 * draws a space a line ends in out to the line's end, so code that wrapped left an empty block of
 * its tint at the end of the line before. Its spaces are non-breaking, each after a zero-width
 * space where the line may break, and a zero-width space before it lets the line break there too.
 */
function tinted(text: string): string {
  return `\u00A0${text.replace(/ /g, '\u200B\u00A0')}\u00A0`
}
const BREAK = '\u200B'

/** A chip's words: a file's name and lines, a folder with its slash, a link's host and path. */
function chipWords(chip: Chip): string {
  if (chip.kind === 'link') {
    const path = chip.path.length > 28 ? `${chip.path.slice(0, 27)}…` : chip.path
    return `${chip.host}${path}`
  }
  return chip.lines ? `${chip.label}:${chip.lines}` : chip.label
}

/** Text with its mentions and links as chips, when the Markdown reads a sent prompt. */
function ChipRuns(props: { text: string; look: Look }): ReactNode {
  const { look } = props
  const chips = look.chips!
  const found = findChips(props.text, chips.resolve)
  if (found.length === 0) return props.text
  const { c, s } = look.t
  const out: ReactNode[] = []
  let at = 0
  for (const chip of found) {
    out.push(`${props.text.slice(at, chip.from)}${BREAK}`)
    out.push(
      <Text
        key={chip.from}
        onPress={() => chips.onOpen(chip)}
        accessibilityRole={chip.kind === 'link' ? 'link' : 'button'}
        accessibilityLabel={props.text.slice(chip.from, chip.to)}
        style={{ color: c.tint, backgroundColor: s.inlineCode, fontWeight: '500' }}
      >
        {tinted(
          `${chip.kind === 'link' ? '' : chip.kind === 'folder' ? '▸ ' : '@'}${chipWords(chip)}`,
        )}
      </Text>,
    )
    at = chip.to
  }
  if (at < props.text.length) out.push(props.text.slice(at))
  return out
}

/**
 * The end of a reply still being written. It stands still: in the reply's last line, each blink
 * laid the whole paragraph out again twice a second.
 */
function Caret(props: { color: string }) {
  return <Text style={{ color: props.color }}> ▍</Text>
}

function Runs(props: { nodes: Inline[]; look: Look }): ReactNode {
  const { look } = props
  const { c, s } = look.t
  return props.nodes.map((node, i) => {
    switch (node.t) {
      case 'text':
        return look.chips ? <ChipRuns key={i} text={node.v} look={look} /> : node.v
      case 'code': {
        // Code that names a file of the session's folder opens it, as the desktop's file links.
        const ref = knownFileRef(node.v, look.refs)
        if (ref && look.refs) {
          const refs = look.refs
          return [
            BREAK,
            <Text
              key={i}
              onPress={() => openFile(refs.sessionId, ref.path, ref.line)}
              accessibilityRole="link"
              style={{
                fontFamily: MONO,
                fontSize: look.body.fontSize! - 2.5,
                backgroundColor: s.inlineCode,
                color: c.tint,
              }}
            >
              {tinted(node.v)}
            </Text>,
          ]
        }
        return [
          BREAK,
          <Text
            key={i}
            // In Huli's orange on its soft tint, as Kettu sets inline code: plain text on gray read
            // as a block of stripes in a list of names.
            style={{
              fontFamily: MONO,
              fontSize: look.body.fontSize! - 2.5,
              backgroundColor: s.accentSoft,
              color: c.accent,
            }}
          >
            {tinted(node.v)}
          </Text>,
        ]
      }
      case 'strong':
        return (
          <Text key={i} style={{ fontWeight: '700' }}>
            <Runs nodes={node.c} look={look} />
          </Text>
        )
      case 'em':
        return (
          <Text key={i} style={{ fontStyle: 'italic' }}>
            <Runs nodes={node.c} look={look} />
          </Text>
        )
      case 'del':
        return (
          <Text key={i} style={{ textDecorationLine: 'line-through', color: c.textSecondary }}>
            <Runs nodes={node.c} look={look} />
          </Text>
        )
      case 'link':
        // A bare address in a sent prompt reads as the composer's link chip.
        if (look.chips && node.c.length === 1 && node.c[0]!.t === 'text') {
          const text = node.c[0]!.v
          if (text === node.href) return <ChipRuns key={i} text={text} look={look} />
        }
        return (
          <Text
            key={i}
            style={{ color: c.tint }}
            onPress={() => follow(node.href, look)}
            accessibilityRole="link"
          >
            <Runs nodes={node.c} look={{ ...look, chips: null }} />
          </Text>
        )
      case 'image':
        return (
          <Text key={i} style={{ color: c.tint }} onPress={() => follow(node.href, look)}>
            {`［图片${node.alt ? `：${node.alt}` : ''}］`}
          </Text>
        )
    }
  })
}

function Para(props: {
  text: string
  look: Look
  style?: TextStyle
  tail?: ReactNode
  head?: ReactNode
  textRef?: Ref<ComponentRef<typeof Text>>
}) {
  const nodes = useMemo(() => inline(props.text), [props.text])
  return (
    <Text ref={props.textRef} style={[props.look.body, { color: props.look.color }, props.style]}>
      {props.head}
      <Runs nodes={nodes} look={props.look} />
      {props.tail}
    </Text>
  )
}

/** A heading, kept while mounted for the `#anchor` links of the same text to go to. */
function Heading(props: { text: string; look: Look; style: TextStyle; tail?: ReactNode }) {
  const ref = useRef<ComponentRef<typeof Text>>(null)
  const slug = useMemo(() => headingSlug(inlineText(inline(props.text))), [props.text])
  const { scope } = props.look
  useEffect(() => {
    const target = ref.current
    if (!slug || !target) return
    return keepHeading(scope, slug, target)
  }, [scope, slug])
  return <Para {...props} textRef={ref} />
}

const QUOTED = /\b(?:title|file|filename|name)=(?:"([^"]+)"|'([^']+)'|(\S+))/
const PATHLIKE = /^(?:[\w.~@-]+[\\/])*[\w.@-]*\.[\w-]+$|^(?:[\w.~@-]+[\\/])+[\w.@-]+$/

/** The file a fence names: `title="src/a.ts"`, a path in its meta, or `ts:src/a.ts`. */
function fenceFileName(language: string, meta: string): string | null {
  const colon = language.indexOf(':')
  if (colon > 0 && colon < language.length - 1) return language.slice(colon + 1)
  if (!meta) return null
  const quoted = QUOTED.exec(meta)
  if (quoted) return quoted[1] ?? quoted[2] ?? quoted[3] ?? null
  for (const word of meta.trim().split(/\s+/)) {
    if (word.startsWith('{') || word.includes('=')) continue
    if (PATHLIKE.test(word)) return word
  }
  return null
}

function CodeBlock(props: { lang: string; meta: string; text: string; look: Look }) {
  const { c, s } = props.look.t
  const [copied, setCopied] = useState(false)
  const [folded, setFolded] = useDisclosure(`code-folded:${textKey(props.text)}`, true)
  const colon = props.lang.indexOf(':')
  const language = colon > 0 ? props.lang.slice(0, colon) : props.lang
  const file = fenceFileName(props.lang, props.meta)
  const start = /\bstartLine=(\d+)/.exec(props.meta)
  const firstLine = start ? Number(start[1]) : null
  const lines = useMemo(() => props.text.replace(/\n$/, '').split('\n'), [props.text])
  const foldable = lines.length > FOLD_OVER
  const shown =
    foldable && folded ? lines.slice(0, FOLDED_LINES).join('\n') : props.text.replace(/\n$/, '')
  const shownCount = foldable && folded ? FOLDED_LINES : lines.length
  // Colored once the list is idle: a block that mounts as the conversation scrolls draws plain
  // text first, and its colors follow in a render that waits for a quiet moment.
  const colored = useDeferredValue(shown, null)
  const highlighted = useMemo(
    () => (colored === null ? null : highlight(colored, language)),
    [colored, language],
  )
  const tokens = colored === shown ? highlighted : null
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = () => {
    void copyText(props.text, null).then(setCopied)
  }
  const refs = props.look.refs
  const fileRef = file ? knownFileRef(file, refs) : null
  const menu: MenuNode[] = [
    { key: 'copy', label: '复制代码', icon: 'doc.on.doc', onPress: copy },
    {
      key: 'select',
      label: '选择文本',
      icon: 'character.cursor.ibeam',
      onPress: () => selectText({ text: props.text.replace(/\n$/, ''), mono: true }),
    },
  ]
  const head = (
    <View style={[styles.codeHead, { borderBottomColor: s.codeBorder }]}>
      <Text
        style={[
          styles.codeLang,
          { color: fileRef ? c.tint : c.textSecondary, flexShrink: 1 },
          file ? { textTransform: 'none' } : null,
        ]}
        numberOfLines={1}
        ellipsizeMode="head"
        {...(fileRef && refs
          ? { onPress: () => openFile(refs.sessionId, fileRef.path, firstLine ?? fileRef.line) }
          : {})}
      >
        {file ?? (language || '代码')}
      </Text>
      <PressScale
        onPress={copy}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="复制代码"
        style={styles.codeCopy}
      >
        <Icon
          icon={copied ? G.copied : G.copy}
          size={13}
          color={copied ? c.success : c.textSecondary}
        />
        <Text style={[styles.codeLang, { color: copied ? c.success : c.textSecondary }]}>
          {copied ? '已复制' : '复制'}
        </Text>
      </PressScale>
    </View>
  )
  const rowContent = (
    <>
      {firstLine !== null && (
        <Text style={[styles.codeText, styles.gutter, { color: c.textTertiary }]}>
          {Array.from({ length: shownCount }, (_, i) => firstLine + i).join('\n')}
        </Text>
      )}
      {/* The rest of the row and no wider, so lines longer than it scroll rather than run past
          the block's edge, where it clips them. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.codeScroll}
        contentContainerStyle={[styles.codeBody, firstLine !== null && { paddingLeft: 8 }]}
      >
        <Text style={[styles.codeText, { color: c.text }]}>
          {tokens
            ? tokens.map((token, i) =>
                token.kind === 'plain' ? (
                  token.text
                ) : (
                  <Text
                    key={i}
                    style={{
                      color: s.syntax[token.kind],
                      fontStyle: token.kind === 'comment' ? 'italic' : 'normal',
                    }}
                  >
                    {token.text}
                  </Text>
                ),
              )
            : shown}
        </Text>
      </ScrollView>
    </>
  )
  const rowStyle = [styles.codeRow, { backgroundColor: s.code }]
  return (
    <View style={[styles.code, { backgroundColor: s.code, borderColor: s.codeBorder }]}>
      {head}
      <ContextMenu items={menu}>
        {(longPress) => (
          <LongPressView onLongPress={longPress} delayLongPress={350} style={rowStyle}>
            {rowContent}
          </LongPressView>
        )}
      </ContextMenu>
      {foldable && (
        <Pressable
          onPress={() => {
            setFolded((v) => !v)
          }}
          accessibilityRole="button"
          accessibilityState={{ expanded: !folded }}
          style={({ pressed }) => [
            styles.codeMore,
            { borderTopColor: s.codeBorder, opacity: pressed ? 0.6 : 1 },
          ]}
        >
          <Icon
            icon={G.down}
            size={11}
            color={c.tint}
            style={folded ? undefined : { transform: [{ rotate: '180deg' }] }}
          />
          <Text style={[styles.codeMoreText, { color: c.tint }]}>
            {folded ? `再显示 ${lines.length - FOLDED_LINES} 行` : '收起'}
          </Text>
        </Pressable>
      )}
    </View>
  )
}

// A count, an amount or a measure: an optional sign or currency, digits with separators, a
// fraction, and a short unit such as %, ms, KB or x.
const NUMBER = /^[+\-−±~≈]?\s?[$€£¥]?\d[\d,_\u2009 ]*(?:\.\d+)?\s?(?:%|[a-zA-Zµ]{1,3}|×)?$/

/** The columns whose body cells are all numbers, empty ones aside, that the Markdown leaves unaligned. */
function numericColumns(block: Extract<Block, { kind: 'table' }>): Set<number> {
  const numeric = new Set<number>()
  for (let column = 0; column < block.head.length; column++) {
    if (block.align[column]) continue
    const values = block.rows
      .map((row) => (row[column] ?? '').replace(/[*`_~]/g, '').trim())
      .filter((value) => value !== '')
    if (values.length > 0 && values.every((value) => NUMBER.test(value))) numeric.add(column)
  }
  return numeric
}

/** A rough width for a column, from its longest cell; wide characters count twice. */
function columnWidth(texts: string[]): number {
  let longest = 0
  for (const text of texts) {
    let units = 0
    for (const ch of text.replace(/[*`_~]/g, '')) units += ch.charCodeAt(0) > 0x2e80 ? 2 : 1
    longest = Math.max(longest, units)
  }
  return Math.min(260, Math.max(64, longest * 7.6 + 24))
}

/** How wide the soft edge is that says a wide table goes on past the box. */
const TABLE_FADE = 24

/** A soft edge of the page's color over a table's side, toward the cells cut off there. */
function TableFade(props: { side: 'left' | 'right'; color: string }) {
  const id = `table-fade-${props.side}`
  return (
    <Svg
      pointerEvents="none"
      width={TABLE_FADE}
      height="100%"
      style={[styles.tableFade, props.side === 'left' ? { left: 0 } : { right: 0 }]}
    >
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor={props.color} stopOpacity={props.side === 'left' ? 1 : 0} />
          <Stop offset="1" stopColor={props.color} stopOpacity={props.side === 'left' ? 0 : 1} />
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  )
}

/**
 * A table in its rounded box, whose edges always show: a narrow one fills the width, its columns
 * shared out by their contents; a wider one keeps each column wide enough for its cells and
 * scrolls sideways inside the box, with a soft edge on the side that has more.
 */
function Table(props: { block: Extract<Block, { kind: 'table' }>; look: Look }) {
  const { block, look } = props
  const { c } = look.t
  const widths = useMemo(
    () => block.head.map((h, col) => columnWidth([h, ...block.rows.map((r) => r[col] ?? '')])),
    [block],
  )
  const numeric = useMemo(() => numericColumns(block), [block])
  const [box, setBox] = useState(0)
  const [content, setContent] = useState(0)
  const [edges, setEdges] = useState({ start: true, end: false })
  const scrolls = box > 0 && content > box + 1
  const cellStyle = (col: number): TextStyle => ({
    flexBasis: widths[col],
    flexGrow: widths[col],
    flexShrink: 0,
    textAlign: block.align[col] ?? (numeric.has(col) ? 'right' : 'left'),
    fontVariant: numeric.has(col) ? ['tabular-nums'] : [],
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 10,
    paddingVertical: 8,
  })
  return (
    <View
      style={[styles.table, { borderColor: c.border }]}
      onLayout={(event) => setBox(event.nativeEvent.layout.width)}
    >
      <ScrollView
        horizontal
        bounces={scrolls}
        showsHorizontalScrollIndicator={scrolls}
        contentContainerStyle={styles.tableContent}
        onContentSizeChange={(width) => setContent(width)}
        scrollEventThrottle={32}
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
          const start = contentOffset.x <= 1
          const end = contentOffset.x + layoutMeasurement.width >= contentSize.width - 1
          setEdges((was) => (was.start === start && was.end === end ? was : { start, end }))
        }}
      >
        <View style={styles.tableContent}>
          <View style={[styles.tableRow, { backgroundColor: c.fill }]}>
            {block.head.map((cell, col) => (
              <Para
                key={col}
                text={cell}
                look={look}
                style={{ ...cellStyle(col), fontWeight: '600' }}
              />
            ))}
          </View>
          {block.rows.map((row, r) => (
            <View
              key={r}
              style={[
                styles.tableRow,
                { borderTopColor: c.border, borderTopWidth: StyleSheet.hairlineWidth },
              ]}
            >
              {block.head.map((_, col) => (
                <Para key={col} text={row[col] ?? ''} look={look} style={cellStyle(col)} />
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
      {scrolls && !edges.start && <TableFade side="left" color={c.bg} />}
      {scrolls && !edges.end && <TableFade side="right" color={c.bg} />}
    </View>
  )
}

/** The picture a paragraph is, alone but for spaces, where `resolve` finds it. */
function solePicture(
  text: string,
  resolve: (href: string) => string | null,
): { uri: string; alt: string } | null {
  const nodes = inline(text).filter((node) => !(node.t === 'text' && node.v.trim() === ''))
  const node = nodes.length === 1 ? nodes[0]! : null
  if (node?.t !== 'image') return null
  const uri = resolve(node.href)
  return uri ? { uri, alt: node.alt } : null
}

function Picture(props: { uri: string; alt: string }) {
  const { c } = useSessionTokens()
  const [ratio, setRatio] = useState<number | null>(null)
  return (
    <Image
      source={{ uri: props.uri }}
      accessibilityLabel={props.alt || '图片'}
      accessibilityIgnoresInvertColors
      contentFit="contain"
      cachePolicy={cacheFor(props.uri)}
      transition={120}
      onLoad={(event) => {
        const { width, height } = event.source
        if (width > 0 && height > 0) setRatio(width / height)
      }}
      style={{
        width: '100%',
        aspectRatio: ratio ?? 16 / 9,
        borderRadius: 10,
        backgroundColor: ratio ? undefined : c.fill,
      }}
    />
  )
}

const BULLETS = ['•', '◦', '▪']

function Blocks(props: {
  blocks: Block[]
  look: Look
  depth: number
  tail?: ReactNode
  /** What leads the first paragraph, such as a sent prompt's command. */
  head?: ReactNode
  /** The blocks go on from others above, as a later part of a long reply. */
  continues?: boolean
}) {
  const { look, depth } = props
  const gap = SIZES[look.size].gap
  const last = props.blocks.length - 1
  const from = props.continues ? 1 : 0
  return (
    <View style={{ gap }}>
      {props.blocks.map((block, index) => (
        <BlockItem
          key={index}
          block={block}
          index={from + index}
          look={look}
          depth={depth}
          tail={index === last ? props.tail : undefined}
          head={index === 0 ? props.head : undefined}
        />
      ))}
    </View>
  )
}

/**
 * One block, which redraws only when it changed: while a reply streams in, the blocks before the
 * one being written keep their objects (keepBlocks) and are passed by.
 */
const BlockItem = memo(function BlockItem(props: {
  block: Block
  index: number
  look: Look
  depth: number
  tail: ReactNode | undefined
  head: ReactNode | undefined
}) {
  const { block, index, look, depth, tail } = props
  const { c } = look.t
  if (index === 0 && props.head && block.kind === 'para') {
    return <Para text={block.text} look={look} tail={tail} head={props.head} />
  }
  switch (block.kind) {
    case 'heading': {
      const big = look.size === 'body'
      const fontSize =
        block.level === 1
          ? big
            ? 21
            : 18
          : block.level === 2
            ? big
              ? 18.5
              : 16.5
            : look.body.fontSize!
      return (
        <Heading
          text={block.text}
          look={look}
          tail={tail}
          style={{
            fontSize,
            lineHeight: Math.round(fontSize * 1.4),
            fontWeight: block.level <= 3 ? '700' : '600',
            marginTop: index > 0 && block.level <= 2 ? 6 : 0,
          }}
        />
      )
    }
    case 'para': {
      const picture = look.image ? solePicture(block.text, look.image) : null
      if (picture) return <Picture uri={picture.uri} alt={picture.alt} />
      return <Para text={block.text} look={look} tail={tail} />
    }
    case 'code':
      return (
        <View style={{ gap: 4 }}>
          <CodeBlock lang={block.lang} meta={block.meta} text={block.text} look={look} />
          {tail ? <Text style={look.body}>{tail}</Text> : null}
        </View>
      )
    case 'rule':
      return (
        <View
          style={{
            height: StyleSheet.hairlineWidth,
            backgroundColor: c.borderStrong,
            marginVertical: 4,
          }}
        />
      )
    case 'quote':
      return (
        <View style={[styles.quote, { borderLeftColor: c.borderStrong }]}>
          <Blocks
            blocks={block.blocks}
            look={{ ...look, color: c.textSecondary }}
            depth={depth}
            tail={tail}
          />
        </View>
      )
    case 'table':
      return (
        <View style={{ gap: 4 }}>
          <Table block={block} look={look} />
          {tail ? <Text style={look.body}>{tail}</Text> : null}
        </View>
      )
    case 'list': {
      const lastNumber = block.start + block.items.length - 1
      const marker = block.ordered
        ? String(lastNumber).length * (look.body.fontSize! * 0.6) + 14
        : 18
      const itemLast = block.items.length - 1
      return (
        <View style={{ gap: ITEM_GAP[look.size] }}>
          {block.items.map((item, i) => (
            <View key={i} style={styles.item}>
              <View style={{ width: marker }}>
                {item.task !== null ? (
                  <View style={{ height: look.body.lineHeight, justifyContent: 'center' }}>
                    <Icon
                      icon={item.task ? G.done : G.todo}
                      size={16}
                      color={item.task ? c.success : c.textTertiary}
                    />
                  </View>
                ) : (
                  <Text
                    style={[
                      look.body,
                      {
                        color: c.textSecondary,
                        fontVariant: ['tabular-nums'],
                        fontWeight: block.ordered ? '500' : '700',
                      },
                    ]}
                  >
                    {block.ordered
                      ? `${block.start + i}.`
                      : BULLETS[Math.min(depth, BULLETS.length - 1)]}
                  </Text>
                )}
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Blocks
                  blocks={item.blocks}
                  look={item.task ? { ...look, color: c.textSecondary } : look}
                  depth={depth + 1}
                  tail={i === itemLast ? tail : undefined}
                />
              </View>
            </View>
          ))}
        </View>
      )
    }
  }
})

/** How often at most a reply being written is read into blocks again. */
const STREAM_PARSE_EVERY = 100
/** Finished texts read into blocks, kept for when their rows mount again; the oldest go first. */
const PARSED_KEPT = 200
const parsedTexts = new Map<string, Block[]>()

function parseKept(source: string): Block[] {
  const known = parsedTexts.get(source)
  if (known) {
    parsedTexts.delete(source)
    parsedTexts.set(source, known)
    return known
  }
  const blocks = parseBlocks(source)
  parsedTexts.set(source, blocks)
  if (parsedTexts.size > PARSED_KEPT) parsedTexts.delete(parsedTexts.keys().next().value!)
  return blocks
}

/** `text`, but while `every` is set no more often than that: the latest arrives after the wait. */
function useThrottled(text: string, every: number): string {
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const shown = useRef({ text, at: 0 })
  const now = Date.now()
  if (shown.current.text !== text && (every === 0 || now - shown.current.at >= every)) {
    shown.current = { text, at: now }
  }
  const behind = shown.current.text !== text
  useEffect(() => {
    if (!behind) return
    const timer = setTimeout(redraw, Math.max(0, shown.current.at + every - Date.now()))
    return () => clearTimeout(timer)
  })
  return shown.current.text
}

/**
 * A text's blocks. A finished one is read once and kept; a streaming one is read at most every
 * STREAM_PARSE_EVERY, and the blocks it had already keep their objects, so only the one being
 * written redraws.
 */
function useBlocks(markdown: string, streaming: boolean): Block[] {
  const shown = useThrottled(markdown, streaming ? STREAM_PARSE_EVERY : 0)
  const before = useRef<Block[]>([])
  const settled = useRef<Settled | null>(null)
  return useMemo(() => {
    const blocks = keepBlocks(
      before.current,
      streaming ? streamBlocks(shown, settled) : parseKept(shown),
    )
    if (!streaming) settled.current = null
    before.current = blocks
    return blocks
  }, [shown, streaming])
}

export const Markdown = memo(function Markdown(props: {
  markdown: string
  /** Still being written: a caret stands at its end. */
  streaming?: boolean
  size?: MarkdownSize
  color?: string
  /** Shows a paragraph that is one picture as the picture, where this finds its address. */
  image?: (href: string) => string | null
  /** Opens a link instead of the browser. */
  onLink?: (href: string) => void
  /** A sent prompt's mentions and links, read as chips. */
  chips?: MarkdownChips
  /** What leads the text, such as a sent prompt's command. */
  head?: ReactNode
  /** The text goes on from a part above it, as a later part of a long reply does. */
  continues?: boolean
  /** What the text is part of, such as a long reply drawn in parts, for its `#anchor` links. */
  anchors?: string
}) {
  const t = useSessionTokens()
  const refs = useFileRefs()
  const reveal = use(RevealContext)
  const own = useId()
  const scope = props.anchors ?? own
  const size = props.size ?? 'body'
  const color = props.color ?? t.c.text
  const parsed = useBlocks(props.markdown, !!props.streaming)
  const look = useMemo<Look>(
    () => ({
      t,
      color,
      size,
      body: { fontSize: SIZES[size].fontSize, lineHeight: SIZES[size].lineHeight, color },
      image: props.image,
      link: props.onLink,
      refs,
      chips: props.chips ?? null,
      scope,
      reveal,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t.c, t.s, color, size, props.image, props.onLink, refs, props.chips, scope, reveal],
  )
  const tail = useMemo(
    () => (props.streaming ? <Caret color={t.c.accent} /> : undefined),
    [props.streaming, t.c.accent],
  )
  if (parsed.length === 0) {
    return tail || props.head ? (
      <Text style={look.body}>
        {props.head}
        {tail}
      </Text>
    ) : null
  }
  if (props.head && parsed[0]!.kind !== 'para') {
    return (
      <View style={{ gap: SIZES[size].gap }}>
        <Text style={look.body}>{props.head}</Text>
        <Blocks blocks={parsed} look={look} depth={0} tail={tail} />
      </View>
    )
  }
  return (
    <Blocks
      blocks={parsed}
      look={look}
      depth={0}
      tail={tail}
      head={props.head}
      {...(props.continues ? { continues: true } : {})}
    />
  )
})

const styles = StyleSheet.create({
  code: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  codeHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 12,
    paddingRight: 10,
    height: 34,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  codeLang: { fontSize: 12, fontWeight: '500', textTransform: 'lowercase' },
  codeCopy: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
  codeBody: { paddingHorizontal: 12, paddingVertical: 10 },
  codeRow: { flexDirection: 'row' },
  codeScroll: { flex: 1 },
  gutter: {
    paddingLeft: 10,
    paddingVertical: 10,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  codeText: { fontFamily: MONO, fontSize: 13, lineHeight: 20 },
  codeMore: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    height: 34,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  codeMoreText: { fontSize: 12.5, fontWeight: '600' },
  quote: { borderLeftWidth: 3, paddingLeft: 12, borderRadius: 1 },
  item: { flexDirection: 'row' },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: 'hidden' },
  tableContent: { flexGrow: 1 },
  tableFade: { position: 'absolute', top: 0, bottom: 0 },
  tableRow: { flexDirection: 'row' },
})
