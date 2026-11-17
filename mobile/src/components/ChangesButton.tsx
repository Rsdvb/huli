// The session header's way to its changes, with how many files differ; hidden for a session
// without a project.

import { Pressable, Text } from 'react-native'
import { router } from 'expo-router'
import { sessionFolder, useChanges } from '../git'
import { useHost, useLink } from '../host'
import type { Theme } from '../theme'

export function ChangesButton(props: { sessionId: string; theme: Theme }) {
  const { sessionId, theme } = props
  const host = useHost()
  const link = useLink()
  const summary = host.sessions.get(sessionId)
  const folder = summary && !summary.scratch ? sessionFolder(summary) : null
  const { status, files } = useChanges(link, folder)
  if (!folder || status?.repo === null) return null
  const count = files?.length ?? 0
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/changes/[id]', params: { id: sessionId } })}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `改动，${count} 个文件` : '改动'}
    >
      <Text style={{ color: theme.accent, fontSize: 16 }}>
        改动{count > 0 ? <Text style={{ fontVariant: ['tabular-nums'] }}> {count}</Text> : null}
      </Text>
    </Pressable>
  )
}
