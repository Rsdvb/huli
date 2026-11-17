// A new session: which agent, in which project, and its first message.

import { useMemo, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import type { SessionSummary } from '@shared/agent-host'
import { useHost, useLink } from '../host'
import { useTheme } from '../theme'

export default function NewSession() {
  const theme = useTheme()
  const host = useHost()
  const link = useLink()

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
  const [agentId, setAgentId] = useState<string | null>(agents.find((a) => a.isDefault)?.id ?? agents[0]?.id ?? null)
  const [projectPath, setProjectPath] = useState<string | null>(projects[0]?.path ?? null)
  const [prompt, setPrompt] = useState('')
  const [creating, setCreating] = useState(false)

  const create = async () => {
    if (!agentId) return
    setCreating(true)
    try {
      const text = prompt.trim()
      const summary = (await link.request('sessions.create', {
        agentId,
        projectPath,
        ...(text ? { prompt: [{ type: 'text', text }] } : {}),
      })) as SessionSummary
      router.replace(`/session/${summary.id}`)
    } catch (error) {
      Alert.alert('没能新建会话', (error as { message?: string }).message ?? '')
      setCreating(false)
    }
  }

  const chip = (label: string, on: boolean, onPress: () => void, key: string) => (
    <Pressable
      key={key}
      onPress={onPress}
      style={[styles.chip, { borderColor: on ? theme.accent : theme.line, backgroundColor: on ? theme.card : 'transparent' }]}
    >
      <Text style={{ color: on ? theme.accent : theme.text, fontSize: 14, fontWeight: on ? '600' : '400' }}>{label}</Text>
    </Pressable>
  )

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: 20, gap: 8 }}>
      <Text style={[styles.label, { color: theme.muted }]}>智能体</Text>
      <View style={styles.wrap}>
        {agents.map((a) => chip(a.name, a.id === agentId, () => setAgentId(a.id), a.id))}
      </View>

      <Text style={[styles.label, { color: theme.muted }]}>项目</Text>
      <View style={styles.wrap}>
        {projects.map((p) => chip(p.name, p.path === projectPath, () => setProjectPath(p.path), p.path))}
        {chip('无项目', projectPath === null, () => setProjectPath(null), '__none')}
      </View>

      <Text style={[styles.label, { color: theme.muted }]}>第一条消息</Text>
      <TextInput
        value={prompt}
        onChangeText={setPrompt}
        multiline
        placeholder="想让它做什么？"
        placeholderTextColor={theme.muted}
        style={[styles.input, { color: theme.text, borderColor: theme.line, backgroundColor: theme.card }]}
      />

      <Pressable
        onPress={() => void create()}
        disabled={!agentId || creating}
        style={({ pressed }) => [
          styles.primary,
          { backgroundColor: theme.accent, opacity: !agentId || creating ? 0.5 : pressed ? 0.8 : 1 },
        ]}
      >
        {creating ? (
          <ActivityIndicator color={theme.accentText} />
        ) : (
          <Text style={{ color: theme.accentText, fontSize: 17, fontWeight: '600' }}>开始</Text>
        )}
      </Pressable>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  label: { fontSize: 13, marginTop: 12 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  input: { minHeight: 110, borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 15, textAlignVertical: 'top' },
  primary: { marginTop: 20, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
})
