// A new session: which agent, in which project, and its first message.

import { useMemo, useRef, useState, type ComponentRef } from 'react'
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, router } from 'expo-router'
import type { SessionSummary } from '@shared/agent-host'
import type { UserContent } from '@shared/thread'
import { Composer } from '../components/Composer'
import { useHost, useLink } from '../host'
import { useComputer } from '../ui/session/computer'
import { haptic } from '../ui/session/feedback'
import { GlassHeader, useHeaderHeight } from '../ui/session/GlassHeader'
import { AgentMark, G, Icon } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'
import { PressScale } from '../ui/session/Press'
import { StatusLine } from '../ui/session/StatusLine'

export default function NewSession() {
  const { c, s } = useSessionTokens()
  const host = useHost()
  const link = useLink()
  const computer = useComputer()
  const insets = useSafeAreaInsets()
  const headerHeight = useHeaderHeight(true)
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
  const agent = agentId ? host.agents.get(agentId) : undefined
  const project = projects.find((p) => p.path === projectPath)

  const create = async (prompt: UserContent[]) => {
    if (!agentId) return
    const summary = (await link.request('sessions.create', {
      agentId,
      projectPath,
      ...(prompt.length > 0 ? { prompt } : {}),
    })) as SessionSummary
    router.replace(`/session/${summary.id}`)
  }

  const projectRows = [
    ...projects.map((p) => ({
      key: p.path,
      name: p.name,
      detail: p.path,
      path: p.path as string | null,
    })),
    { key: '__none', name: '无项目', detail: '在一个临时文件夹里工作', path: null },
  ]

  return (
    <View
      ref={root}
      style={{ flex: 1, backgroundColor: c.bg }}
      onLayout={() => root.current?.measureInWindow((_x, y) => setTop(y))}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <GlassHeader modal title="新会话" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior="padding"
        keyboardVerticalOffset={top + headerHeight}
      >
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.content}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          <Text style={[styles.label, { color: c.textSecondary }]}>智能体</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.agents}
            style={styles.bleed}
          >
            {agents.map((a) => {
              const on = a.id === agentId
              return (
                <PressScale
                  key={a.id}
                  scale={0.96}
                  onPress={() => {
                    haptic.pick()
                    setAgentId(a.id)
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  style={[
                    styles.agent,
                    {
                      backgroundColor: on ? s.accentSoft : s.dockCard,
                      borderColor: on ? c.accent : c.border,
                    },
                  ]}
                >
                  <AgentMark harness={a.harnessId} size={18} />
                  <Text
                    style={[styles.agentName, { color: on ? c.text : c.textSecondary }]}
                    numberOfLines={1}
                  >
                    {a.name}
                  </Text>
                </PressScale>
              )
            })}
          </ScrollView>

          <Text style={[styles.label, { color: c.textSecondary }]}>项目</Text>
          <View style={[styles.group, { backgroundColor: s.dockCard, borderColor: c.border }]}>
            {projectRows.map((row, index) => {
              const on = row.path === projectPath
              return (
                <Pressable
                  key={row.key}
                  onPress={() => {
                    haptic.pick()
                    setProjectPath(row.path)
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  style={({ pressed }) => [
                    styles.project,
                    pressed && { backgroundColor: c.fill },
                    index > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: c.border,
                    },
                  ]}
                >
                  <Icon
                    icon={row.path === null ? G.file : G.folder}
                    size={17}
                    color={row.path === null ? c.textSecondary : c.tint}
                  />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[styles.projectName, { color: c.text }]} numberOfLines={1}>
                      {row.name}
                    </Text>
                    <Text
                      style={[styles.projectPath, { color: c.textTertiary }]}
                      numberOfLines={1}
                      ellipsizeMode="head"
                    >
                      {row.detail}
                    </Text>
                  </View>
                  {on && <Icon icon={G.copied} size={16} color={c.accent} weight="semibold" />}
                </Pressable>
              )
            })}
          </View>

          <Text style={[styles.hint, { color: c.textTertiary }]}>
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
          right={
            agent ? (
              <View style={styles.chosen}>
                <AgentMark harness={agent.harnessId} size={16} />
                <Text style={[styles.chosenText, { color: c.textSecondary }]} numberOfLines={1}>
                  {agent.name}
                </Text>
              </View>
            ) : null
          }
          footer={
            <StatusLine
              hostName={computer.name}
              platform={computer.platform}
              state={host.state}
              folder={project ? project.name : '无项目'}
              limits={agent?.limits ?? []}
            />
          }
        />
      </KeyboardAvoidingView>
    </View>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingBottom: 24 },
  label: { fontSize: 13, fontWeight: '600', marginTop: 18, marginBottom: 8, marginLeft: 4 },
  bleed: { marginHorizontal: -16 },
  agents: { gap: 8, paddingHorizontal: 16 },
  agent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    height: 42,
  },
  agentName: { fontSize: 15, fontWeight: '600' },
  group: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  project: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    minHeight: 56,
  },
  projectName: { fontSize: 15, lineHeight: 20, fontWeight: '500' },
  projectPath: { fontSize: 12, lineHeight: 16, marginTop: 1 },
  hint: { fontSize: 13, lineHeight: 19, marginTop: 18, marginHorizontal: 4 },
  chosen: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    maxWidth: '100%',
  },
  chosenText: { fontSize: 14, fontWeight: '500', flexShrink: 1 },
})
