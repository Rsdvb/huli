// A new session: which agent, in which project, and its first message.

import { useMemo, useRef, useState, type ComponentRef } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import type { SessionSummary } from '@shared/agent-host'
import type { UserContent } from '@shared/thread'
import { Composer } from '../components/Composer'
import { useHost, useLink } from '../host'
import { useTheme } from '../theme'

export default function NewSession() {
  const theme = useTheme()
  const host = useHost()
  const link = useLink()
  const insets = useSafeAreaInsets()
  const root = useRef<ComponentRef<typeof View>>(null)
  // Where the sheet's content starts on the screen, which the keyboard is measured from.
  const [top, setTop] = useState(0)

  const agents = useMemo(
    () =>
      [...host.agents.values()].filter(
        (a) => !a.hidden && !a.disabled && !a.uninstalled && a.registered !== false,
      ),
    [host.agents],
  )
  const projects = useMemo(
    () => host.projects.filter((p) => !p.missing).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt),
    [host.projects],
  )
  const [agentId, setAgentId] = useState<string | null>(
    agents.find((a) => a.isDefault)?.id ?? agents[0]?.id ?? null,
  )
  const [projectPath, setProjectPath] = useState<string | null>(projects[0]?.path ?? null)

  const create = async (prompt: UserContent[]) => {
    if (!agentId) return
    const summary = (await link.request('sessions.create', {
      agentId,
      projectPath,
      ...(prompt.length > 0 ? { prompt } : {}),
    })) as SessionSummary
    router.replace(`/session/${summary.id}`)
  }

  const chip = (label: string, on: boolean, onPress: () => void, key: string) => (
    <Pressable
      key={key}
      onPress={onPress}
      style={[
        styles.chip,
        {
          borderColor: on ? theme.accent : theme.line,
          backgroundColor: on ? theme.card : 'transparent',
        },
      ]}
    >
      <Text
        style={{
          color: on ? theme.accent : theme.text,
          fontSize: 14,
          fontWeight: on ? '600' : '400',
        }}
      >
        {label}
      </Text>
    </Pressable>
  )

  return (
    <View
      ref={root}
      style={{ flex: 1, backgroundColor: theme.bg }}
      onLayout={() => root.current?.measureInWindow((_x, y) => setTop(y))}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={top}
      >
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 20, gap: 8 }}
          keyboardDismissMode="interactive"
        >
          <Text style={[styles.label, { color: theme.muted }]}>智能体</Text>
          <View style={styles.wrap}>
            {agents.map((a) => chip(a.name, a.id === agentId, () => setAgentId(a.id), a.id))}
          </View>

          <Text style={[styles.label, { color: theme.muted }]}>项目</Text>
          <View style={styles.wrap}>
            {projects.map((p) =>
              chip(p.name, p.path === projectPath, () => setProjectPath(p.path), p.path),
            )}
            {chip('无项目', projectPath === null, () => setProjectPath(null), '__none')}
          </View>

          <Text style={[styles.hint, { color: theme.muted }]}>
            在下面写第一条消息，可以带上照片和文件；不写也能直接发送开始。
          </Text>
        </ScrollView>

        <Composer
          placeholder="想让它做什么？"
          onSend={create}
          failTitle="没能新建会话"
          allowEmpty
          disabled={!agentId}
          bottomInset={insets.bottom}
        />
      </KeyboardAvoidingView>
    </View>
  )
}

const styles = StyleSheet.create({
  label: { fontSize: 13, marginTop: 12 },
  hint: { fontSize: 13, marginTop: 20, lineHeight: 19 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
})
