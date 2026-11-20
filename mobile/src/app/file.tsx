// One file of a session's folder, read-only: its text in monospace with line numbers, scrolled
// sideways rather than wrapped, and a button that copies it all.

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, useLocalSearchParams } from 'expo-router'
import type { DeviceFileContent } from '@shared/files'
import { formatBytes } from '../attachments'
import { call, errorText, sessionFolder } from '../git'
import { sameFields, useHostSelector, useLink, type HostData } from '../host'
import { ContextMenu } from '../ui/ContextMenu'
import { copyText } from '../ui/session/feedback'
import { baseName, dirName } from '../ui/session/format'
import { GlassHeader } from '../ui/session/GlassHeader'
import { G, Icon } from '../ui/session/icons'
import { MONO, useSessionTokens } from '../ui/session/palette'
import { RoundButton } from '../ui/session/Press'
import { selectText } from '../ui/session/SelectText'
import { StateView } from '../ui/session/StateView'
import { FONT_SCALE } from '../ui/tokens'

export default function FileScreen() {
  const { id, path, line } = useLocalSearchParams<{ id: string; path: string; line?: string }>()
  const { c, s } = useSessionTokens()
  const link = useLink()
  const insets = useSafeAreaInsets()
  // Only the session's folder, so its every turn and status does not draw the file again.
  const { known, folder } = useHostSelector(
    useCallback(
      (d: HostData) => {
        const summary = d.sessions.get(id)
        return {
          known: summary !== undefined,
          folder: summary && !summary.scratch ? sessionFolder(summary) : null,
        }
      },
      [id],
    ),
    sameFields,
  )
  // The lines follow the system's text size up to the dense cap, and their rows grow with them;
  // React Native scales a line height with its text, so the styles keep the unscaled one.
  const scale = Math.min(useWindowDimensions().fontScale, FONT_SCALE.dense)
  const rowHeight = Math.ceil(LINE * scale)
  const [content, setContent] = useState<DeviceFileContent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(() => {
    if (!folder) return
    setError(null)
    call(link, 'files.read', { projectPath: folder, path }).then(setContent, (failed: unknown) =>
      setError(errorText(failed, '没能读取这个文件。')),
    )
  }, [link, folder, path])

  useEffect(load, [load])

  const lines = useMemo(
    () => (content?.kind === 'text' ? content.text.split(/\r?\n/) : []),
    [content],
  )
  const gutter = String(lines.length).length
  // A reference to a line opens the file a few lines above it.
  const target = line ? Math.min(Math.max(0, Number(line) - 4), Math.max(0, lines.length - 1)) : 0
  const marked = line ? Number(line) - 1 : -1
  const selectAll = () => {
    if (content?.kind === 'text')
      selectText({ text: content.text, mono: true, title: baseName(path) })
  }

  let body: ReactElement
  if (error) {
    body = <StateView text={error} tone="danger" retry={load} />
  } else if (known && !folder) {
    body = <StateView text="这个会话没有项目，没有可看的文件。" icon={G.folder} />
  } else if (!content) {
    body = <StateView loading />
  } else if (content.kind === 'text') {
    body = (
      <ScrollView horizontal bounces={false} contentContainerStyle={{ minWidth: '100%' }}>
        <FlatList
          data={lines}
          keyExtractor={(_, index) => String(index)}
          initialNumToRender={60}
          maxToRenderPerBatch={80}
          windowSize={21}
          {...(target > 0 && Number.isFinite(target)
            ? {
                initialScrollIndex: target,
                getItemLayout: (_: unknown, index: number) => ({
                  length: rowHeight,
                  offset: rowHeight * index,
                  index,
                }),
              }
            : {})}
          contentContainerStyle={[styles.code, { paddingBottom: insets.bottom + EDGE }]}
          renderItem={({ item, index }) => (
            <ContextMenu
              items={[
                {
                  key: 'copy',
                  label: '复制这一行',
                  icon: 'doc.on.doc',
                  onPress: () => void copyText(item),
                },
                { key: 'select', label: '选择文本', icon: 'text.cursor', onPress: selectAll },
              ]}
            >
              {(longPress) => (
                <Pressable
                  {...(longPress ? { onLongPress: longPress, delayLongPress: 350 } : {})}
                  style={[
                    styles.line,
                    { height: rowHeight, backgroundColor: c.bg },
                    index === marked && { backgroundColor: s.inlineCode },
                  ]}
                >
                  <Text
                    maxFontSizeMultiplier={FONT_SCALE.dense}
                    style={[
                      styles.number,
                      { color: c.textTertiary, width: (gutter * 8 + 8) * scale },
                    ]}
                  >
                    {index + 1}
                  </Text>
                  <Text
                    maxFontSizeMultiplier={FONT_SCALE.dense}
                    style={[styles.text, { color: c.text }]}
                  >
                    {item || ' '}
                  </Text>
                </Pressable>
              )}
            </ContextMenu>
          )}
        />
      </ScrollView>
    )
  } else {
    const text =
      content.kind === 'too-large'
        ? `这个文件有 ${formatBytes(content.size)}，超过了 ${formatBytes(content.limit)}，手机上不显示。`
        : content.kind === 'binary'
          ? `这是一个二进制文件（${formatBytes(content.size)}），没法当作文本显示。`
          : '这是一个媒体文件，请在电脑上查看。'
    body = <StateView text={text} icon={G.file} />
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <GlassHeader
        title={baseName(path)}
        subtitle={dirName(path) || (folder ? baseName(folder) : null)}
        subtitlePath
        right={
          content?.kind === 'text' ? (
            <View style={styles.actions}>
              <RoundButton tone="glass" size={44} onPress={selectAll} accessibilityLabel="选择文本">
                <Icon icon={G.select} size={17} color={c.text} />
              </RoundButton>
              <RoundButton
                tone="glass"
                size={44}
                onPress={() =>
                  void copyText(content.text).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  })
                }
                accessibilityLabel="复制全文"
              >
                <Icon icon={copied ? G.copied : G.copy} size={17} color={c.text} />
              </RoundButton>
            </View>
          ) : null
        }
      />
      <View style={[styles.frame, { borderColor: s.codeBorder }]}>{body}</View>
    </View>
  )
}

/** A line's height at the system's own text size. */
const LINE = 18
/** Room above the first line and below the last, over the home indicator. */
const EDGE = 10

const styles = StyleSheet.create({
  frame: { flex: 1, borderTopWidth: StyleSheet.hairlineWidth },
  actions: { flexDirection: 'row', gap: 8 },
  code: { paddingTop: EDGE, paddingRight: 16 },
  line: { flexDirection: 'row' },
  number: { fontFamily: MONO, fontSize: 12, lineHeight: LINE, textAlign: 'right', marginRight: 10 },
  text: { fontFamily: MONO, fontSize: 12.5, lineHeight: LINE },
})
