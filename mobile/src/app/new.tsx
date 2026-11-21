// A new session: a greeting, the recent projects to choose one from (or none), and the same
// composer as a session's, whose mode and model menus set what the session starts with and whose
// model menu switches the agent; the status line names the computer, the project, which opens a
// picker, the branch it is on, and the agent's plan usage. Opened with `parent`, it starts a
// sub-session of that session, in its project.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import type { AgentStatus, Project, SessionSummary } from '@shared/agent-host'
import { limitsForModel } from '@shared/plan-limits'
import { fallbackAgent, planQuota } from '@shared/plan-quota'
import type { ConfigOption, UserContent } from '@shared/thread'
import { useAgentOptions } from '../agentOptions'
import { useAttachPages } from '../components/AttachMenu'
import { Composer, keyboardOverlap, type ComposerHandle } from '../components/Composer'
import {
  agentModelsPage,
  agentNeed,
  agentsPage,
  canStart,
  modeLook,
  openNeed,
  modePage,
  modelPage,
  moreModelsPage,
  optionPage,
  startConfig,
  startNotices,
  startValues,
  usableAgents,
  type AgentMenuProps,
  type ConfigControl,
} from '../components/ConfigMenus'
import { NEW_SESSION_DRAFT } from '../drafts'
import { PendingSessions } from '../components/OutboxRows'
import { PlanUsageSheet } from '../components/PlanUsageSheet'
import { NeedNote, NodeNeedNote, QuotaSuggestion } from '../components/ComposerNotes'
import { ModeButton, ModelChip, slotOf } from '../components/SessionDock'
import { useChanges } from '../git'
import {
  sameFields,
  useAgents,
  useComputerId,
  useHostSelector,
  useHostState,
  useLink,
  useListsLoaded,
  useSession,
  type HostData,
} from '../host'
import { needsNode } from '../manage/agents'
import { onCreated, queueMessage, withdrawItem, type OutboxMessage } from '../outbox'
import { folder, greeting, listTime, sessionTitle } from '../sessions'
import { HuliIcon } from '../ui/HuliMark'
import { useComputer } from '../ui/session/computer'
import { haptic } from '../ui/session/feedback'
import { GlassHeader, useHeaderHeight } from '../ui/session/GlassHeader'
import { G, Icon } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'
import { usePopover, type MenuPage, type ViewHandle } from '../ui/session/Popover'
import { NativeMenu } from '../ui/session/NativeMenu'
import { StatusLine } from '../ui/session/StatusLine'

