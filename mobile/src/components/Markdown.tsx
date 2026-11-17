// Agents' replies as a phone reads them: comfortable type, headings, lists with hanging indents,
// quotes, tables that scroll sideways with their numbers on the right, and code in cards with their
// language or file, a copy button and a light tint, long ones folded past 20 lines. Links and
// inline code that name a file of the session's folder open it. A reply still streaming ends in a
// blinking caret. A sent prompt's mentions and links read as chips.

import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type TextStyle,
} from 'react-native'
import { Image } from 'expo-image'
import { findChips, type Chip, type MentionTarget } from '../ui/session/chips'
import { copyText } from '../ui/session/feedback'
import { knownFileRef, openFile, useFileRefs, type FileRefsContext } from '../ui/session/fileRefs'
import { highlight } from '../ui/session/highlight'
import { G, Icon } from '../ui/session/icons'
import { parseBlocks, inline, type Block, type Inline } from '../ui/session/markdown'
import { MONO, useSessionTokens, type SessionTokens } from '../ui/session/palette'
import { gentle, PressScale } from '../ui/session/Press'

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
}

const SIZES: Record<MarkdownSize, { fontSize: number; lineHeight: number; gap: number }> = {
  body: { fontSize: 16, lineHeight: 24, gap: 12 },
  compact: { fontSize: 15, lineHeight: 22, gap: 8 },
}

/** Blocks longer than this many lines start folded, showing FOLDED_LINES of them. */
const FOLD_OVER = 20
const FOLDED_LINES = 7

const SCHEME = /^[a-z][a-z\d+.-]*:/i

/** Opens a link: a file of the session's folder on the file screen, a web address in the browser. */
function openLink(href: string, refs: FileRefsContext | null) {
  const local = href !== '' && !href.startsWith('#') && (!SCHEME.test(href) || /^file:/i.test(href))
  if (local || /^[a-z]:[\\/]/i.test(href)) {
    const ref = knownFileRef(href, refs)
    if (ref && refs) openFile(refs.sessionId, ref.path, ref.line)
    return
  }
  if (/^(https?:|mailto:)/i.test(href)) void Linking.openURL(href).catch(() => {})
}

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
    if (chip.from > at) out.push(props.text.slice(at, chip.from))
    out.push(
      <Text
        key={chip.from}
        onPress={() => chips.onOpen(chip)}
        accessibilityRole={chip.kind === 'link' ? 'link' : 'button'}
        accessibilityLabel={props.text.slice(chip.from, chip.to)}
        style={{ color: c.tint, backgroundColor: s.inlineCode, fontWeight: '500' }}
      >
        {` ${chip.kind === 'link' ? '' : chip.kind === 'folder' ? '▸ ' : '@'}${chipWords(chip)} `}
      </Text>,
    )
    at = chip.to
  }
  if (at < props.text.length) out.push(props.text.slice(at))
  return out
}

