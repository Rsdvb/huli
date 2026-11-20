// Settings › Agent: the agents on the computer with their state and account, the harnesses they run
// on, installed or not, with updates and installs under way, and adding an agent.

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { AgentStatus, HostEvent, NodeRuntimeInfo, NodeTask } from '@shared/agent-host'
import { KEY_ONLY_ADDED_HARNESSES, MULTI_AGENT_HARNESSES, type CodebuddySite } from '@shared/agents'
import { AGENT_NAME_CHARS, type SettingsPatch } from '@shared/settings'
import type { AgentId, HarnessId } from '@shared/thread'
import { admin } from '../../admin'
import { useAgents, useHostActions, useListsLoaded, useMaybeLink } from '../../host'
import {
  addableHarnesses,
  awaitsPackage,
  cliOutdated,
  environmentText,
  harnessInstalled,
  harnessStatuses,
  harnessVersion,
  installKind,
  readiness,
  stateText,
  usableAgents,
} from '../../manage/agents'
import {
  call,
  errorText,
  Field,
  FieldLabel,
  FieldNote,
  FormSheet,
  ManagePage,
  ReadState,
  Tag,
  useActions,
  useConnected,
  useRead,
  type Read,
} from '../../manage/kit'
import { ago } from '../../sessions'
import { AgentAvatar } from '../../ui/AgentAvatar'
import { haptic } from '../../ui/haptics'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { planName } from '../../ui/session/limits'
import { Press } from '../../ui/Press'
import { radius, space, type as typeScale, useTokens } from '../../ui/tokens'

/** A check the user started counts as just done for this long. */
const JUST_CHECKED_MS = 60_000

