// One file's change: a file of a session's working tree (or as one of the branch's commits changed
// it), read from the computer and read again when the folder changes, or a tool's edit handed over
// from the conversation. With the session known, its lines take comments for the agent.

import { useEffect, useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { DiffNotesBar, notedRows, useLinePick, type NotePlace } from '../components/DiffNotes'
import { DiffView } from '../components/DiffView'
import { diffTexts, handedDiff, type Diff } from '../diff'
import { call, sessionFolder, useChanges } from '../git'
import { hostErrorText } from '../hostErrors'
import { Button } from '../manage/kit'
import { previewFile } from '../preview/preview'
import { SHARE_LABEL } from '../preview/PreviewSheet'
import { useComputerId, useConnected, useHasSessions, useLink, useSession } from '../host'
import { useDraftNotes } from '../drafts'
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

  // Comments go to the session the diff came from. A tool's edit may show only part of the file,
  // so its rows' numbers are not the file's and its comments name the file alone.
  const computer = useComputerId()
  const commentable = !!params.id && !!computer && !!summary && !missing
  const root = summary && !summary.scratch ? sessionFolder(summary) : null
  const place = useMemo<NotePlace>(
    () => ({ path: relativePath(path, root), ref, numbered: !handed }),
    [path, root, ref, handed],
  )
  const pick = useLinePick(diff)
  const notes = useDraftNotes(commentable ? computer : null, params.id ?? null)
  const noted = useMemo(
    () => (diff && commentable ? notedRows(diff, notes, place) : undefined),
    [diff, commentable, notes, place],
  )
  const [barHeight, setBarHeight] = useState(0)

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
        <StateView
          text={shown.text}
          tone="danger"
          retry={() => {
            // The spinner shows while it reads again, not the error it had.
            setShown(null)
            setAttempt((n) => n + 1)
          }}
        />
      ) : shown.kind === 'note' ? (
        <View style={{ flex: 1 }}>
          <StateView text={shown.text} />
          {params.id && folder && !ref ? (
            <View style={styles.noteButtons}>
              <Button
                label="预览文件"
                tone="primary"
                icon="doc"
                wide
                onPress={() => previewFile({ sessionId: params.id!, path })}
              />
              <Button
                label={SHARE_LABEL}
                icon="external"
                wide
                onPress={() => previewFile({ sessionId: params.id!, path }, 'share')}
              />
            </View>
          ) : null}
        </View>
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
            <DiffView
              diff={shown.diff}
              {...(commentable
                ? {
                    picked: pick.picked,
                    ...(noted ? { noted } : {}),
                    onPressRow: pick.press,
                    onLongPressRow: pick.longPress,
                    bottomInset: barHeight,
                  }
                : {})}
            />
            {commentable && computer && params.id ? (
              <DiffNotesBar
                computer={computer}
                sessionId={params.id}
                place={place}
                diff={shown.diff}
                pick={pick}
                onHeight={setBarHeight}
              />
            ) : null}
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
  noteButtons: { paddingHorizontal: 24, paddingBottom: 48, gap: 10 },
})
