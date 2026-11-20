// One tool call in full: what the agent said it does, its command or input, all of its output in
// monospace with a way to copy each, and the files it edited, each opening to its diff. It follows
// the call while it runs.

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import type { HostEvent } from '@shared/agent-host'
import type { ThreadEntry, ToolEntry } from '@shared/thread'
import { call, sessionFolder } from '../git'
import { hostErrorText } from '../hostErrors'
import { PictureStrip, pictureOf, type Picture } from '../components/Pictures'
import { useLink, useSession } from '../host'
import { SessionRows } from '../ui/session/context'
import { copyText } from '../ui/session/feedback'
import { GlassHeader } from '../ui/session/GlassHeader'
import { G, Icon, TOOL_ICONS } from '../ui/session/icons'
import { MONO, useSessionTokens } from '../ui/session/palette'
import { PressScale } from '../ui/session/Press'
import { selectText } from '../ui/session/SelectText'
import { StateView } from '../ui/session/StateView'
import { answerText, EditLine, target, VERBS } from '../ui/session/ToolRow'
import { toolTitle } from '../ui/session/toolNames'
import { toolEdits } from '../ui/session/turns'
import { fenceBody, numberedRead } from '../ui/session/work'

// What a phone shows of one block of output; past it, the rest is copied rather than drawn.
const SHOWN_CHARS = 60_000

const STATUS: Record<ToolEntry['status'], string> = {
  pending: '等待中',
  in_progress: '运行中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
}