export default function Agents() {
  const agentMap = useAgents()
  const link = useMaybeLink()
  const loaded = useListsLoaded()
  const { refresh: refreshLists } = useHostActions()
  const connected = useConnected()
  const { busy, run } = useActions()
  const [listError, setListError] = useState<string | null>(null)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [adding, setAdding] = useState(false)
  const statuses = useMemo(() => [...agentMap.values()], [agentMap])
  const environment = useRead(
    connected ? 'agents-environment' : null,
    (link) => call(link, 'agents.environment', undefined),
    ['environment.changed'],
  )

  const latest = useRef({ refresh: refreshLists, setEnvironment: environment.set })
  latest.current = { refresh: refreshLists, setEnvironment: environment.set }
  useEffect(() => {
    if (!link) return
    return link.onHostEvent((raw) => {
      const event = raw as HostEvent
      if (event.type === 'agent.removed') void latest.current.refresh().catch(() => {})
      if (event.type === 'environment.changed') latest.current.setEnvironment(() => event.info)
    })
  }, [link])

  const refresh = async () => {
    try {
      await Promise.all([refreshLists(), environment.reload()])
      setListError(null)
    } catch (failure) {
      setListError(errorText(failure))
    }
  }

  const list: Read<AgentStatus[]> = {
    value: loaded ? statuses : null,
    error: listError,
    reload: refresh,
    set: () => {},
  }

  const agents = usableAgents(statuses)
  const harnesses = harnessStatuses(statuses)
  const installed = harnesses.filter(harnessInstalled)
  const missing = harnesses.filter((h) => !installed.includes(h))
  // The sheet resets when this changes, so it keeps its reference while the agents do.
  const addable = useMemo(() => addableHarnesses(statuses, MULTI_AGENT_HARNESSES), [statuses])
  const updates = harnesses.filter((h) => h.update || h.cli?.update).length
  const lastAt = Math.max(0, ...harnesses.map((h) => h.updateCheckedAt ?? 0)) || null
  const checkable = harnesses.some((h) => h.package || h.updateCheckedAt !== null || h.cli)
  const checkLine =
    checkedAt && Date.now() - checkedAt < JUST_CHECKED_MS
      ? updates > 0
        ? `刚刚检查 · ${updates} 个可更新`
        : '刚刚检查 · 都是最新'
      : lastAt
        ? updates > 0
          ? `${ago(lastAt)}检查过 · ${updates} 个可更新`
          : `${ago(lastAt)}检查过`
        : '还没有检查过'

  const checkUpdates = () =>
    void run(
      'check',
      async () => {
        if (!link) return
        await call(link, 'agents.checkUpdates', undefined)
        setCheckedAt(Date.now())
        await refreshLists()
      },
      '无法检查更新',
    )

  const reloadEnvironment = () =>
    void run(
      'environment',
      async () => {
        if (!link) return
        await call(link, 'agents.reloadEnvironment', undefined)
        await Promise.all([refreshLists(), environment.reload()])
      },
      '没能重新加载环境',
    )

  const empty = ReadState({ read: list, what: 'Agent', icon: 'sparkles', rows: 5 })

  return (
    <ManagePage
      title="Agent"
      intro="Agent 用一个 Harness 和一份账号配置运行。你需要哪个就添加哪个；安装 Harness 本身不会添加 Agent。"
      onRefresh={refresh}
      overlay={
        <AddAgentSheet
          visible={adding}
          harnesses={addable}
          onClose={() => setAdding(false)}
          onAdded={(id) => router.push({ pathname: '/settings/agent', params: { id } })}
        />
      }
    >
      {empty ?? (
        <>
          <ListGroup
            header="这台电脑上的"
            footer={`要用别的程序，先到 Harness 里安装。安装或检测到 Harness 不会自动添加 Agent。`}
          >
            {agents.length === 0 ? (
              <ListRow
                key="empty"
                title="还没有 Agent"
                subtitle={
                  addable.length > 0
                    ? '已经有可用的 Harness。选择一个，沿用现有的配置，或创建独立的配置。'
                    : '添加第一个 Agent 开始使用。如果它的 Harness 还没安装，先在下面安装。'
                }
              />
            ) : (
              agents.map((status) => (
                <AgentRow key={status.id} status={status} statuses={statuses} />
              ))
            )}
            <ListRow
              key="add"
              title="添加 Agent"
              subtitle={
                connected && addable.length === 0 ? '能添加的 Agent 都已经添加了' : undefined
              }
              icon="plus"
              plainIcon
              action
              disabled={!connected || addable.length === 0}
              onPress={() => setAdding(true)}
            />
          </ListGroup>

          {installed.length > 0 ? (
            <ListGroup header={`Harness · 已安装 ${installed.length}`} footer={checkLine}>
              {installed.map((status) => (
                <HarnessRow key={status.id} status={status} statuses={statuses} />
              ))}
              {checkable ? (
                <ListRow
                  key="check"
                  title={busy('check') ? '正在检查…' : '检查更新'}
                  icon="refresh"
                  plainIcon
                  action
                  disabled={!connected || busy('check')}
                  onPress={checkUpdates}
                />
              ) : null}
            </ListGroup>
          ) : null}

          {missing.length > 0 ? (
            <ListGroup header={`未安装 ${missing.length}`}>
              {missing.map((status) => (
                <HarnessRow key={status.id} status={status} statuses={statuses} />
              ))}
            </ListGroup>
          ) : null}

          <ListGroup header="环境" footer={environmentText(environment.value)}>
            <ListRow
              title="重新加载环境"
              icon="refresh"
              plainIcon
              action
              disabled={!connected || busy('environment')}
              trailing={busy('environment') ? <Tag label="正在读取…" tone="tint" /> : undefined}
              onPress={reloadEnvironment}
            />
            {environment.value?.node ? (
              nodeRows({
                node: environment.value.node,
                connected,
                busy,
                run,
                call: (method) => (link ? call(link, method, undefined) : Promise.resolve()),
              })
            ) : environment.value?.nodeVersion ? (
              <ListRow key="node" title="Node.js" value={environment.value.nodeVersion} />
            ) : null}
            {environment.value?.warning ? (
              <ListRow key="warning" title="环境" subtitle={environment.value.warning} />
            ) : null}
          </ListGroup>
        </>
      )}
    </ManagePage>
  )
}

const NODE_PHASES: Record<NodeTask['phase'], string> = {
  checking: '正在查找最新版…',
  downloading: '正在下载',
  verifying: '正在校验…',
  extracting: '正在解压…',
  removing: '正在移除…',
}

