// One file's change: a file of a session's working tree (or as one of the branch's commits changed
// it), read from the computer and read again when the folder changes, or a tool's edit handed over
// from the conversation.

import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { DiffView } from '../components/DiffView'
import { diffTexts, handedDiff, type Diff } from '../diff'
import { call, sessionFolder, useChanges } from '../git'
import { hostErrorText } from '../hostErrors'
import { useConnected, useHasSessions, useLink, useSession } from '../host'
import { baseName, dirName, relativePath } from '../ui/session/format'
import { GlassHeader } from '../ui/session/GlassHeader'
import { G, Icon } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'
import { StateView } from '../ui/session/StateView'
import { Counts } from '../ui/session/TurnChanges'

type Shown =
  { kind: 'diff'; diff: Diff } | { kind: 'note'; text: string } | { kind: 'error'; text: string }

// Lets the screen draw its spinner before a large diff takes the JS thread.
const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

export default function DiffScreen() {
  const params = useLocalSearchParams<{
    key?: string
    id?: string
    path?: string
    oldPath?: string
    /** A commit: the file as that commit changed it, against its first parent. */
    ref?: string
  }>()
  const { c, s } = useSessionTokens()
  const hasSessions = useHasSessions()
  const link = useLink()
  const handed = params.key ? handedDiff(params.key) : null
  const path = handed?.path ?? params.path ?? ''
  const summary = useSession(params.id)
  const folder = !handed && summary && !summary.scratch ? sessionFolder(summary) : null
  const changes = useChanges(link, folder)
  const updatedAt = changes.status?.updatedAt ?? 0
  // Waits for the folder's first status, which would otherwise read the file a second time.
  const ready = changes.status !== null || changes.error !== null
  const connected = useConnected()
  const oldPath = params.oldPath || null
  const ref = params.ref || null
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
          ref,
        })
        if (!live) return
        if (file.binary) return setShown({ kind: 'note', text: '二进制文件，没法显示逐行改动。' })
        if (file.tooLarge) return setShown({ kind: 'note', text: '文件太大，请在电脑上查看。' })
        await nextFrame()
        if (live) setShown({ kind: 'diff', diff: diffTexts(file.oldText, file.newText) })
      } catch (error) {
        if (live) setShown({ kind: 'error', text: hostErrorText(error, '读不到这个文件的改动。') })
      }
    })()
    return () => {
      live = false
    }
  }, [handed, folder, path, oldPath, ref, connected, ready, link, updatedAt, attempt])

  const missing = params.key
    ? !handed && '这个改动已经不在了，请回到对话里再点开。'
    : !path
      ? '没有指定文件。'
      : connected && hasSessions && !summary
        ? '找不到这个会话。'
        : summary?.scratch
          ? '这个会话没有项目。'
          : null
  const diff = shown?.kind === 'diff' ? shown.diff : null

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <GlassHeader
        title={baseName(path) || '改动'}
        subtitle={dirName(path) ? relativePath(dirName(path), folder) : null}
        subtitlePath
        right={
          diff ? (
            <View style={[styles.counts, { backgroundColor: c.fill }]}>
              <Counts insertions={diff.insertions} deletions={diff.deletions} size={12} />
            </View>
          ) : null
        }
      />
      {missing ? (
        <StateView text={missing} />
      ) : !shown ? (
        <StateView loading />
      ) : shown.kind === 'error' ? (
        <StateView text={shown.text} tone="danger" retry={() => setAttempt((n) => n + 1)} />
      ) : shown.kind === 'note' ? (
        <StateView text={shown.text} />
      ) : shown.diff.rows.length === 0 ? (
        <StateView text="没有改动" />
      ) : (
        <>
          {shown.diff.rough && (
            <View style={[styles.banner, { backgroundColor: s.warningSoft }]}>
              <Icon icon={G.info} size={13} color={c.warning} />
              <Text style={[styles.bannerText, { color: c.textSecondary }]}>
                有些地方改动太多，没有逐行对齐，按先删后增显示。
              </Text>
            </View>
          )}
          <View style={[styles.sheet, { borderTopColor: c.border }]}>
            <DiffView diff={shown.diff} />
          </View>
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  counts: { borderRadius: 999, paddingHorizontal: 10, height: 30, justifyContent: 'center' },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  bannerText: { flex: 1, fontSize: 12, lineHeight: 17 },
  sheet: { flex: 1, borderTopWidth: StyleSheet.hairlineWidth },
})
