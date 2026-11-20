// The artifacts a session made or last changed, newest first: what each is and when it last
// changed. Each opens full screen on the phone.

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { FlatList, StyleSheet, Text, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import type { ArtifactSummary } from '@shared/artifacts'
import { artifactKind, KIND_TEXT, openArtifact } from '../../artifacts'
import { formatBytes } from '../../attachments'
import { call, errorText } from '../../git'
import { useLink, useSession } from '../../host'
import { listTime, sessionTitle } from '../../sessions'
import { GlassHeader } from '../../ui/session/GlassHeader'
import { G, Icon } from '../../ui/session/icons'
import { useSessionTokens } from '../../ui/session/palette'
import { PressScale } from '../../ui/session/Press'
import { StateView } from '../../ui/session/StateView'
import { usePullRefresh } from '../../ui/PullRefresh'

/** What it is, as the Artifacts tab names it, with its pages when it has more than one. */
function kindText(artifact: ArtifactSummary): string {
  const kind = KIND_TEXT[artifactKind(artifact)]
  return artifact.pages > 1 ? `${kind} · ${artifact.pages} 页` : kind
}

export default function SessionArtifacts() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { c, s } = useSessionTokens()
  const summary = useSession(id)
  const link = useLink()
  const [list, setList] = useState<ArtifactSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    return call(link, 'artifacts.list', {}).then(
      (all) =>
        setList(
          all
            .filter((a) => a.sessionId === id && a.deletedAt === null)
            .sort((a, b) => b.updatedAt - a.updatedAt),
        ),
      (failed: unknown) => setError(errorText(failed, '没能读取 Artifacts。')),
    )
  }, [link, id])

  useEffect(() => {
    void load()
  }, [load])
  const pull = usePullRefresh(load)

  let body: ReactElement
  if (!list) {
    body = error ? <StateView text={error} tone="danger" retry={load} /> : <StateView loading />
  } else if (list.length === 0) {
    body = <StateView text="这个会话还没有做出 Artifact。" icon={G.artifacts} />
  } else {
    body = (
      <FlatList
        data={list}
        keyExtractor={(a) => a.id}
        refreshControl={pull}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, gap: 10 }}
        renderItem={({ item }) => (
          <PressScale
            onPress={() => openArtifact(item.id)}
            scale={0.98}
            accessibilityRole="button"
            accessibilityLabel={`${item.title}，${kindText(item)}，第 ${item.version} 版`}
            accessibilityHint="打开"
            style={[styles.card, { backgroundColor: s.dockCard, borderColor: c.border }]}
          >
            <View style={[styles.icon, { backgroundColor: c.fill }]}>
              <Icon icon={G.artifacts} size={18} color={c.textSecondary} />
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text style={[styles.title, { color: c.text }]} numberOfLines={2}>
                {item.title}
              </Text>
              <Text style={[styles.meta, { color: c.textSecondary }]} numberOfLines={1}>
                {[kindText(item), `第 ${item.version} 版`, formatBytes(item.size)]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
            <Text style={[styles.time, { color: c.textTertiary }]}>{listTime(item.updatedAt)}</Text>
            <Icon icon={G.right} size={11} color={c.textTertiary} weight="semibold" />
          </PressScale>
        )}
        ListFooterComponent={
          <Text style={[styles.note, { color: c.textTertiary }]}>编辑要在电脑上的纸鸢里。</Text>
        }
      />
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <GlassHeader title="Artifacts" subtitle={sessionTitle(summary)} />
      {body}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
  },
  icon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  meta: { fontSize: 12.5, lineHeight: 17 },
  time: { fontSize: 12, fontVariant: ['tabular-nums'] },
  note: { fontSize: 13, textAlign: 'center', paddingVertical: 18 },
})
