// Agents' replies as a phone reads them: comfortable type, headings, lists with hanging indents,
// quotes, tables that scroll sideways, and code in cards with their language, a copy button and a
// light tint. A reply still streaming ends in a blinking caret.

import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Linking, ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native'
import { copyText } from '../ui/session/feedback'
import { highlight } from '../ui/session/highlight'
import { G, Icon } from '../ui/session/icons'
import { parseBlocks, inline, type Block, type Inline } from '../ui/session/markdown'
import { MONO, useSessionTokens, type SessionTokens } from '../ui/session/palette'
import { PressScale } from '../ui/session/Press'

export type MarkdownSize = 'body' | 'compact'

interface Look {
  t: SessionTokens
  color: string
  size: MarkdownSize
  body: TextStyle
}

const SIZES: Record<MarkdownSize, { fontSize: number; lineHeight: number; gap: number }> = {
  body: { fontSize: 16, lineHeight: 24, gap: 12 },
  compact: { fontSize: 15, lineHeight: 22, gap: 8 },
}

function openLink(href: string) {
  if (/^(https?:|mailto:)/i.test(href)) void Linking.openURL(href).catch(() => {})
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
        return node.v
      case 'code':
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
        return (
          <Text
            key={i}
            style={{ color: c.tint }}
            onPress={() => openLink(node.href)}
            accessibilityRole="link"
          >
            <Runs nodes={node.c} look={look} />
          </Text>
        )
      case 'image':
        return (
          <Text key={i} style={{ color: c.tint }} onPress={() => openLink(node.href)}>
            {`［图片${node.alt ? `：${node.alt}` : ''}］`}
          </Text>
        )
    }
  })
}

function Para(props: { text: string; look: Look; style?: TextStyle; tail?: ReactNode }) {
  const nodes = useMemo(() => inline(props.text), [props.text])
  return (
    <Text style={[props.look.body, { color: props.look.color }, props.style]}>
      <Runs nodes={nodes} look={props.look} />
      {props.tail}
    </Text>
  )
}

function CodeBlock(props: { lang: string; text: string; look: Look }) {
  const { c, s } = props.look.t
  const [copied, setCopied] = useState(false)
  const tokens = useMemo(() => highlight(props.text, props.lang), [props.text, props.lang])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = () => {
    void copyText(props.text).then(() => setCopied(true))
  }
  return (
    <View style={[styles.code, { backgroundColor: s.code, borderColor: s.codeBorder }]}>
      <View style={[styles.codeHead, { borderBottomColor: s.codeBorder }]}>
        <Text style={[styles.codeLang, { color: c.textSecondary }]} numberOfLines={1}>
          {props.lang || '代码'}
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
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.codeBody}
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
            : props.text}
        </Text>
      </ScrollView>
    </View>
  )
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
  const cellStyle = (col: number): TextStyle => ({
    width: widths[col],
    textAlign: block.align[col] ?? 'left',
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

const BULLETS = ['•', '◦', '▪']

function Blocks(props: { blocks: Block[]; look: Look; depth: number; tail?: ReactNode }) {
  const { look, depth } = props
  const { c } = look.t
  const gap = SIZES[look.size].gap
  const last = props.blocks.length - 1
  return (
    <View style={{ gap }}>
      {props.blocks.map((block, index) => {
        const tail = index === last ? props.tail : undefined
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
          case 'para':
            return <Para key={index} text={block.text} look={look} tail={tail} />
          case 'code':
            return (
              <View key={index} style={{ gap: 4 }}>
                <CodeBlock lang={block.lang} text={block.text} look={look} />
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
}) {
  const t = useSessionTokens()
  const size = props.size ?? 'body'
  const color = props.color ?? t.c.text
  const parsed = useMemo(() => parseBlocks(props.markdown), [props.markdown])
  const look = useMemo<Look>(
    () => ({
      t,
      color,
      size,
      body: { fontSize: SIZES[size].fontSize, lineHeight: SIZES[size].lineHeight, color },
    }),
    [t.c, t.s, color, size],
  )
  const tail = props.streaming ? <Caret color={t.c.accent} /> : undefined
  if (parsed.length === 0) {
    return tail ? <Text style={look.body}>{tail}</Text> : null
  }
  return <Blocks blocks={parsed} look={look} depth={0} tail={tail} />
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
  codeText: { fontFamily: MONO, fontSize: 13, lineHeight: 20 },
  quote: { borderLeftWidth: 3, paddingLeft: 12, borderRadius: 1 },
  item: { flexDirection: 'row' },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: 'hidden' },
  tableRow: { flexDirection: 'row' },
})
