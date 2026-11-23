// Huli: going back to one of the user's messages, as the desktop's dialog asks it: what leaves the
// conversation, how the agent takes it, and the files that would be put back, each with its lines,
// with 同时还原文件 to put them back too. Nothing changes until 从这里重来 or 回退 is pressed.

import { useEffect, useState } from 'react'
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import type { FilesRestored, RewindChange, RewindFiles, RewindPreview } from '@shared/agent-host'
import type { RewindMode } from '@shared/rewind-target'
import { call } from '../git'
import { hostErrorText } from '../hostErrors'
import { useConnected, useEntryOn, useMaybeLink } from '../host'
import { LockLayer } from '../lock'
import { Press } from '../ui/Press'
import { MONO } from '../ui/session/palette'
import { radius, space, type as typeScale, useTokens } from '../ui/tokens'

export interface RewindDone {
  mode: RewindMode
  /** The message's text, for the composer after 从这里重来. */
  text: string
  restored: number | null
  failed: number
  backup: string | null
}

const ACTIONS: Record<RewindChange['action'], string> = {
  restore: '还原',
  delete: '删除',
  recreate: '恢复',
}

function ChangeLine(props: { change: RewindChange }) {
  const { c } = useTokens()
  const { change } = props
  const tone =
    change.action === 'delete'
      ? c.danger
      : change.action === 'recreate'
        ? c.success
        : c.textSecondary
  return (
    <View style={styles.change}>
      <Text style={[typeScale.caption, styles.action, { color: tone }]}>
        {ACTIONS[change.action]}
      </Text>
      <Text style={[styles.path, { color: c.text }]} numberOfLines={1} ellipsizeMode="head">
        {change.path}
      </Text>
      {change.binary ? (
        <Text style={[typeScale.caption, { color: c.textTertiary }]}>二进制</Text>
      ) : change.insertions !== null && change.deletions !== null ? (
        <Text style={[typeScale.caption, styles.counts]}>
          <Text style={{ color: c.success }}>+{change.insertions}</Text>{' '}
          <Text style={{ color: c.danger }}>−{change.deletions}</Text>
        </Text>
      ) : null}
    </View>
  )
}

function filesLine(files: RewindFiles): string | null {
  if (files.state === 'unchanged') return '文件和当时一样，不用还原。'
  if (files.state === 'unavailable') {
    if (files.reason === 'busy') return `「${files.detail ?? ''}」正在改这些文件，等它做完再还原。`
    if (files.reason === 'failed') return `没能检查文件：${files.detail ?? ''}`
    return '这条消息时没有保存文件。'
  }
  return null
}