function Caret(props: { color: string }) {
  const [on, setOn] = useState(true)
  useEffect(() => {
    const timer = setInterval(() => setOn((v) => !v), 530)
    return () => clearInterval(timer)
  }, [])
  return <Text style={{ color: on ? props.color : 'transparent' }}> ▍</Text>
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
          return (
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
              {` ${node.v} `}
            </Text>
          )
        }
        return (
          <Text
            key={i}
            style={{
              fontFamily: MONO,
              fontSize: look.body.fontSize! - 2.5,
              backgroundColor: s.inlineCode,
              color: look.color,
            }}
          >
            {` ${node.v} `}
          </Text>
        )
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
            onPress={() => (look.link ? look.link(node.href) : openLink(node.href, look.refs))}
            accessibilityRole="link"
          >
            <Runs nodes={node.c} look={{ ...look, chips: null }} />
          </Text>
        )
      case 'image':
        return (
          <Text
            key={i}
            style={{ color: c.tint }}
            onPress={() => (look.link ? look.link(node.href) : openLink(node.href, look.refs))}
          >
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
}) {
  const nodes = useMemo(() => inline(props.text), [props.text])
  return (
    <Text style={[props.look.body, { color: props.look.color }, props.style]}>
      {props.head}
      <Runs nodes={nodes} look={props.look} />
      {props.tail}
    </Text>
  )
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
  const [folded, setFolded] = useState(true)
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
  const tokens = useMemo(() => highlight(shown, language), [shown, language])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = () => {
    void copyText(props.text).then(() => setCopied(true))
  }
  const refs = props.look.refs
  const fileRef = file ? knownFileRef(file, refs) : null
  return (
    <View style={[styles.code, { backgroundColor: s.code, borderColor: s.codeBorder }]}>
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
      <View style={styles.codeRow}>
        {firstLine !== null && (
          <Text style={[styles.codeText, styles.gutter, { color: c.textTertiary }]}>
            {Array.from({ length: shownCount }, (_, i) => firstLine + i).join('\n')}
          </Text>
        )}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
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
      </View>
      {foldable && (
        <Pressable
          onPress={() => {
            gentle()
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
const NUMBER = /^[+\-−±~≈]?\s?[$€£¥]?\d[\d,_  ]*(?:\.\d+)?\s?(?:%|[a-zA-Zµ]{1,3}|×)?$/

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

function Table(props: { block: Extract<Block, { kind: 'table' }>; look: Look }) {
  const { block, look } = props
  const { c } = look.t
  const widths = useMemo(
    () => block.head.map((h, col) => columnWidth([h, ...block.rows.map((r) => r[col] ?? '')])),
    [block],
  )
  const numeric = useMemo(() => numericColumns(block), [block])
  const cellStyle = (col: number): TextStyle => ({
    width: widths[col],
    textAlign: block.align[col] ?? (numeric.has(col) ? 'right' : 'left'),
    fontVariant: numeric.has(col) ? ['tabular-nums'] : [],
    fontSize: 14,
    lineHeight: 20,
    paddingHorizontal: 10,
    paddingVertical: 8,
  })
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={[styles.table, { borderColor: c.border }]}>
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
      cachePolicy="memory-disk"
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
}) {
  const { look, depth } = props
  const { c } = look.t
  const gap = SIZES[look.size].gap
  const last = props.blocks.length - 1
  return (
    <View style={{ gap }}>
      {props.blocks.map((block, index) => {
        const tail = index === last ? props.tail : undefined
        if (index === 0 && props.head && block.kind === 'para') {
          return <Para key={index} text={block.text} look={look} tail={tail} head={props.head} />
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
              <Para
                key={index}
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
            if (picture) return <Picture key={index} uri={picture.uri} alt={picture.alt} />
            return <Para key={index} text={block.text} look={look} tail={tail} />
          }
          case 'code':
            return (
              <View key={index} style={{ gap: 4 }}>
                <CodeBlock lang={block.lang} meta={block.meta} text={block.text} look={look} />
                {tail ? <Text style={look.body}>{tail}</Text> : null}
              </View>
            )
          case 'rule':
            return (
              <View
                key={index}
                style={{
                  height: StyleSheet.hairlineWidth,
                  backgroundColor: c.borderStrong,
                  marginVertical: 4,
                }}
              />
            )
          case 'quote':
            return (
              <View key={index} style={[styles.quote, { borderLeftColor: c.borderStrong }]}>
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
              <View key={index} style={{ gap: 4 }}>
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
              <View key={index} style={{ gap: look.size === 'body' ? 8 : 5 }}>
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
      })}
    </View>
  )
}

export const Markdown = memo(function Markdown(props: {
  markdown: string
  /** Still being written: a caret blinks at its end. */
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
}) {
  const t = useSessionTokens()
  const refs = useFileRefs()
  const size = props.size ?? 'body'
  const color = props.color ?? t.c.text
  const parsed = useMemo(() => parseBlocks(props.markdown), [props.markdown])
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
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t.c, t.s, color, size, props.image, props.onLink, refs, props.chips],
  )
  const tail = props.streaming ? <Caret color={t.c.accent} /> : undefined
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
  return <Blocks blocks={parsed} look={look} depth={0} tail={tail} head={props.head} />
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
  tableRow: { flexDirection: 'row' },
})
