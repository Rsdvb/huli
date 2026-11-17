// One file's change: a file of a session's working tree, read from the computer and read again
// when the folder changes, or a tool's edit handed over from the conversation.

import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { DiffView } from '../components/DiffView'
import { Loading, Message } from '../components/Placeholder'
import { diffTexts, handedDiff, type Diff } from '../diff'
import { call, errorText, sessionFolder, useChanges } from '../git'
import { useHost, useLink } from '../host'
import { folder as baseName } from '../sessions'
import { useTheme } from '../theme'

type Shown =
  { kind: 'diff'; diff: Diff } | { kind: 'note'; text: string } | { kind: 'error'; text: string }

// Lets the screen draw its spinner before a large diff takes the JS thread.
const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function dirName(path: string): string {
  const cut = path.replace(/\\/g, '/').lastIndexOf('/')
  return cut > 0 ? path.slice(0, cut) : ''
}

export default function DiffScreen() {
  const params = useLocalSearchParams<{
    key?: string
    id?: string
    path?: string
    oldPath?: string
  }>()
  const theme = useTheme()
  const host = useHost()
  const link = useLink()
  const handed = params.key ? handedDiff(params.key) : null
  const path = handed?.path ?? params.path ?? ''
  const summary = params.id ? host.sessions.get(params.id) : undefined
  const folder = !handed && summary && !summary.scratch ? sessionFolder(summary) : null
  const changes = useChanges(link, folder)
  const updatedAt = changes.status?.updatedAt ?? 0
  // Waits for the folder's first status, which would otherwise read the file a second time.
  const ready = changes.status !== null || changes.error !== null
  const connected = host.state.kind === 'connected'
  const oldPath = params.oldPath || null
  const [shown, setShown] = useState<Shown | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!handed) return
    let live = true
    void nextFrame().then(() => {
      if (live)
        setShown({ kind: 'diff', diff: handed.diff ?? diffTexts(handed.oldText, handed.newText) })
    })
    return () => {
      live = false
    }
  }, [handed])

  useEffect(() => {
    if (handed || !folder || !path || !connected || !ready) return
    let live = true
    void (async () => {
      try {
        const file = await call(link, 'git.fileDiff', {
          projectPath: folder,
          path,
          oldPath,
          ref: null,
        })
        if (!live) return
        if (file.binary) return setShown({ kind: 'note', text: '二进制文件，没法显示逐行改动。' })
        if (file.tooLarge) return setShown({ kind: 'note', text: '文件太大，请在电脑上查看。' })
        await nextFrame()
        if (live) setShown({ kind: 'diff', diff: diffTexts(file.oldText, file.newText) })
      } catch (error) {
        if (live) setShown({ kind: 'error', text: errorText(error, '读不到这个文件的改动') })
      }
    })()
    return () => {
      live = false
    }
  }, [handed, folder, path, oldPath, connected, ready, link, updatedAt, attempt])

  const missing = params.key
    ? !handed && '这个改动已经不在了，请回到对话里再点开。'
    : !path
      ? '没有指定文件。'
      : connected && host.sessions.size > 0 && !summary
        ? '找不到这个会话。'
        : summary?.scratch
          ? '这个会话没有项目。'
          : null
  const diff = shown?.kind === 'diff' ? shown.diff : null

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={{ alignItems: 'center', maxWidth: 240 }}>
              <Text
                style={{ color: theme.text, fontWeight: '600', fontSize: 16 }}
                numberOfLines={1}
              >
                {baseName(path) || '改动'}
              </Text>
              {dirName(path) ? (
                <Text
                  style={{ color: theme.muted, fontSize: 11 }}
                  numberOfLines={1}
                  ellipsizeMode="head"
                >
                  {dirName(path)}
                </Text>
              ) : null}
            </View>
          ),
          headerRight: () =>
            diff ? (
              <Text style={{ fontSize: 13, fontVariant: ['tabular-nums'] }}>
                <Text style={{ color: theme.ok }}>+{diff.insertions}</Text>
                <Text style={{ color: theme.muted }}> </Text>
                <Text style={{ color: theme.danger }}>−{diff.deletions}</Text>
              </Text>
            ) : null,
        }}
      />
      {missing ? (
        <Message text={missing} theme={theme} />
      ) : !shown ? (
        <Loading theme={theme} />
      ) : shown.kind === 'error' ? (
        <Message
          text={shown.text}
          theme={theme}
          color={theme.danger}
          retry={() => setAttempt((n) => n + 1)}
        />
      ) : shown.kind === 'note' ? (
        <Message text={shown.text} theme={theme} />
      ) : shown.diff.rows.length === 0 ? (
        <Message text="没有改动" theme={theme} />
      ) : (
        <>
          {shown.diff.rough && (
            <Text style={[styles.banner, { color: theme.muted, borderBottomColor: theme.line }]}>
              有些地方改动太多，没有逐行对齐，按先删后增显示。
            </Text>
          )}
          <DiffView diff={shown.diff} theme={theme} />
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  banner: {
    fontSize: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
})