/** Huli: what the Node.js agents run on says, the user's or Kite's own, with its version. */
function nodeLine(node: NodeRuntimeInfo): string {
  const required = node.required?.replace(/^>=\s*/, '') ?? ''
  if (node.using === 'kite' && node.kite) return `纸鸢的 Node.js ${node.kite.version}`
  if (!node.system) return '没有找到 Node.js，有些 Agent 需要它'
  if (!node.system.version) return '系统的 Node.js 运行不了'
  if (!node.system.suitable)
    return `系统的 ${node.system.version} 太旧，有些 Agent 要 ${required} 或更高`
  return `系统的 Node.js ${node.system.version}`
}

/**
 * Huli: the Node.js agents run on, and Kite's own: installed with one tap where the computer's is
 * missing or too old, its progress, updated or removed. The computer does the work. Rows, not a
 * component, so the group draws its lines between them.
 */
function nodeRows(props: {
  node: NodeRuntimeInfo
  connected: boolean
  busy: (key: string) => boolean
  run: (key: string, action: () => Promise<unknown>, failTitle: string) => Promise<boolean>
  call: (
    method: 'environment.installNode' | 'environment.cancelNodeInstall' | 'environment.removeNode',
  ) => Promise<unknown>
}) {
  const { node, connected, busy, run, call: ask } = props
  const task = node.task
  const running = task?.state === 'running'
  const lacking = node.using === null || (node.using === 'system' && !node.system?.suitable)
  const percent =
    task?.phase === 'downloading' && task.progress !== null
      ? ` ${Math.floor(task.progress * 100)}%`
      : ''
  const install = (title: string) => void run('node', () => ask('environment.installNode'), title)
  const rows: ReactElement[] = [
    <ListRow
      key="node"
      title="Node.js"
      subtitle={nodeLine(node)}
      value={node.using === 'kite' ? node.kite?.version : (node.system?.version ?? undefined)}
    />,
  ]
  if (running && task) {
    rows.push(
      <ListRow
        key="node-task"
        title={
          task.phase === 'downloading'
            ? `${NODE_PHASES.downloading} ${task.version ?? 'Node.js'}${percent}`
            : NODE_PHASES[task.phase]
        }
        subtitle={task.source ? `来自 ${task.source}` : undefined}
        trailing={<Tag label={task.kind === 'remove' ? '正在移除' : '正在安装'} tone="tint" />}
      />,
    )
    if (task.kind === 'install') {
      rows.push(
        <ListRow
          key="node-stop"
          title="停止安装"
          icon="stop"
          plainIcon
          action
          disabled={!connected}
          onPress={() => void ask('environment.cancelNodeInstall').catch(() => {})}
        />,
      )
    }
  } else {
    if (task?.state === 'failed' && task.error) {
      rows.push(
        <ListRow
          key="node-failed"
          title={task.kind === 'remove' ? 'Node.js 移除失败' : 'Node.js 安装失败'}
          subtitle={task.error}
          trailing={<Tag label="失败" tone="danger" />}
        />,
      )
    }
    if (node.installable && (lacking || node.kite)) {
      rows.push(
        <ListRow
          key="node-install"
          title={node.kite ? '更新纸鸢的 Node.js' : '一键安装 Node.js'}
          subtitle={node.kite ? undefined : '装在纸鸢自己的文件夹里，不改系统设置'}
          icon="download"
          plainIcon
          action
          disabled={!connected || busy('node')}
          onPress={() => install(node.kite ? '没能更新 Node.js' : '没能安装 Node.js')}
        />,
      )
    }
    if (node.kite) {
      rows.push(
        <ListRow
          key="node-remove"
          title="移除纸鸢的 Node.js"
          icon="trash"
          plainIcon
          destructive
          disabled={!connected || busy('node')}
          onPress={() => void run('node', () => ask('environment.removeNode'), '没能移除 Node.js')}
        />,
      )
    }
  }
  return rows
}

