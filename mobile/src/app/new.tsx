// A new session: a greeting, the recent projects to choose one from (or none), and the same
// composer as a session's, whose mode and model menus set what the session starts with and whose
// model menu switches the agent; the status line names the computer, the project, which opens a
// picker, and the branch it is on.

import { useMemo, useRef, useState } from 'react'
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, router } from 'expo-router'
import type { AgentStatus, Project, SessionSummary } from '@shared/agent-host'
import type { ConfigOption, UserContent } from '@shared/thread'
import { useAgentOptions } from '../agentOptions'
import { useAttachPages } from '../components/AttachMenu'
import { Composer, type ComposerHandle } from '../components/Composer'
import {
  agentsPage,
  modeLook,
  modePage,
  modelPage,
  moreModelsPage,
  startConfig,
  startValues,
  usableAgents,
  type ConfigControl,
} from '../components/ConfigMenus'
import { ModeButton, ModelChip, slotOf } from '../components/SessionDock'
import { useChanges } from '../git'
import { useHost, useLink } from '../host'
import { folder, greeting, listTime } from '../sessions'
import { HuliIcon } from '../ui/HuliMark'
import { useComputer } from '../ui/session/computer'
import { haptic } from '../ui/session/feedback'
import { GlassHeader } from '../ui/session/GlassHeader'
import { G, Icon } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'
import { usePopover, type MenuPage, type ViewHandle } from '../ui/session/Popover'
import { StatusLine } from '../ui/session/StatusLine'

export default function NewSession() {
  const { c } = useSessionTokens()
  const host = useHost()
  const link = useLink()
  const computer = useComputer()
  const insets = useSafeAreaInsets()
  const menu = usePopover()
  const composer = useRef<ComposerHandle>(null)
  const modeAnchor = useRef<ViewHandle>(null)
  const modelAnchor = useRef<ViewHandle>(null)
  const folderAnchor = useRef<ViewHandle>(null)
  const options = useAgentOptions(link, host.state.kind === 'connected')

  const agents = useMemo(() => usableAgents(host.agents), [host.agents])
  const projects = useMemo(
    () => recentProjects(host.projects, host.sessions),
    [host.projects, host.sessions],
  )

  const [chosenAgent, setChosenAgent] = useState<string | null>(null)
  const agentId = chosenAgent ?? agents.find((a) => a.isDefault)?.id ?? agents[0]?.id ?? null
  const agent = agentId ? host.agents.get(agentId) : undefined
  const [chosenProject, setChosenProject] = useState<string | null | undefined>(undefined)
  const projectPath = chosenProject === undefined ? (projects[0]?.path ?? null) : chosenProject
  const project = projects.find((p) => p.path === projectPath)
  const [picks, setPicks] = useState<Record<string, string | boolean>>({})
  const changes = useChanges(link, projectPath)

  const entry = options.options?.find((o) => o.agentId === agentId)
  const config: ConfigOption[] = entry ? startConfig(entry, picks) : []
  const control: ConfigControl = {
    config,
    running: false,
    set: (option, value) => setPicks((was) => ({ ...was, [option.id]: value })),
  }
  const mode = slotOf(config, 'mode', false)
  const model = slotOf(config, 'model', false)
  const effort = slotOf(config, 'thought_level', false)

  const chooseAgent = (next: AgentStatus) => {
    setChosenAgent(next.id)
    setPicks({})
  }

  const create = async (prompt: UserContent[]) => {
    if (!agentId) return
    const values = entry ? startValues(entry, picks) : {}
    const summary = (await link.request('sessions.create', {
      agentId,
      projectPath,
      ...(Object.keys(values).length > 0 ? { options: values } : {}),
      ...(prompt.length > 0 ? { prompt } : {}),
    })) as SessionSummary
    router.replace(`/session/${summary.id}`)
  }

  const attachPages = useAttachPages({
    link,
    folder: projectPath,
    mentioning: menu.page === 'mention',
    composer,
    commands: [],
    touched: [],
  })

  const projectRows = [
    ...projects.map((p) => ({
      key: p.path,
      name: p.name,
      path: p.path as string | null,
      at: p.at as number | null,
      count: p.count,
    })),
    { key: '__none', name: '无项目', path: null, at: null, count: 0 },
  ]

  const pickProject = (path: string | null) => {
    haptic.pick()
    setChosenProject(path)
  }

  const pages = (page: string): MenuPage | null => {
    switch (page) {
      case 'attach':
        return attachPages.attach
      case 'mention':
        return attachPages.mention
      case 'slash':
        return attachPages.slash
      case 'mode':
        return modePage(control)
      case 'model':
        return (
          modelPage(control, {
            agentId: agentId ?? '',
            agent,
            c,
            switchAgent: agents.length > 1 ? { disabled: false } : null,
          }) ?? { entries: [], loading: !entry, empty: '这个 Agent 没有可选的模型' }
        )
      case 'more':
        return moreModelsPage(control, agentId ?? '')
      case 'agents':
        return {
          ...agentsPage({
            agents,
            current: agentId,
            options: options.options,
            error: options.error,
            onRetry: options.reload,
            onChoose: chooseAgent,
            footer: '新会话会用这个 Agent 开始',
            c,
          }),
          title: '选择 Agent',
        }
      case 'projects':
        return {
          entries: projectRows.map((row) => ({
            key: row.key,
            label: row.name,
            icon: row.path === null ? G.file : G.folder,
            ...(row.path ? { subtitle: `${row.count} 个会话` } : {}),
            checked: row.path === projectPath,
            onPress: () => pickProject(row.path),
          })),
        }
      default:
        return null
    }
  }

  const branch =
    projectPath === null
      ? undefined
      : changes.status
        ? changes.status.repo
          ? (changes.status.head.branch ?? changes.status.head.oid?.slice(0, 7) ?? null)
          : null
        : changes.error
          ? null
          : 'loading'

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <GlassHeader title="新建会话" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.content}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.hello}>
            <HuliIcon size={34} />

            <Text style={[styles.greeting, { color: c.text }]}>{greeting()}</Text>
          </View>
          <Text style={[styles.lead, { color: c.textSecondary }]}>
            选一个项目，或者直接说你要什么。
          </Text>

          <Text style={[styles.section, { color: c.textSecondary }]}>
            最近的项目
            <Text style={{ color: c.textTertiary }}> {projects.length}</Text>
          </Text>
          {projectRows.map((row) => {
            const on = row.path === projectPath
            return (
              <Pressable
                key={row.key}
                onPress={() => pickProject(row.path)}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                accessibilityLabel={row.path ? `${row.name}，${row.count} 个会话` : '无项目'}
                style={({ pressed }) => [styles.project, pressed && { opacity: 0.6 }]}
              >
                <View style={[styles.disc, { backgroundColor: c.avatar }]}>
                  <Icon
                    icon={row.path === null ? G.file : G.folder}
                    size={16}
                    color={row.path === null ? c.textSecondary : c.tint}
                  />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[styles.projectName, { color: c.text }]} numberOfLines={1}>
                    {row.name}
                  </Text>
                  <Text style={[styles.projectMeta, { color: c.textSecondary }]} numberOfLines={1}>
                    {row.path ? (
                      <>
                        {computer.name}
                        <Text style={{ color: c.text }}>
                          {'  '}
                          {row.count} 个会话
                        </Text>
                      </>
                    ) : (
                      '在一个临时文件夹里工作'
                    )}
                  </Text>
                </View>
                <View style={styles.projectEnd}>
                  {row.at !== null && (
                    <Text style={[styles.time, { color: c.textSecondary }]}>
                      {listTime(row.at)}
                    </Text>
                  )}
                  {on && <Icon icon={G.check} size={17} color={c.tint} weight="semibold" />}
                </View>
              </Pressable>
            )
          })}
        </ScrollView>

        <Composer
          ref={composer}
          placeholder="想让 Agent 做什么？"
          onSend={create}
          failTitle="没能新建会话"
          allowEmpty
          disabled={!agentId}
          bottomInset={insets.bottom}
          onAttach={(anchor) => menu.open('attach', anchor, { placement: 'above', align: 'start' })}
          left={
            <ModeButton
              mode={mode ? { ...mode, look: modeLook(String(mode.option.value)) } : null}
              busy={false}
              disabled={false}
              labelled
              anchor={modeAnchor}
              onPress={() => menu.open('mode', modeAnchor, { placement: 'above', align: 'start' })}
            />
          }
          right={
            agent ? (
              <ModelChip
                agentId={agent.id}
                harness={agent.harnessId}
                model={model?.name ?? agent.name}
                effort={effort?.name ?? null}
                busy={false}
                disabled={false}
                anchor={modelAnchor}
                onPress={() =>
                  menu.open('model', modelAnchor, { placement: 'above', align: 'end', width: 300 })
                }
              />
            ) : null
          }
          footer={
            <StatusLine
              hostName={computer.name}
              platform={computer.platform}
              state={host.state}
              folder={project ? project.name : '无项目'}
              folderPicker
              folderAnchor={folderAnchor}
              onFolderPress={() =>
                menu.open('projects', folderAnchor, { placement: 'above', align: 'center' })
              }
              branch={branch}
            />
          }
        />
      </KeyboardAvoidingView>
      {menu.render(pages)}
    </View>
  )
}