export default function NewSession() {
  const { c, s } = useSessionTokens()
  // Narrow reads: the sessions change with every streamed turn, which must not redraw the composer.
  const agentMap = useAgents()
  const state = useHostState()
  const loaded = useListsLoaded()
  const projects = useHostSelector(selectRecent, sameRecent)
  const link = useLink()
  const computer = useComputer()
  const insets = useSafeAreaInsets()
  const headerHeight = useHeaderHeight()
  const menu = usePopover()
  const composer = useRef<ComposerHandle>(null)
  const modeAnchor = useRef<ViewHandle>(null)
  const modelAnchor = useRef<ViewHandle>(null)
  const folderAnchor = useRef<ViewHandle>(null)
  const options = useAgentOptions(link, state.kind === 'connected')

  const agents = useMemo(() => usableAgents(agentMap), [agentMap])

  const [chosenAgent, setChosenAgent] = useState<string | null>(null)
  // 新建子会话 opens this screen under its parent, in the parent's project and with its agent.
  const parentId = useLocalSearchParams<{ parent?: string }>().parent
  const parent = useSession(parentId)
  const startable = agents.filter(canStart)
  const agentId =
    chosenAgent ??
    (parent && agentMap.has(parent.agentId) ? parent.agentId : null) ??
    startable.find((a) => a.isDefault)?.id ??
    startable[0]?.id ??
    agents.find((a) => a.isDefault)?.id ??
    agents[0]?.id ??
    null
  const agent = agentId ? agentMap.get(agentId) : undefined
  const [chosenProject, setChosenProject] = useState<string | null | undefined>(undefined)
  const projectPath = parent
    ? parent.scratch
      ? null
      : parent.projectPath
    : chosenProject === undefined
      ? (projects[0]?.path ?? null)
      : chosenProject
  const project = projects.find((p) => p.path === projectPath)
  const [picks, setPicks] = useState<Record<string, string | boolean>>({})
  const [usageOpen, setUsageOpen] = useState(false)
  const [attachCount, setAttachCount] = useState(0)
  const connected = state.kind === 'connected'

  // The chosen agent's plan, for the status line's ring; only one already running is asked, so
  // that none starts just for the read.
  const readsLimits = !!agent && agent.state === 'ready' && agent.capabilities.reports
  useEffect(() => {
    if (!connected || !readsLimits || !agentId) return
    void link.request('agents.refreshLimits', { agentId }).catch(() => {})
  }, [connected, readsLimits, agentId, link])
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

  // A used-up plan with another agent to pick in its place; the user may keep this one.
  const quota = agent
    ? planQuota({ ...agent, limits: limitsForModel(agent.limits, model?.option) }, Date.now())
    : null
  const fallback =
    agent && quota?.kind === 'out'
      ? fallbackAgent(agents, agent.id, Date.now(), { eligible: canStart })
      : null
  const [keptAgent, setKeptAgent] = useState<string | null>(null)

  // An agent and one of its models are chosen together.
  const chooseAgent = (next: AgentStatus, modelValue: string | null) => {
    setChosenAgent(next.id)
    const nextEntry = options.options?.find((o) => o.agentId === next.id)
    const modelId = nextEntry?.config.find((o) => o.category === 'model')?.id
    setPicks(modelId && modelValue !== null ? { [modelId]: modelValue } : {})
  }

  // Why Send does nothing now, said over the box rather than left to guess; the note over it leads
  // to where the phone fixes it.
  const need = agent ? agentNeed(agent) : null
  const waitingForNode = useMemo(
    () =>
      [...agentMap.values()].filter(
        (a) => a.registered !== false && !a.hidden && !a.disabled && !a.uninstalled && needsNode(a),
      ),
    [agentMap],
  )
  const unsendable =
    agents.length === 0
      ? loaded
        ? waitingForNode.length > 0
          ? `${waitingForNode.map((a) => a.name).join('、')} 需要 Node.js 才能开始。`
          : '没有可用的 Agent，先添加或启用一个再开始。'
        : null
      : !agent
        ? '先选择 Agent'
        : need === 'sign-in'
          ? `登录 ${agent.name} 后才能使用。`
          : need === 'update'
            ? `更新 ${agent.name} 后才能用。`
            : need === 'installing'
              ? `正在安装 ${agent.name}…`
              : need === 'failed'
                ? (agent.detail ?? `${agent.name} 启动失败。`)
                : null
  const needNote =
    agents.length === 0 ? (
      !loaded ? null : waitingForNode.length > 0 ? (
        <NodeNeedNote />
      ) : (
        <NeedNote
          text="可以在这台手机上添加或启用 Agent。"
          action={{ label: '去设置', onPress: () => router.push('/settings/agents') }}
        />
      )
    ) : agent && (need === 'sign-in' || need === 'update' || need === 'failed') ? (
      <NeedNote
        text={
          need === 'sign-in'
            ? `可以在这台手机上登录 ${agent.name}，不用去电脑。`
            : need === 'update'
              ? `可以在这台手机上更新 ${agent.harnessName}。`
              : `可以在 ${agent.name} 的页面查看原因并重试。`
        }
        action={{
          label: need === 'sign-in' ? '去登录' : need === 'update' ? '去更新' : '查看',
          onPress: () => openNeed(agent, need),
        }}
      />
    ) : null
  const notices = entry && agent ? startNotices(entry, picks, agent.name) : []

  const create = async (prompt: UserContent[]) => {
    if (!agentId) return
    const values = entry ? startValues(entry, picks) : {}
    const summary = (await link.request('sessions.create', {
      agentId,
      projectPath,
      ...(parent ? { parentId: parent.id } : {}),
      ...(Object.keys(values).length > 0 ? { options: values } : {}),
      ...(prompt.length > 0 ? { prompt } : {}),
    })) as SessionSummary
    router.replace(`/session/${summary.id}`)
  }

  // Out of the computer's reach the session waits on the phone, as a card over the box, and is
  // made once the link is back; this screen then opens it, if it is still open.
  const computerId = useComputerId()
  const queue = (message: OutboxMessage) => {
    if (!agentId || !computerId) return
    const values = entry ? startValues(entry, picks) : picks
    queueMessage(
      computerId,
      {
        create: {
          agentId,
          projectPath,
          ...(parentId ? { parentId } : {}),
          ...(Object.keys(values).length > 0 ? { options: values } : {}),
        },
      },
      message,
    )
  }
  const withdraw = (itemId: string) => {
    if (!computerId) return
    void withdrawItem(computerId, itemId).then((back) => {
      if (back) composer.current?.restore(back.content, back.picked)
    })
  }
  useEffect(
    () =>
      onCreated(({ session }) => {
        if ((session.parentId ?? undefined) !== parentId) return false
        router.replace(`/session/${session.id}`)
        return true
      }),
    [parentId],
  )

  const attachPages = useAttachPages({
    link,
    folder: projectPath,
    mentioning: menu.page === 'mention',
    composer,
    commands: [],
    touched: [],
    count: attachCount,
  })

  const agentMenu: AgentMenuProps = {
    agents,
    current: agentId,
    currentModel: (model?.option.value as string | undefined) ?? null,
    options: options.options,
    error: options.error,
    onRetry: options.reload,
    onChoose: chooseAgent,
    footer: '新会话会用这个 Agent 开始',
    title: '选择 Agent',
    c,
  }

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
            onUsage: () => {
              menu.close()
              setUsageOpen(true)
            },
          }) ?? {
            entries: [],
            loading: !entry && !options.error,
            empty: agent ? `${agent.name} 启动后，这里会列出它的模型。` : '没有可用的模型',
          }
        )
      case 'more':
        return moreModelsPage(control, agentId ?? '')
      case 'agents':
        return agentsPage(agentMenu)
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
        if (page.startsWith('option:')) return optionPage(control, page.slice('option:'.length))
        if (page.startsWith('agent:'))
          return agentModelsPage(agentMenu, page.slice('agent:'.length))
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
      <GlassHeader
        title={parent ? '新建子会话' : '新建会话'}
        subtitle={parent ? sessionTitle(parent) : null}
      />
      {/* Clipped, so what the keyboard moves up slides under the header, not over it. */}
      <View style={styles.clip}>
        {/* The header's height said outright: measured on its own (automaticOffset), the view
            under a header that takes its own room read as starting at the top on iOS 27, and the
            keyboard covered the composer's buttons. */}
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior="translate-with-padding"
          keyboardVerticalOffset={headerHeight - keyboardOverlap(insets.bottom)}
        >
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
              {parent ? '子会话在父会话的项目中工作' : '最近的项目'}
              {parent ? null : <Text style={{ color: c.textTertiary }}> {projects.length}</Text>}
            </Text>
            {(parent ? [] : projectRows).map((row) => {
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
                    <Text
                      style={[styles.projectMeta, { color: c.textSecondary }]}
                      numberOfLines={1}
                    >
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
            draft={parent ? `new:${parent.id}` : NEW_SESSION_DRAFT}
            agentName={agent?.name ?? null}
            placeholder={agent ? `想让 ${agent.name} 做什么？` : '想让 Agent 做什么？'}
            onSend={create}
            onQueue={queue}
            failTitle="没能新建会话"
            allowEmpty
            disabled={!agentId}
            blocked={unsendable}
            folder={projectPath}
            takes={
              agent?.capabilities.prompt
                ? {
                    images: !!agent.capabilities.prompt.image,
                    text: !!agent.capabilities.prompt.embeddedContext,
                  }
                : null
            }
            onCountChange={setAttachCount}
            top={
              <>
                <PendingSessions
                  {...(parentId ? { parentId } : {})}
                  agentName={(id) => agentMap.get(id)?.name ?? 'Agent'}
                  onWithdraw={withdraw}
                />
                {agent && quota?.kind === 'out' && fallback && keptAgent !== agentId ? (
                  <QuotaSuggestion
                    agentName={agent.name}
                    quota={quota}
                    fallback={fallback}
                    onSwitch={() => {
                      const next = agentMap.get(fallback.agentId)
                      if (next) chooseAgent(next, null)
                    }}
                    onDismiss={() => setKeptAgent(agentId)}
                  />
                ) : null}
                {needNote}
                {notices.length > 0 ? (
                  <View style={[styles.notice, { backgroundColor: s.warningSoft }]}>
                    {notices.map((text) => (
                      <Text key={text} style={[styles.noticeText, { color: c.text }]}>
                        {text}
                      </Text>
                    ))}
                  </View>
                ) : null}
              </>
            }
            bottomInset={insets.bottom}
            onAttach={(anchor) =>
              menu.open('attach', anchor, { placement: 'above', align: 'start' })
            }
            attachMenu={(anchor) => ({
              root: 'attach',
              pages,
              popover: {
                pages: ['mention'],
                open: (page) => menu.open(page, anchor, { placement: 'above', align: 'start' }),
              },
            })}
            left={
              <NativeMenu source={{ root: 'mode', pages }}>
                <ModeButton
                  mode={mode ? { ...mode, look: modeLook(String(mode.option.value)) } : null}
                  busy={false}
                  disabled={false}
                  labelled
                  anchor={modeAnchor}
                  onPress={() =>
                    menu.open('mode', modeAnchor, { placement: 'above', align: 'start' })
                  }
                />
              </NativeMenu>
            }
            right={
              agent ? (
                <NativeMenu source={{ root: 'model', pages }} align="trailing">
                  <ModelChip
                    agentId={agent.id}
                    harness={agent.harnessId}
                    model={model?.name ?? agent.name}
                    effort={effort?.name ?? null}
                    busy={false}
                    disabled={false}
                    anchor={modelAnchor}
                    onPress={() =>
                      menu.open('model', modelAnchor, {
                        placement: 'above',
                        align: 'end',
                        width: 340,
                      })
                    }
                  />
                </NativeMenu>
              ) : null
            }
            footer={
              <StatusLine
                hostName={computer.name}
                platform={computer.platform}
                state={state}
                folder={project ? project.name : projectPath ? folder(projectPath) : '无项目'}
                path={projectPath}
                folderPicker={!parent}
                folderAnchor={folderAnchor}
                {...(parent
                  ? {}
                  : {
                      onFolderPress: () =>
                        menu.open('projects', folderAnchor, {
                          placement: 'above',
                          align: 'center',
                        }),
                    })}
                branch={branch}
                limits={limitsForModel(agent?.limits ?? [], model?.option)}
                onLimitPress={() => {
                  haptic.tap()
                  setUsageOpen(true)
                }}
              />
            }
          />
        </KeyboardAvoidingView>
      </View>
      <PlanUsageSheet visible={usageOpen} onClose={() => setUsageOpen(false)} agentId={agentId} />
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

const selectRecent = (d: HostData) => recentProjects(d.projects, d.sessions)
const sameRecent = (a: RecentProject[], b: RecentProject[]) =>
  a.length === b.length && a.every((row, i) => sameFields(row, b[i]!))

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
  clip: { flex: 1, overflow: 'hidden' },
  notice: { borderRadius: 16, paddingHorizontal: 14, paddingVertical: 10, gap: 4 },
  noticeText: { fontSize: 13, lineHeight: 18 },
})