function AgentRow({ status, statuses }: { status: AgentStatus; statuses: AgentStatus[] }) {
  const hasOthers = statuses.some(
    (s) => s.id !== status.id && s.harnessId === status.harnessId && s.registered !== false,
  )
  const account = status.account?.kind === 'none' ? null : status.account
  const r = readiness(status)
  const state = stateText(status)
  const email = account?.email?.trim() ?? ''
  const plan = email ? planName(account) : null
  const identity =
    r.kind === 'failed' || r.kind === 'missing'
      ? r.message
      : email || planName(account) || (r.kind === 'sign-in' ? '需要你登录' : '未提供账号信息')
  const line = [status.name === status.harnessName ? null : status.harnessName, plan, identity]
    .filter(Boolean)
    .join(' · ')
  return (
    <ListRow
      title={status.name}
      subtitle={line}
      leading={<AgentAvatar agentId={status.id} name={status.name} size={32} />}
      trailing={
        <View style={styles.tags}>
          {status.isDefault && hasOthers ? <Tag label="默认" /> : null}
          <Tag label={state.text} tone={state.tone} />
        </View>
      }
      chevron
      onPress={() => router.push({ pathname: '/settings/agent', params: { id: status.id } })}
    />
  )
}

function HarnessRow({ status, statuses }: { status: AgentStatus; statuses: AgentStatus[] }) {
  const count = usableAgents(statuses).filter((a) => a.harnessId === status.harnessId).length
  const r = readiness(status)
  const version = harnessVersion(status)
  const kind = installKind(status)
  const task = status.task
  const line =
    task?.state === 'running'
      ? (task.progress.at(-1) ?? task.command)
      : status.state === 'installing'
        ? (status.progress.at(-1) ?? '正在安装…')
        : task?.state === 'failed'
          ? (task.error ?? '')
          : status.uninstalled
            ? '已从纸鸢卸载'
            : cliOutdated(status) !== null
              ? [version, '需要更新'].filter(Boolean).join(' · ')
              : awaitsPackage(status) && status.package?.isSdk
                ? '首次使用时安装'
                : kind === 'package' && status.package?.isSdk
                  ? [version, 'SDK 首次使用时安装'].filter(Boolean).join(' · ')
                  : kind || awaitsPackage(status)
                    ? '未安装'
                    : r.kind === 'missing' || r.kind === 'failed'
                      ? r.message
                      : [version, count > 0 ? `${count} 个 Agent` : null]
                          .filter(Boolean)
                          .join(' · ')
  const next =
    status.cli?.update?.version ?? status.update?.cliVersion ?? status.update?.adapterVersion
  const tag =
    task?.state === 'running' || status.state === 'installing' ? (
      <Tag label={task?.kind === 'update' ? '正在更新…' : '正在安装…'} tone="tint" />
    ) : task?.state === 'failed' ? (
      <Tag label={task.kind === 'update' ? '更新失败' : '安装失败'} tone="danger" />
    ) : (status.cli?.update || status.update) && next ? (
      <Tag label={`${next} 已发布`} tone="tint" />
    ) : cliOutdated(status) !== null ? (
      <Tag label="需要更新" tone="warning" />
    ) : null
  return (
    <ListRow
      title={status.harnessName}
      subtitle={line || undefined}
      leading={<AgentAvatar agentId={status.harnessId} name={status.harnessName} size={32} />}
      trailing={tag ?? undefined}
      chevron
      onPress={() =>
        router.push({ pathname: '/settings/harness', params: { id: status.harnessId } })
      }
    />
  )
}

