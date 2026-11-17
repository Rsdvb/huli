// A small Markdown renderer for agents' replies: fenced code, headings, lists, quotes, and inline
// bold and code. What it does not know shows as the text it is.

import { Fragment } from 'react'
import { Platform, StyleSheet, Text, View } from 'react-native'
import type { Theme } from '../theme'

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' })

type Block =
  | { kind: 'code'; text: string }
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'item'; text: string; marker: string }
  | { kind: 'quote'; text: string }
  | { kind: 'para'; text: string }

function blocks(markdown: string): Block[] {
  const out: Block[] = []
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push({ kind: 'para', text: para.join('\n') })
    para = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = /^\s*(```|~~~)/.exec(line)
    if (fence) {
      flush()
      const code: string[] = []
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!); i++) code.push(lines[i]!)
      out.push({ kind: 'code', text: code.join('\n') })
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (heading) {
      flush()
      out.push({ kind: 'heading', text: heading[2]!, level: heading[1]!.length })
    } else if (item) {
      flush()
      out.push({ kind: 'item', text: item[2]!, marker: /\d/.test(item[1]!) ? item[1]! : '•' })
    } else if (quote) {
      flush()
      out.push({ kind: 'quote', text: quote[1]! })
    } else if (!line.trim()) {
      flush()
    } else para.push(line)
  }
  flush()
  return out
}

function Inline(props: { text: string; theme: Theme }) {
  const parts = props.text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return (
            <Text key={i} style={{ fontWeight: '700' }}>
              {part.slice(2, -2)}
            </Text>
          )
        }
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          return (
            <Text key={i} style={{ fontFamily: MONO, fontSize: 14, backgroundColor: props.theme.line }}>
              {part.slice(1, -1)}
            </Text>
          )
        }
        return <Fragment key={i}>{part}</Fragment>
      })}
    </>
  )
}

export function Markdown(props: { markdown: string; theme: Theme; color?: string }) {
  const { theme } = props
  const color = props.color ?? theme.text
  return (
    <View style={{ gap: 8 }}>
      {blocks(props.markdown).map((block, i) => {
        switch (block.kind) {
          case 'code':
            return (
              <View key={i} style={[styles.code, { backgroundColor: theme.line }]}>
                <Text selectable style={{ fontFamily: MONO, fontSize: 13, color }}>
                  {block.text}
                </Text>
              </View>
            )
          case 'heading':
            return (
              <Text key={i} selectable style={{ color, fontSize: block.level <= 2 ? 18 : 16, fontWeight: '700' }}>
                <Inline text={block.text} theme={theme} />
              </Text>
            )
          case 'item':
            return (
              <View key={i} style={{ flexDirection: 'row', gap: 6 }}>
                <Text style={{ color: theme.muted, fontSize: 15, lineHeight: 22 }}>{block.marker}</Text>
                <Text selectable style={{ flex: 1, color, fontSize: 15, lineHeight: 22 }}>
                  <Inline text={block.text} theme={theme} />
                </Text>
              </View>
            )
          case 'quote':
            return (
              <View key={i} style={{ borderLeftWidth: 3, borderLeftColor: theme.line, paddingLeft: 10 }}>
                <Text selectable style={{ color: theme.muted, fontSize: 15, lineHeight: 22 }}>
                  <Inline text={block.text} theme={theme} />
                </Text>
              </View>
            )
          case 'para':
            return (
              <Text key={i} selectable style={{ color, fontSize: 15, lineHeight: 22 }}>
                <Inline text={block.text} theme={theme} />
              </Text>
            )
        }
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  code: { borderRadius: 8, padding: 10 },
})
