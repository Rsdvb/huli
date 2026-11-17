// One file of a session's folder, read-only: its text in monospace with line numbers, scrolled
// sideways rather than wrapped, and a button that copies it all.

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { FlatList, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import type { DeviceFileContent } from '@shared/files'
import { formatBytes } from '../attachments'
import { call, errorText, sessionFolder } from '../git'
import { useHost, useLink } from '../host'
import { copyText } from '../ui/session/feedback'
import { baseName, dirName } from '../ui/session/format'
import { GlassHeader } from '../ui/session/GlassHeader'
import { G, Icon } from '../ui/session/icons'
import { MONO, useSessionTokens } from '../ui/session/palette'
import { RoundButton } from '../ui/session/Press'
import { StateView } from '../ui/session/StateView'

export default function FileScreen() {
  const { id, path } = useLocalSearchParams<{ id: string; path: string }>()
  const { c, s } = useSessionTokens()
  const host = useHost()
  const link = useLink()
  const summary = host.sessions.get(id)
  const folder = summary && !summary.scratch ? sessionFolder(summary) : null
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

  const lines = content?.kind === 'text' ? content.text.split(/\r?\n/) : []
  const gutter = String(lines.length).length

  let body: ReactElement
  if (error) {
    body = <StateView text={error} tone="danger" retry={load} />
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
          contentContainerStyle={styles.code}
          renderItem={({ item, index }) => (
            <View style={styles.line}>
              <Text style={[styles.number, { color: c.textTertiary, width: gutter * 8 + 8 }]}>
                {index + 1}
              </Text>
              <Text selectable style={[styles.text, { color: c.text }]}>
                {item || ' '}
              </Text>
            </View>
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
          ) : null
        }
      />
      <View style={[styles.frame, { borderColor: s.codeBorder }]}>{body}</View>
    </View>
  )
}

const styles = StyleSheet.create({
  frame: { flex: 1, borderTopWidth: StyleSheet.hairlineWidth },
  code: { paddingVertical: 10, paddingRight: 16 },
  line: { flexDirection: 'row' },
  number: { fontFamily: MONO, fontSize: 12, lineHeight: 18, textAlign: 'right', marginRight: 10 },
  text: { fontFamily: MONO, fontSize: 12.5, lineHeight: 18 },
})
