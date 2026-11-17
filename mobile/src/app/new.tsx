// A new session: which agent, in which project, and its first message.

import { useMemo, useRef, useState, type ComponentRef } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import type { SessionSummary } from '@shared/agent-host'
import type { UserContent } from '@shared/thread'
import { Composer } from '../components/Composer'
import { useShell } from '../components/shell'
import { useHost, useLink } from '../host'
import { AgentAvatar } from '../ui/AgentAvatar'
import { haptic } from '../ui/haptics'
import { Icon } from '../ui/Icon'
import { Pill } from '../ui/Pill'
import { space, type as typeScale, useTokens } from '../ui/tokens'

export default function NewSession() {
  const { c } = useTokens()
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
  const { filter } = useShell()
  const [agentId, setAgentId] = useState<string | null>(
    agents.find((a) => a.isDefault)?.id ?? agents[0]?.id ?? null,
  )
  // Start in the project the tabs are filtered to, else the latest one.
  const [projectPath, setProjectPath] = useState<string | null>(
    filter.kind === 'scratch'
      ? null
      : filter.kind === 'project' && projects.some((p) => p.path === filter.path)
        ? filter.path
        : (projects[0]?.path ?? null),
  )

  const create = async (prompt: UserContent[]) => {
    if (!agentId) return
    const summary = (await link.request('sessions.create', {
      agentId,
      projectPath,
      ...(prompt.length > 0 ? { prompt } : {}),
    })) as SessionSummary
    haptic.success()
    router.replace(`/session/${summary.id}`)
  }

  const pick = (apply: () => void) => {
    haptic.select()
    apply()
  }

  return (
    <View
      ref={root}
      style={{ flex: 1, backgroundColor: c.bg }}
      onLayout={() => root.current?.measureInWindow((_x, y) => setTop(y))}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={top}
      >
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.page}
          keyboardDismissMode="interactive"
        >
          <Text style={[typeScale.footnote, styles.label, { color: c.textSecondary }]}>智能体</Text>
          <View style={styles.wrap}>
            {agents.map((a) => {
              const on = a.id === agentId
              return (
                <Pill
                  key={a.id}
                  tone={on ? 'tint' : 'outline'}
                  size="lg"
                  label={a.name}
                  color={on ? c.tint : c.text}
                  leading={<AgentAvatar agentId={a.id} name={a.name} size={26} />}
                  accessibilityLabel={on ? `${a.name}，已选` : a.name}
                  onPress={() => pick(() => setAgentId(a.id))}
                  style={styles.agentPill}
                />
              )
            })}
          </View>

          <Text style={[typeScale.footnote, styles.label, { color: c.textSecondary }]}>项目</Text>
          <View style={styles.wrap}>
            {projects.map((p) => {
              const on = p.path === projectPath
              return (
                <Pill
                  key={p.path}
                  tone={on ? 'tint' : 'outline'}
                  label={p.name}
                  color={on ? c.tint : c.text}
                  leading={<Icon name="folder" size={14} color={on ? c.tint : c.textSecondary} />}
                  accessibilityLabel={on ? `${p.name}，已选` : p.name}
                  onPress={() => pick(() => setProjectPath(p.path))}
                />
              )
            })}
            <Pill
              tone={projectPath === null ? 'tint' : 'outline'}
              label="无项目"
              color={projectPath === null ? c.tint : c.text}
              onPress={() => pick(() => setProjectPath(null))}
            />
          </View>

          <Text style={[typeScale.footnote, styles.hint, { color: c.textTertiary }]}>
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
  page: { padding: space.xl, gap: space.md },
  label: { marginTop: space.md },
  hint: { marginTop: space.xl },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  agentPill: { paddingLeft: space.xs + 2 },
})