function Block(props: { label: string; text: string; tone?: 'plain' | 'muted' }) {
  const { c, s } = useSessionTokens()
  const [copied, setCopied] = useState(false)
  const long = props.text.length > SHOWN_CHARS
  const select = () => selectText({ text: props.text, mono: true, title: props.label })
  return (
    <View style={{ gap: 6 }}>
      <View style={styles.blockHead}>
        <Text style={[styles.label, { color: c.textSecondary }]}>{props.label}</Text>
        <PressScale
          onPress={select}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`选择${props.label}的文本`}
          style={styles.copy}
        >
          <Icon icon={G.select} size={14} color={c.textSecondary} />
          <Text style={[styles.copyText, { color: c.textSecondary }]}>选择</Text>
        </PressScale>
        <PressScale
          onPress={() =>
            void copyText(props.text, null).then((ok) => {
              if (!ok) return
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`复制${props.label}`}
          style={styles.copy}
        >
          <Icon icon={copied ? G.copied : G.copy} size={14} color={c.textSecondary} />
          <Text style={[styles.copyText, { color: c.textSecondary }]}>
            {copied ? '已复制' : '复制'}
          </Text>
        </PressScale>
      </View>
      <ScrollView
        horizontal
        bounces={false}
        style={[styles.block, { backgroundColor: s.code, borderColor: s.codeBorder }]}
        contentContainerStyle={{ padding: 12 }}
      >
        <Pressable onLongPress={select} delayLongPress={350}>
          <Text style={[styles.mono, { color: props.tone === 'muted' ? c.textSecondary : c.text }]}>
            {long
              ? `${props.text.slice(0, SHOWN_CHARS)}\n…（太长了，复制可以拿到全部）`
              : props.text}
          </Text>
        </Pressable>
      </ScrollView>
    </View>
  )
}

export default function ToolScreen() {
  const { sessionId, entryId } = useLocalSearchParams<{ sessionId: string; entryId: string }>()
  const { c } = useSessionTokens()
  const link = useLink()
  const summary = useSession(sessionId)
  const root = summary && !summary.scratch ? sessionFolder(summary) : null
  const [entry, setEntry] = useState<ThreadEntry | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    call(link, 'sessions.entry', { sessionId, entryId }).then(
      (next) => {
        setEntry(next)
        setError(null)
      },
      (failed: unknown) => setError(hostErrorText(failed, '没能读取这次调用。')),
    )
  }, [link, sessionId, entryId])

  useEffect(load, [load])

  // While it runs, each change of it in the session's patches reads it again.
  const tool = entry?.kind === 'tool' ? entry : null
  const settled = tool !== null && tool.status !== 'pending' && tool.status !== 'in_progress'
  useEffect(() => {
    if (settled) return
    return link.onHostEvent((raw) => {
      const event = raw as HostEvent
      if (event.type !== 'session.patches' || event.batch.sessionId !== sessionId) return
      if (event.batch.patches.some((p) => 'id' in p && p.id === entryId)) load()
    })
  }, [link, sessionId, entryId, settled, load])

  let body: ReactElement
  if (error && !entry) {
    body = <StateView text={error} tone="danger" retry={load} />
  } else if (!entry) {
    body = <StateView loading />
  } else if (!tool) {
    body = <StateView text="这不是一次工具调用。" />
  } else {
    const edits = toolEdits(tool)
    // What it returned as plain text: inside its fence, and a file read without the numbers
    // Claude Code puts before each line, so a copy is the file's own text.
    const outputs = tool.content.flatMap((part) =>
      part.type === 'markdown' && part.markdown.trim()
        ? [fenceBody(numberedRead(part.markdown, undefined) ?? part.markdown)]
        : [],
    )
    const pictures = tool.content.flatMap((part): Picture[] => {
      const picture = part.type === 'ref' ? pictureOf(part.ref) : null
      return picture ? [picture] : []
    })
    const titled = toolTitle(tool.title)
    const answer = answerText(tool)
    const shell = tool.toolKind === 'execute'
    const running = tool.status === 'pending' || tool.status === 'in_progress'
    body = (
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.status}>
          {running ? (
            <ActivityIndicator size="small" color={c.textSecondary} />
          ) : (
            <Icon
              icon={
                tool.status === 'failed' ? G.failed : tool.status === 'completed' ? G.done : G.info
              }
              size={16}
              color={
                tool.status === 'failed'
                  ? c.danger
                  : tool.status === 'completed'
                    ? c.success
                    : c.textSecondary
              }
            />
          )}
          <Text style={[styles.statusText, { color: c.textSecondary }]}>
            {STATUS[tool.status]}
            {answer ? ` · ${answer}` : ''}
          </Text>
        </View>
        {tool.description ? (
          <Text style={[styles.description, { color: c.text }]}>{tool.description}</Text>
        ) : null}
        {titled && titled !== target(tool, root) ? (
          <Text style={[styles.description, { color: c.textSecondary }]}>{titled}</Text>
        ) : null}
        {tool.rawInput ? (
          <Block
            label={shell ? '命令' : '输入'}
            text={shell ? `$ ${tool.rawInput}` : tool.rawInput}
          />
        ) : null}
        {outputs.map((output, i) => (
          <Block
            key={i}
            label={outputs.length > 1 ? `输出 ${i + 1}` : '输出'}
            text={output}
            tone="muted"
          />
        ))}
        {pictures.length > 0 && (
          <View style={{ gap: 6 }}>
            <Text style={[styles.label, { color: c.textSecondary }]}>图片</Text>
            <PictureStrip pictures={pictures} align="start" />
          </View>
        )}
        {edits.length > 0 && (
          <View style={{ gap: 6 }}>
            <Text style={[styles.label, { color: c.textSecondary }]}>改动的文件</Text>
            {edits.map((edit, i) => (
              <EditLine key={i} edit={edit} root={root} />
            ))}
          </View>
        )}
        {!tool.rawInput &&
          outputs.length === 0 &&
          pictures.length === 0 &&
          edits.length === 0 &&
          !running && <Text style={[styles.description, { color: c.textTertiary }]}>没有输出</Text>}
      </ScrollView>
    )
  }

  return (
    <SessionRows.Provider value={{ sessionId, root, fork: null, forkAtMessage: false }}>
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <Stack.Screen options={{ headerShown: false }} />
        <GlassHeader
          title={tool ? `${VERBS[tool.toolKind]} ${target(tool, root)}` : '工具调用'}
          subtitle={summary?.title ?? null}
          right={
            tool ? (
              <View style={styles.kind}>
                <Icon icon={TOOL_ICONS[tool.toolKind]} size={17} color={c.textSecondary} />
              </View>
            ) : null
          }
        />
        {body}
      </View>
    </SessionRows.Provider>
  )
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40, gap: 16 },
  status: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusText: { fontSize: 14, flexShrink: 1 },
  description: { fontSize: 15, lineHeight: 21 },
  label: { fontSize: 13, fontWeight: '600', marginRight: 'auto' },
  blockHead: { flexDirection: 'row', alignItems: 'center' },
  copy: { flexDirection: 'row', alignItems: 'center', gap: 4, marginLeft: 16 },
  copyText: { fontSize: 13 },
  block: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  mono: { fontFamily: MONO, fontSize: 12, lineHeight: 17 },
  kind: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
})