export function RewindDialog(props: {
  sessionId: string
  /** The first message the rewind takes out, and how it goes back; null while closed. */
  target: { entryId: string; mode: RewindMode } | null
  /** The session's agent, by name. */
  agent: string
  onClose(): void
  onDone(done: RewindDone): void
}) {
  const { c } = useTokens()
  const link = useMaybeLink()
  const connected = useConnected()
  const { target, sessionId } = props
  const [preview, setPreview] = useState<RewindPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [restore, setRestore] = useState(false)
  const [busy, setBusy] = useState(false)
  const filesOn = useEntryOn('phone.rewindFiles')
  const entryId = target?.entryId ?? null
  const mode = target?.mode ?? 'edit'

  useEffect(() => {
    setPreview(null)
    setError(null)
    setRestore(false)
    setBusy(false)
    if (!entryId || !link || !connected) return
    let live = true
    call(link, 'sessions.rewindPreview', { sessionId, entryId }).then(
      (answer) => live && setPreview(answer),
      (e: unknown) => live && setError(hostErrorText(e)),
    )
    return () => {
      live = false
    }
  }, [entryId, sessionId, link, connected])

  if (!target) return null
  const files = filesOn ? (preview?.files ?? null) : null
  const ready = files?.state === 'ready' ? files : null
  const later = Math.max(0, (preview?.messages ?? 1) - (mode === 'edit' ? 1 : 0))
  const body =
    mode === 'edit'
      ? later === 0
        ? '这条消息会从对话里移除，放回输入框，可以原样或改过再发。'
        : `这条消息和之后的 ${later} 条会从对话里移除。这条消息放回输入框，可以原样或改过再发。`
      : `这条之后的 ${later} 条消息和回复会从对话里移除。`
  const how = !preview
    ? null
    : preview.conversation === 'agent'
      ? `${props.agent} 也会从它自己的历史里去掉这些轮。`
      : preview.conversation === 'fresh'
        ? `${props.agent} 不能从自己的历史里去掉某几轮，所以会开一个新的 ${props.agent} 会话，带上到这里为止的对话接着做。`
        : `对话里什么也不剩，下一条消息会开一个新的 ${props.agent} 会话。`
  const count = ready ? ready.folders.reduce((sum, folder) => sum + folder.changes.length, 0) : 0
  const kept = ready ? ready.folders.reduce((sum, folder) => sum + folder.kept, 0) : 0

  const go = async () => {
    if (!link || busy) return
    setBusy(true)
    setError(null)
    // The files first, so a refusal leaves the conversation as it is too.
    let restored: FilesRestored | null = null
    try {
      if (restore && ready) {
        restored = await call(link, 'sessions.restoreFiles', {
          sessionId,
          entryId: target.entryId,
          token: ready.token,
        })
      }
      const { content } = await call(link, 'sessions.rewind', {
        sessionId,
        entryId: target.entryId,
        draft: [],
      })
      props.onDone({
        mode,
        text: content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n\n'),
        restored: restored ? restored.restored : null,
        failed: restored?.failed ?? 0,
        backup: restored?.backup ?? null,
      })
    } catch (e) {
      setError(
        restored ? `${hostErrorText(e)}（文件已还原 ${restored.restored} 个）` : hostErrorText(e),
      )
      setBusy(false)
    }
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={props.onClose}>
      <View style={[styles.backdrop, { backgroundColor: c.scrim }]}>
        <View style={[styles.card, { backgroundColor: c.surfaceRaised, borderColor: c.border }]}>
          <Text style={[typeScale.headline, { color: c.text }]}>
            {mode === 'edit' ? '从这里重来？' : '回退到这里？'}
          </Text>
          <Text style={[typeScale.footnote, { color: c.textSecondary }]}>{body}</Text>
          {!connected ? (
            <Text style={[typeScale.footnote, { color: c.textSecondary }]}>
              电脑没有连上，连上后才能回退。
            </Text>
          ) : !preview && !error ? (
            <View style={styles.loading}>
              <ActivityIndicator color={c.textSecondary} />
            </View>
          ) : preview ? (
            <>
              {how ? (
                <Text style={[typeScale.footnote, { color: c.textSecondary }]}>{how}</Text>
              ) : null}
              {filesOn ? (
                <Press
                  onPress={() => setRestore((on) => !on)}
                  disabled={!ready || busy}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: restore && !!ready, disabled: !ready || busy }}
                  style={styles.toggle}
                >
                  <Text
                    style={[
                      typeScale.body,
                      styles.flex,
                      { color: ready ? c.text : c.textTertiary },
                    ]}
                  >
                    同时还原文件
                  </Text>
                  <Switch
                    value={restore && !!ready}
                    disabled={!ready || busy}
                    onValueChange={setRestore}
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                  />
                </Press>
              ) : null}
              {files && filesLine(files) ? (
                <Text
                  style={[
                    typeScale.footnote,
                    {
                      color:
                        files.state === 'unavailable' && files.reason === 'busy'
                          ? c.warning
                          : c.textTertiary,
                    },
                  ]}
                >
                  {filesLine(files)}
                </Text>
              ) : null}
              {ready ? (
                <>
                  <Text style={[typeScale.footnote, { color: c.textSecondary }]}>
                    会改动 {count} 个文件
                    {ready.insertions !== null && ready.deletions !== null
                      ? `，+${ready.insertions} −${ready.deletions} 行`
                      : ''}
                  </Text>
                  <ScrollView style={styles.scroll}>
                    {ready.folders.map((folder) => (
                      <View key={folder.folder}>
                        {ready.folders.length > 1 ? (
                          <Text style={[typeScale.caption, { color: c.textSecondary }]}>
                            {folder.folder.split(/[\\/]/).filter(Boolean).at(-1)}
                            {folder.missing ? ' · 当时没有保存' : ''}
                          </Text>
                        ) : null}
                        {folder.changes.map((change) => (
                          <ChangeLine key={change.path} change={change} />
                        ))}
                      </View>
                    ))}
                  </ScrollView>
                  {kept > 0 ? (
                    <Text style={[typeScale.footnote, { color: c.textTertiary }]}>
                      还有 {kept} 个改过的文件当时没有保存，会保持现在的样子。
                    </Text>
                  ) : null}

                  {restore ? (
                    <Text style={[typeScale.footnote, { color: c.warning }]}>
                      这之后你自己改的内容也会被撤掉。纸鸢会先保存一份现在的文件，还原之后可以撤销。
                    </Text>
                  ) : null}
                </>
              ) : null}
            </>
          ) : null}
          {error ? <Text style={[typeScale.footnote, { color: c.danger }]}>{error}</Text> : null}
          <View style={styles.buttons}>
            <Press
              onPress={() => void go()}
              disabled={!preview || busy}
              accessibilityRole="button"
              style={[styles.button, { backgroundColor: c.danger, opacity: preview ? 1 : 0.5 }]}
            >
              {busy ? (
                <ActivityIndicator color={c.onAccent} />
              ) : (
                <Text style={[typeScale.body, { color: c.onAccent, fontWeight: '600' }]}>
                  {mode === 'edit' ? '从这里重来' : '回退'}
                </Text>
              )}
            </Press>
            <Press
              onPress={props.onClose}
              disabled={busy}
              accessibilityRole="button"
              style={[styles.button, { backgroundColor: c.fill }]}
            >
              <Text style={[typeScale.body, { color: c.text }]}>取消</Text>
            </Press>
          </View>
        </View>
      </View>
      <LockLayer />
    </Modal>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, justifyContent: 'center', padding: space.xxl },
  card: {
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.xl,
    gap: space.md,
    maxHeight: '85%',
  },
  loading: { paddingVertical: space.lg, alignItems: 'center' },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 36 },
  scroll: { flexGrow: 0, maxHeight: 220 },
  change: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 28 },
  action: { width: 34 },
  path: { flex: 1, fontFamily: MONO, fontSize: 12 },
  counts: { fontVariant: ['tabular-nums'] },
  buttons: { gap: space.sm, marginTop: space.xs },
  button: { height: 46, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
})
