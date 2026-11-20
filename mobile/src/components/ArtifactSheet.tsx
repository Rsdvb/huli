// An artifact's sheet: its preview, which opens it, the session that made it, its versions (an
// older one can be brought back as the newest), and deleting it into Recently deleted.

import { useEffect, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { ArtifactSummary, VersionSummary } from '@shared/artifacts'
import { artifactKind, KIND_TEXT, openArtifact } from '../artifacts'
import { useConnected, useMaybeLink, useProjects, useSessions } from '../host'
import { whenText } from '../routines'
import { errorText, folder, sessionTitle } from '../sessions'
import { BottomSheet } from '../ui/BottomSheet'
import { haptic } from '../ui/haptics'
import { Icon } from '../ui/Icon'
import { ListGroup, ListRow } from '../ui/ListRow'
import { Pill } from '../ui/Pill'
import { space, type as typeScale, useTokens } from '../ui/tokens'
import { ArtifactPreview } from './ArtifactCard'

/** Asks, then moves the artifact to Recently deleted. */
export function confirmDelete(
  request: (method: string, params: unknown) => Promise<unknown>,
  artifact: ArtifactSummary,
  done?: () => void,
): void {
  haptic.warning()
  Alert.alert(`删除「${artifact.title || '未命名'}」？`, '它会移到最近删除，30 天内可以恢复。', [
    { text: '取消', style: 'cancel' },
    {
      text: '删除',
      style: 'destructive',
      onPress: () => {
        request('artifacts.delete', { id: artifact.id }).then(
          () => {
            haptic.success()
            done?.()
          },
          (failure: unknown) => Alert.alert('没能删除', errorText(failure)),
        )
      },
    },
  ])
}

export function ArtifactSheet(props: { artifact: ArtifactSummary | null; onClose(): void }) {
  const { c } = useTokens()
  const link = useMaybeLink()
  const sessions = useSessions()
  const projects = useProjects()
  const connected = useConnected()
  const a = props.artifact
  const [versions, setVersions] = useState<VersionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState<ArtifactSummary | null>(a)
  // The sheet keeps showing its artifact while it slides away.
  if (a && a !== shown) setShown(a)
  const id = a?.id
  const latest = a?.version

  useEffect(() => {
    if (!id || !link) return
    let live = true
    setVersions(null)
    setError(null)
    link.request('artifacts.versions', { id }).then(
      (answer) => live && setVersions(answer as VersionSummary[]),
      (failure: unknown) => live && setError(errorText(failure)),
    )
    return () => {
      live = false
    }
  }, [id, latest, link])

  const item = a ?? shown
  if (!item) return <BottomSheet visible={false} onClose={props.onClose} />
  const kind = artifactKind(item)
  const session = sessions.get(item.sessionId)
  const projectName = item.scratch
    ? '无项目'
    : (projects.find((p) => p.path === item.project)?.name ?? folder(item.project))

  const open = (version?: number) => {
    props.onClose()
    openArtifact(item.id, version)
  }

  const author = (v: VersionSummary) =>
    v.author === null ? '你' : sessionTitle(sessions.get(v.author))

  const restore = (v: VersionSummary) => {
    if (!link || !connected) return
    haptic.tap()
    Alert.alert(`恢复到 v${v.version}？`, '会把它存成一个新版本，现在的版本仍留在历史里。', [
      { text: '取消', style: 'cancel' },
      {
        text: '恢复',
        onPress: () => {
          link
            .request('artifacts.restoreVersion', {
              id: item.id,
              version: v.version,
              baseVersion: item.version,
            })
            .then(
              () => haptic.success(),
              (failure: unknown) => Alert.alert('没能恢复', errorText(failure)),
            )
        },
      },
    ])
  }

  return (
    <BottomSheet
      visible={a !== null}
      onClose={props.onClose}
      title={item.title || '未命名'}
      message={`${KIND_TEXT[kind]} · ${projectName} · v${item.version}`}
      maxHeight={640}
    >
      <Pressable
        onPress={() => open()}
        accessibilityRole="button"
        accessibilityLabel={`打开「${item.title || '未命名'}」`}
        style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
      >
        <ArtifactPreview artifact={item} inset={space.xs} />
      </Pressable>
      <View style={styles.actions}>
        <Pill
          tone="accent"
          size="lg"
          label="打开"
          leading={<Icon name="external" size={18} color={c.onAccent} />}
          onPress={() => open()}
        />
        {session ? (
          <Pill
            size="lg"
            label="打开会话"
            leading={<Icon name="message" size={18} color={c.text} />}
            onPress={() => {
              props.onClose()
              router.push(`/session/${session.id}`)
            }}
          />
        ) : null}
      </View>
      <Text style={[typeScale.footnote, styles.hint, { color: c.textTertiary }]}>
        {session ? '在电脑上的纸鸢里可以编辑它。' : '做它的会话已经不在了。'}
      </Text>

      <ListGroup header="版本">
        {error ? (
          <ListRow title="没能读到版本" subtitle={error} />
        ) : !versions ? (
          <View style={styles.loading}>
            <ActivityIndicator color={c.textSecondary} />
          </View>
        ) : (
          versions.slice(0, 30).map((v) => {
            const current = v.version === item.version
            return (
              <ListRow
                key={v.version}
                title={`v${v.version}${current ? ' · 最新' : ''}`}
                subtitle={`${author(v)} · ${whenText(v.createdAt)}${v.note ? `\n${v.note}` : ''}`}
                trailing={
                  current ? undefined : <Icon name="restore" size={16} color={c.textSecondary} />
                }
                disabled={current || !connected}
                onPress={current ? undefined : () => restore(v)}
              />
            )
          })
        )}
      </ListGroup>

      <ListGroup>
        <ListRow
          title="删除"
          destructive
          disabled={!connected}
          leading={<Icon name="trash" size={18} color={c.danger} />}
          onPress={() =>
            link &&
            confirmDelete((method, params) => link!.request(method, params), item, props.onClose)
          }
        />
      </ListGroup>
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: space.sm,
    paddingTop: space.xs,
  },
  hint: { textAlign: 'center' },
  loading: { paddingVertical: space.lg },
})