/** Resolves once the computer lists the agent, which follows the settings change that added it. */
async function waitListed(
  link: NonNullable<ReturnType<typeof useMaybeLink>>,
  id: AgentId,
): Promise<void> {
  const until = Date.now() + 10_000
  while (Date.now() < until) {
    const list = await call(link, 'agents.list', undefined)
    if (list.some((s) => s.id === id && s.registered !== false)) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('电脑没有及时列出新的 Agent，请稍后在列表里找它。')
}

type Folder = 'default' | 'new'
type Login = 'terminal' | 'api-key'

/**
 * Adding an agent: its harness, its name, a new configuration folder or the existing one, and how
 * it signs in. A folder already on the computer is chosen in the desktop app.
 */
function AddAgentSheet(props: {
  visible: boolean
  harnesses: AgentStatus[]
  onClose(): void
  onAdded(id: AgentId): void
}) {
  const { c } = useTokens()
  const link = useMaybeLink()
  const { refresh: refreshLists } = useHostActions()
  const [harness, setHarness] = useState<HarnessId | null>(null)
  const [name, setName] = useState('')
  const [folder, setFolder] = useState<Folder>('default')
  const [login, setLogin] = useState<Login>('terminal')
  const [site, setSite] = useState<CodebuddySite>('international')
  const [key, setKey] = useState({ key: '', baseUrl: '', model: '' })

  // Starts over only as the sheet opens: the harnesses can change while it is up, and what the
  // user typed must survive that.
  const wasVisible = useRef(false)
  useEffect(() => {
    const opened = props.visible && !wasVisible.current
    wasVisible.current = props.visible
    if (!opened) return
    setHarness(props.harnesses[0]?.harnessId ?? null)
    setName('')
    setFolder('default')
    setLogin('terminal')
    setSite('international')
    setKey({ key: '', baseUrl: '', model: '' })
  }, [props.visible, props.harnesses])

  const chosen = props.harnesses.find((h) => h.harnessId === harness) ?? props.harnesses[0]
  const canUseDefault = chosen?.registered === false
  const multiple = !!chosen && MULTI_AGENT_HARNESSES.includes(chosen.harnessId)
  const selected: Folder = folder === 'default' && !canUseDefault ? 'new' : folder
  const useDefault = selected === 'default'
  const trimmed = useDefault ? (chosen?.harnessName ?? '') : name.trim()
  const tooLong = [...trimmed].length > AGENT_NAME_CHARS
  const providers = chosen?.apiKey?.providers ?? false
  const keyOnly = !useDefault && !!chosen && KEY_ONLY_ADDED_HARNESSES.includes(chosen.harnessId)
  const mode: Login = keyOnly ? 'api-key' : login
  const valid =
    !!chosen &&
    trimmed.length > 0 &&
    !tooLong &&
    (useDefault || multiple) &&
    (useDefault || mode === 'terminal' || key.key.trim().length > 0)

  const submit = async () => {
    if (!link || !chosen) throw new Error('电脑没有连上。')
    const id = useDefault
      ? chosen.harnessId
      : await admin(link, 'settings.addAgent', {
          harnessId: chosen.harnessId,
          name: trimmed,
          folder: null,
        })
    if (useDefault) {
      await admin(link, 'settings.update', {
        patch: {
          agents: { [chosen.harnessId]: { enabled: true, hidden: false } },
        } as SettingsPatch,
      })
    }
    await waitListed(link, id)
    if (keyOnly) {
      await call(link, 'agents.setCodebuddySite', { agentId: id, change: { site } })
    }
    if (!useDefault && mode === 'api-key') {
      await call(link, 'agents.setApiKey', {
        agentId: id,
        key: key.key.trim(),
        ...(providers && key.baseUrl.trim() ? { baseUrl: key.baseUrl.trim() } : {}),
        ...(providers && key.model.trim() ? { model: key.model.trim() } : {}),
      })
    }
    await refreshLists().catch(() => {})
    props.onAdded(id)
  }

  const chip = (label: string, on: boolean, onPress: () => void, keyId: string) => (
    <Press
      key={keyId}
      onPress={() => {
        haptic.select()
        onPress()
      }}
      scale={false}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      style={[
        styles.chip,
        { backgroundColor: on ? c.tintSoft : c.fill, borderColor: on ? c.tint : 'transparent' },
      ]}
    >
      <Text style={[typeScale.subhead, { color: on ? c.tint : c.textSecondary }]} numberOfLines={1}>
        {label}
      </Text>
    </Press>
  )

  const choice = (title: string, hint: string, on: boolean, onPress: () => void) => (
    <Press
      key={title}
      onPress={() => {
        haptic.select()
        onPress()
      }}
      scale={false}
      accessibilityRole="radio"
      accessibilityState={{ selected: on }}
      style={[
        styles.choice,
        { backgroundColor: on ? c.tintSoft : c.fill, borderColor: on ? c.tint : 'transparent' },
      ]}
    >
      <Text style={[typeScale.callout, { color: on ? c.tint : c.text, fontWeight: '600' }]}>
        {title}
      </Text>
      <Text style={[typeScale.footnote, { color: c.textSecondary }]}>{hint}</Text>
    </Press>
  )

  const keyHint = providers
    ? '你自己的 key 和服务商。'
    : chosen?.harnessId === 'deepseek'
      ? 'DeepSeek 的 API key。'
      : chosen?.harnessId === 'codebuddy'
        ? '上面所选站点的 API key。'
        : 'OpenAI 的 API key。'

  return (
    <FormSheet
      visible={props.visible}
      title="添加 Agent"
      message="选择一个 Harness 和配置。已经在用的登录可以继续使用。"
      onClose={props.onClose}
      submitLabel="添加 Agent"
      canSubmit={valid}
      onSubmit={submit}
      maxHeight={720}
    >
      <FieldLabel>Harness</FieldLabel>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        {props.harnesses.map((h) =>
          chip(
            h.harnessName,
            h.harnessId === chosen?.harnessId,
            () => {
              setHarness(h.harnessId)
              setFolder('default')
            },
            h.harnessId,
          ),
        )}
      </ScrollView>

      <FieldLabel>配置</FieldLabel>
      {canUseDefault
        ? choice(
            '沿用现有的配置',
            `终端里的 ${chosen?.harnessName ?? ''} 也使用这个目录，账号和设置是同一份。`,
            useDefault,
            () => setFolder('default'),
          )
        : null}
      {multiple
        ? choice(
            '新建一个',
            '纸鸢在你的主目录下的 .huli/agents 里新建，加好后登录。',
            selected === 'new',
            () => setFolder('new'),
          )
        : null}
      {multiple ? <FieldNote>要用电脑上已有的配置目录，请在电脑上的纸鸢里添加。</FieldNote> : null}

      {!useDefault ? (
        <>
          <FieldLabel>名字</FieldLabel>
          <Field
            value={name}
            onChangeText={setName}
            placeholder="比如 公司 API"
            autoCapitalize="sentences"
            returnKeyType="next"
          />
          {tooLong ? <FieldNote error>{`最多 ${AGENT_NAME_CHARS} 个字`}</FieldNote> : null}

          {keyOnly ? (
            <>
              <FieldLabel>站点</FieldLabel>
              <View style={styles.row}>
                {chip('国际站', site === 'international', () => setSite('international'), 'intl')}
                {chip('国内站', site === 'china', () => setSite('china'), 'china')}
              </View>
              <FieldNote>Codebuddy 有国际站和国内站，API key 必须来自这里选的站点。</FieldNote>
            </>
          ) : null}

          <FieldLabel>登录方式</FieldLabel>
          {!keyOnly
            ? choice(
                '在终端中',
                `${chosen?.harnessName ?? ''} 自己登录，使用你的套餐。`,
                mode === 'terminal',
                () => setLogin('terminal'),
              )
            : null}
          {choice('使用 API key', keyHint, mode === 'api-key', () => setLogin('api-key'))}
          {mode === 'api-key' ? (
            <>
              <Field
                value={key.key}
                onChangeText={(text) => setKey((k) => ({ ...k, key: text }))}
                placeholder="API key"
                secureTextEntry
                mono
                textContentType="password"
              />
              {providers ? (
                <>
                  <Field
                    value={key.baseUrl}
                    onChangeText={(text) => setKey((k) => ({ ...k, baseUrl: text }))}
                    placeholder="Base URL（可选）"
                    keyboardType="url"
                    mono
                  />
                  <Field
                    value={key.model}
                    onChangeText={(text) => setKey((k) => ({ ...k, model: text }))}
                    placeholder="模型（可选）"
                    mono
                  />
                </>
              ) : null}
              {keyOnly ? (
                <FieldNote>
                  {`这个 Agent 只能用 API key 登录。${chosen?.harnessName ?? ''} 的浏览器和微信登录整台电脑共用一份，存在这个 Agent 的目录之外，再加一个 Agent 也是同一个账号。`}
                </FieldNote>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </FormSheet>
  )
}

const styles = StyleSheet.create({
  tags: { flexDirection: 'row', gap: space.xs, alignItems: 'center' },
  row: { flexDirection: 'row', gap: space.sm, paddingRight: space.lg },
  chip: {
    height: 36,
    paddingHorizontal: space.md + 2,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  choice: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.md + 2,
    paddingVertical: space.md,
    gap: 2,
  },
})