interface RecentProject {
  path: string
  name: string
  at: number
  count: number
}

// The host's project list alone can miss folders its sessions are in (the home tab lists by
// session), so the sessions' folders are merged in and named as the host names them when it does.
function recentProjects(known: Project[], sessions: Map<string, SessionSummary>): RecentProject[] {
  const byPath = new Map(known.map((p) => [p.path, p]))
  const rows = new Map<string, RecentProject>()
  for (const p of known) {
    if (!p.missing) rows.set(p.path, { path: p.path, name: p.name, at: p.lastOpenedAt, count: 0 })
  }
  for (const s of sessions.values()) {
    if (s.scratch || s.parentId !== null || s.archivedAt !== null) continue
    const project = byPath.get(s.projectPath)
    if (project?.missing) continue
    const row = rows.get(s.projectPath)
    if (row) {
      row.at = Math.max(row.at, s.updatedAt)
      row.count++
    } else {
      rows.set(s.projectPath, {
        path: s.projectPath,
        name: project?.name ?? folder(s.projectPath),
        at: s.updatedAt,
        count: 1,
      })
    }
  }
  return [...rows.values()].sort((a, b) => b.at - a.at)
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 22, paddingTop: 12, paddingBottom: 24 },
  hello: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  greeting: { fontSize: 24, lineHeight: 30, fontWeight: '700' },
  lead: { fontSize: 16, lineHeight: 22, marginTop: 8 },
  section: { fontSize: 15, fontWeight: '500', marginTop: 30, marginBottom: 6 },
  project: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  disc: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  projectName: { fontSize: 16, lineHeight: 21, fontWeight: '600' },
  projectMeta: { fontSize: 14, lineHeight: 19, marginTop: 1 },
  projectEnd: { alignItems: 'flex-end', gap: 4 },
  time: { fontSize: 13, fontVariant: ['tabular-nums'] },
})
