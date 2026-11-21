// Settings › Agent › one agent: its state, turning it off, signing in and out, its account and API
// key, its plan usage, its configuration, and removing it.

import { useEffect, useRef, useState } from 'react'
import { Alert, StyleSheet, Text, View } from 'react-native'
import { Image } from 'expo-image'
import * as Clipboard from 'expo-clipboard'
import { randomUUID } from 'expo-crypto'
import { router, useLocalSearchParams } from 'expo-router'
import type {
  AgentAuthMethod,
  AgentStatus,
  ClaudeCompactRow,
  HostEvent,
  PlanLimit,
  ResetSpendCode,
} from '@shared/agent-host'
import {
  AUTO_COMPACT_STEPS,
  KNOWN_CLAUDE_MODELS,
  signsInWithKeyOnly,
  takesClaudeSettings,
} from '@shared/agents'
import { AGENT_NAME_CHARS } from '@shared/settings'
import type { AgentId } from '@shared/thread'
import { admin } from '../../admin'
import { RenameDialog } from '../../components/RenameDialog'
import { Sheet, type SheetItem } from '../../components/Sheet'
import { useHost } from '../../host'
import { platformOf } from '../../linkInfo'
import { currentLimits, harnessVersion, percent, readiness, stateText } from '../../manage/agents'
import {
  agentChoice,
  agentExit,
  choiceText,
  exitText,
  useNetworkStatus,
} from '../../manage/network'
import {
  Button,
  call,
  Code,
  confirm,
  fail,
  Field,
  FieldLabel,
  FieldNote,
  FormSheet,
  GroupNote,
  homeShort,
  ManagePage,
  Notice,
  ReadState,
  SkeletonGroup,
  SwitchRow,
  Tag,
  useActions,
  useConnected,
  useHostSettings,
  useRead,
  type Read,
} from '../../manage/kit'
import { trashName } from '../../system/device'
import { AgentAvatar } from '../../ui/AgentAvatar'
import { EmptyState } from '../../ui/EmptyState'
import { haptic } from '../../ui/haptics'
import { ListGroup, ListRow } from '../../ui/ListRow'
import {
  balanceText,
  canReadLimits,
  limitColor,
  limitsWhy,
  readText,
  resetText,
  windowName,
} from '../../ui/session/limits'
import { radius, space, type as typeScale, useTokens } from '../../ui/tokens'
import { openUrl } from '../../system/openUrl'

export default function AgentScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>()
  const host = useHost()
  const status = id ? host.agents.get(id as AgentId) : undefined
  const list: Read<AgentStatus> = {
    value: host.loaded ? (status ?? null) : null,
    error: null,
    reload: () => host.refresh().catch(() => {}),
    set: () => {},
  }
  const empty = ReadState({ read: list, what: 'Agent', icon: 'sparkles' })
  if (!status) {
    return (
      <ManagePage title="Agent" onRefresh={() => host.refresh()}>
        {empty ?? (
          <EmptyState
            icon="sparkles"
            title="找不到这个 Agent"
            message="它可能已在电脑上移除。"
            action={{ label: '返回', onPress: () => router.back() }}
          />
        )}
      </ManagePage>
    )
  }
  return <AgentBody status={status} />
}

// Huli: uninstalling the agent's program and deleting its data list each folder and command with
// sizes, which the computer's Settings shows; the phone only removes the agent.
const ON_COMPUTER = '要同时从电脑上卸载它，或删除它在电脑上的数据，请在电脑上的纸鸢里移除。'

/** Whether the sign-in method finishes on the phone, on the computer, or in a terminal there. */
function methodWhere(method: AgentAuthMethod): 'phone' | 'computer' | 'terminal' | 'env' {
  if (method.type === 'env') return 'env'
  if (method.type === 'terminal') return 'terminal'
  return method.delegated ? 'phone' : 'computer'
}

function AgentBody({ status }: { status: AgentStatus }) {
  const { c } = useTokens()
  const host = useHost()
  const connected = useConnected()
  const { busy, run } = useActions()
  const [reading, setReading] = useState(true)
  const [renaming, setRenaming] = useState(false)
  const [keyOpen, setKeyOpen] = useState(false)
  const [envVar, setEnvVar] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const [page, setPage] = useState<string | null>(null)
  // Huli: the picture to scan, such as Doubao's QR code, while the sign-in waits for it.
  const [image, setImage] = useState<string | null>(null)
  const id = status.id
  const r = readiness(status)
  const state = stateText(status)
  const version = harnessVersion(status)
  const account = status.account?.kind === 'none' ? null : status.account
  const providerMode = status.providers !== undefined
  const hasOthers = [...host.agents.values()].some(
    (s) => s.id !== id && s.harnessId === status.harnessId && s.registered !== false,
  )

  const details = useRead(
    `agent-details:${id}:${status.state}:${status.task?.state ?? ''}:${status.configDir?.runs ?? ''}`,
    (link) => call(link, 'agents.details', { agentId: id }),
  )

  const forceRead = status.signIn === 'required'
  useEffect(() => {
    if (!connected || !host.link) return
    let live = true
    setReading(true)
    call(host.link, 'agents.refreshAccount', { agentId: id, ...(forceRead ? { force: true } : {}) })
      .catch(() => {})
      .finally(() => live && setReading(false))
    return () => {
      live = false
    }
  }, [connected, host.link, id, forceRead])

  useEffect(() => {
    if (!host.link) return
    return host.link.onHostEvent((raw) => {
      const event = raw as HostEvent
      if (event.type === 'agents.signInLink' && event.agentId === id) {
        setPage(event.url)
        openUrl(event.url)
      }
      if (event.type === 'agents.signInImage' && event.agentId === id) {
        const shown = event.image
        setImage(shown?.mimeType === 'image/png' ? `data:image/png;base64,${shown.data}` : null)
      }
    })
  }, [host.link, id])

  const refresh = async () => {
    await host.refresh()
    if (host.link) {
      await call(host.link, 'agents.refreshAccount', { agentId: id, force: true }).catch(() => {})
    }
    await details.reload()
  }

  const authenticate = (method: AgentAuthMethod) => {
    const link = host.link
    if (!link) return
    void run(
      'sign-in',
      async () => {
        try {
          await call(link, 'agents.authenticate', { agentId: id, methodId: method.id })
        } finally {
          setPage(null)
          setImage(null)
        }
      },
      '没能登录',
    )
  }

  const cancelSignIn = () => {
    setPage(null)
    setImage(null)
    if (host.link) void call(host.link, 'agents.cancelSignIn', { agentId: id }).catch(() => {})
  }

  const signOut = async () => {
    if (status.sharesSignIn) {
      const go = await confirm({
        title: `退出 ${status.name} 的登录？`,
        message: `${status.name} 和 Antigravity 应用、CLI 共用一份登录，它们也会一起退出。`,
        confirm: '退出登录',
      })
      if (!go) return
    }
    await run('logout', () => call(host.link!, 'agents.logout', { agentId: id }), '没能退出登录')
  }

  const clearKey = async () => {
    const go = await confirm({
      title: `清除 ${status.name} 的 API key？`,
      confirm: '清除',
    })
    if (!go) return
    await run(
      'clear-key',
      () => call(host.link!, 'agents.clearApiKey', { agentId: id }),
      '没能清除',
    )
  }

  const remove = async (trash: boolean) => {
    const done = await run(
      'remove',
      async () => {
        await admin(host.link!, 'settings.removeAgent', { agentId: id, trash })
        await host.refresh().catch(() => {})
      },
      '没能移除 Agent',
    )
    if (done) router.back()
  }

  const askRemove = async () => {
    if (status.configDir?.created) {
      haptic.warning()
      setRemoving(true)
      return
    }
    const go = await confirm({
      title: `移除 ${status.name}？`,
      message: `它的会话仍留在列表里，标明 Agent 已移除，不能再继续。\n\n${
        status.isDefault
          ? `它使用终端里 ${status.harnessName} 的配置，这不会改动；Harness 也不会被卸载。`
          : '它的配置目录是你选的，原样保留。'
      }\n\n${ON_COMPUTER}`,
      confirm: '移除',
    })
    if (go) await remove(false)
  }

  const methods = status.authMethods
  const terminal = methods.filter((m) => methodWhere(m) === 'terminal' && m.command)
  const onPhone = methods.filter((m) => methodWhere(m) === 'phone')
  const elsewhere = methods.find((m) => methodWhere(m) === 'computer')
  const envVars = methods
    .filter((m) => m.type === 'env')
    .flatMap((m) => (m.envVars ?? []).map((v) => ({ method: m.id, ...v })))

  const header = (
    <View style={[styles.hero, { backgroundColor: c.surface, borderColor: c.border }]}>
      <AgentAvatar agentId={id} name={status.name} size={56} />
      <View style={styles.flex}>
        <View style={styles.titleLine}>
          <Text style={[typeScale.title, styles.shrink, { color: c.text }]} numberOfLines={2}>
            {status.name}
          </Text>
          {status.isDefault && hasOthers ? <Tag label="默认" /> : null}
        </View>
        <Text style={[typeScale.footnote, { color: c.textSecondary }]} numberOfLines={2}>
          {status.harnessName}
          {account ? ` · ${account.label}` : ''}
        </Text>
        <View style={styles.titleLine}>
          <Tag label={state.text} tone={state.tone} />
          <Text
            style={[typeScale.footnote, styles.shrink, { color: c.textTertiary }]}
            numberOfLines={1}
          >
            {`运行于 ${version ? `${status.harnessName} ${version}` : status.harnessName}`}
          </Text>
        </View>
      </View>
      {!status.isDefault ? (
        <Button label="改名" onPress={() => setRenaming(true)} disabled={!connected} />
      ) : null}
    </View>
  )

  return (
    <ManagePage
      title={status.name}
      onRefresh={refresh}
      overlay={
        <>
          <RenameDialog
            visible={renaming}
            heading="给 Agent 改名"
            placeholder="名字"
            noReset
            maxLength={AGENT_NAME_CHARS}
            title={status.name}
            onClose={() => setRenaming(false)}
            onSave={async (name) => {
              if (!name) throw new Error('名字不能为空。')
              if (name === status.name) return
              await admin(host.link!, 'settings.renameAgent', { agentId: id, name })
              await host.refresh().catch(() => {})
            }}
          />
          <ApiKeySheet status={status} visible={keyOpen} onClose={() => setKeyOpen(false)} />
          <EnvSheet
            agentId={id}
            agentName={status.name}
            variable={envVar}
            onClose={() => setEnvVar(null)}
          />
          <Sheet
            visible={removing}
            title={`移除 ${status.name}？`}
            message={`它的会话仍留在列表里，标明 Agent 已移除，不能再继续。这个目录是纸鸢新建的，里面有它的登录凭据和 Harness 的会话记录。\n\n${ON_COMPUTER}`}
            items={[
              {
                key: 'keep',
                label: '移除',
                destructive: true,
                onPress: () => void remove(false),
              },
              {
                key: 'trash',
                label: `移除，并把它的配置目录移到${trashName(
                  platformOf(
                    host.host,
                    host.state.kind === 'connected' ? host.state.welcome.host.platform : undefined,
                  ),
                )}`,
                destructive: true,
                onPress: () => void remove(true),
              },
            ]}
            onClose={() => setRemoving(false)}
          />
        </>
      }
    >
      {header}

      <EnableGroup status={status} />

      {r.kind === 'failed' ? (
        <Notice
          tone="error"
          title={`${status.harnessName} 没能启动`}
          actions={
            <Button
              label="重试"
              tone="primary"
              icon="refresh"
              busy={busy('retry')}
              disabled={!connected}
              onPress={() =>
                void run(
                  'retry',
                  () => call(host.link!, 'agents.retry', { agentId: id }),
                  '没能重试',
                )
              }
            />
          }
        >
          {r.message}
        </Notice>
      ) : null}
      {r.kind === 'missing' ? (
        <Notice
          tone="warning"
          title={r.message}
          actions={
            <Button
              label={`到 Harness 里打开 ${status.harnessName}`}
              onPress={() =>
                router.push({ pathname: '/settings/harness', params: { id: status.harnessId } })
              }
            />
          }
        />
      ) : null}
      {status.movedAccounts?.refused ? (
        <Notice
          tone="warning"
          title={`${status.name} 用不了这个账号`}
          actions={
            <Button
              label={`打开 ${host.agents.get(status.movedAccounts.to)?.harnessName ?? status.movedAccounts.to}`}
              onPress={() =>
                router.push({
                  pathname: '/settings/harness',
                  params: { id: status.movedAccounts!.to },
                })
              }
            />
          }
        >
          {status.movedAccounts.audience}
        </Notice>
      ) : null}
      {signsInWithKeyOnly(id) ? (
        <GroupNote>
          {`这个 Agent 只能用 API key 登录。${status.harnessName} 的浏览器和微信登录整台电脑共用一份，存在这个 Agent 的目录之外，再加一个 Agent 也是同一个账号。`}
        </GroupNote>
      ) : null}

      {!providerMode && r.kind === 'sign-in' && methods.length > 0 ? (
        image !== null ? (
          <Notice
            tone="info"
            busy
            title="扫码登录"
            actions={<Button label="取消" tone="plain" onPress={cancelSignIn} />}
          >
            <View style={styles.gap}>
              <Text style={[typeScale.footnote, { color: c.textSecondary }]}>
                {`用${status.name} App 扫这个二维码，然后在手机上确认。`}
              </Text>
              <Image
                source={{ uri: image }}
                style={styles.qr}
                contentFit="contain"
                accessibilityLabel="登录二维码"
              />
            </View>
          </Notice>
        ) : page !== null ? (
          <Notice
            tone="info"
            busy
            title="等待浏览器"
            actions={
              <>
                <Button label="再次打开页面" onPress={() => openUrl(page)} />
                <Button label="取消" tone="plain" onPress={cancelSignIn} />
              </>
            }
          >
            {`${status.name} 的登录页面已在这台设备的浏览器中打开，请在那里完成登录。`}
          </Notice>
        ) : (
          <Notice
            tone="warning"
            title={`登录 ${status.name} 后才能使用`}
            actions={
              onPhone.length > 0 ? (
                <>
                  {onPhone.map((method) => (
                    <Button
                      key={method.id}
                      label={method.name}
                      tone="primary"
                      busy={busy('sign-in')}
                      disabled={!connected}
                      onPress={() => authenticate(method)}
                    />
                  ))}
                  {busy('sign-in') ? (
                    <Button label="取消" tone="plain" onPress={cancelSignIn} />
                  ) : null}
                </>
              ) : undefined
            }
          >
            <View style={styles.gap}>
              {terminal.map((method) => (
                <View key={method.id} style={styles.gap}>
                  {method.description ? (
                    <Text style={[typeScale.footnote, { color: c.textSecondary }]}>
                      {method.description}
                    </Text>
                  ) : null}
                  <Text style={[typeScale.footnote, { color: c.textSecondary }]}>
                    由 Harness 自己在终端里登录，纸鸢不经手凭据。在电脑的终端里运行：
                  </Text>
                  <Code>{method.command!}</Code>
                  <View style={styles.row}>
                    <Button
                      label="复制命令"
                      icon="copy"
                      onPress={() =>
                        void Clipboard.setStringAsync(method.command!).then(() => haptic.success())
                      }
                    />
                  </View>
                </View>
              ))}
              {elsewhere ? (
                <Text style={[typeScale.footnote, { color: c.textSecondary }]}>
                  {`${elsewhere.name}会在 ${status.name} 所在的电脑上打开浏览器，请到那台电脑上登录。`}
                </Text>
              ) : null}
            </View>
          </Notice>
        )
      ) : null}

      {providerMode ? (
        <Providers status={status} />
      ) : (
        <ListGroup header="账号">
          <ListRow
            title={status.account?.kind === 'account' ? '套餐' : '登录方式'}
            value={
              status.account?.kind === 'none' || !status.account
                ? reading && status.capabilities.account
                  ? '正在读取账号…'
                  : '未提供'
                : status.account.label
            }
          />
          {status.account?.email ? (
            <ListRow key="email" title="邮箱" value={status.account.email} />
          ) : null}
          {status.capabilities.account ? (
            <ListRow
              key="refresh-account"
              title="重新读取账号"
              icon="refresh"
              plainIcon
              action
              disabled={!connected || busy('account')}
              trailing={busy('account') ? <Tag label="正在读取…" tone="tint" /> : undefined}
              onPress={() =>
                void run(
                  'account',
                  () => call(host.link!, 'agents.refreshAccount', { agentId: id, force: true }),
                  '没能读取账号',
                )
              }
            />
          ) : null}
          {status.apiKey ? (
            <ListRow
              key="api-key"
              title="API key"
              subtitle={
                status.apiKey.set
                  ? `已设置，${status.harnessName} 把它保存在自己的配置文件夹里。`
                  : status.apiKey.providers
                    ? '用你自己的 key 和服务商，代替登录。'
                    : status.harnessId === 'deepseek'
                      ? '用 DeepSeek 的 API key 代替登录。'
                      : status.harnessId === 'codebuddy'
                        ? '用这个 Agent 所在站点的 API key 代替登录。'
                        : '用 OpenAI 的 API key 代替登录。'
              }
              icon="key"
              plainIcon
              value={status.apiKey.set ? '重新填写…' : '设置…'}
              chevron
              disabled={!connected}
              onPress={() => setKeyOpen(true)}
            />
          ) : null}
          {status.apiKey?.set ? (
            <ListRow
              key="clear-key"
              title="清除 API key"
              destructive
              disabled={!connected || busy('clear-key')}
              onPress={() => void clearKey()}
            />
          ) : null}
          {envVars.map((variable) => (
            <ListRow
              key={`${variable.method}:${variable.name}`}
              title={variable.name}
              subtitle={
                variable.set
                  ? `已设置。纸鸢保存它，只在 ${status.name} 启动时交给它。`
                  : variable.optional
                    ? '可选'
                    : undefined
              }
              icon="key"
              plainIcon
              chevron
              disabled={!connected}
              onPress={() => setEnvVar(variable.name)}
            />
          ))}
          {status.canLogout && status.signIn === 'signed-in' && !status.disabled ? (
            <ListRow
              key="logout"
              title="退出登录"
              icon="signOut"
              plainIcon
              iconTint={c.danger}
              destructive
              disabled={!connected || busy('logout')}
              onPress={() => void signOut()}
            />
          ) : null}
        </ListGroup>
      )}

      {status.balance?.balances.length && !status.disabled ? (
        <ListGroup header="余额">
          {status.balance.balances.map((balance) => {
            const text = balanceText(balance)
            return <ListRow key={balance.label} title={text.name} value={text.value} />
          })}
        </ListGroup>
      ) : null}

      {status.disabled || providerMode ? null : <UsageGroup status={status} reading={reading} />}

      <ListGroup header="配置">
        <ListRow
          title="Harness"
          value={version ? `${status.harnessName} ${version}` : status.harnessName}
          chevron
          onPress={() =>
            router.push({ pathname: '/settings/harness', params: { id: status.harnessId } })
          }
        />
        {details.value === null && details.error === null ? (
          <ListRow key="pending" title="正在读取…" />
        ) : null}
        {details.error !== null && details.value === null ? (
          <ListRow
            key="details-failed"
            title="没能读取配置"
            subtitle={details.error}
            value="重试"
            onPress={() => void details.reload()}
          />
        ) : null}
        {details.value?.config.map((item) => {
          const notes = [
            item.id === 'folder' && status.configDir?.created ? '由纸鸢创建' : null,
            item.chosen ? '在纸鸢中选定' : null,
            item.env ? `由 ${item.env} 设定` : null,
            item.exists ? null : '尚未创建。',
          ].filter(Boolean)
          return (
            <ListRow
              key={item.id}
              title={
                item.id === 'folder' ? '目录' : item.id === 'settings' ? '设置文件' : '指令文件'
              }
              subtitle={[homeShort(item.path), ...notes].join(' · ')}
            />
          )
        }) ?? null}
        {details.value && details.value.config.length === 0 ? (
          <ListRow key="no-config" title="没有可显示的配置文件。" />
        ) : null}
      </ListGroup>

      {takesClaudeSettings(id) ? <ClaudeSettingsGroup agentId={id} /> : null}

      <NetworkGroup agentId={id} />

      <ListGroup footer="它的会话会留着，但不能再继续。新会话的模式和标志颜色在电脑上的纸鸢里设置。">
        <ListRow
          title="移除 Agent…"
          destructive
          disabled={!connected || busy('remove')}
          onPress={() => void askRemove()}
        />
      </ListGroup>
    </ManagePage>
  )
}

/** 网络出口: the node or interface the agent goes through, and where its traffic last left from. */
function NetworkGroup({ agentId }: { agentId: AgentId }) {
  const read = useNetworkStatus()
  const status = read.value
  // A computer without the agent network (the daemon, an older app) has nothing to pick here.
  if (!status?.available) return null
  const exit = exitText(agentExit(status, agentId))
  return (
    <ListGroup
      footer={
        status.enabled
          ? '切换到系统网络或从系统网络切出，要等它下次启动才生效。'
          : 'Agent 网络在电脑上已关闭，所有 Agent 都用系统网络。'
      }
    >
      <ListRow
        title="网络出口"
        subtitle={exit ?? undefined}
        value={status.enabled ? choiceText(status, agentChoice(status, agentId)) : '系统网络'}
        chevron
        onPress={() =>
          router.push({ pathname: '/settings/network-node', params: { target: agentId } })
        }
      />
    </ListGroup>
  )
}

/** Turns the agent off and on: off, it never starts and nothing offers it, and nothing is lost. */
function EnableGroup({ status }: { status: AgentStatus }) {
  const host = useHost()
  const settings = useHostSettings()
  const connected = useConnected()
  const [busy, setBusy] = useState(false)
  if (status.disabled === undefined) return null
  const stored = settings.value?.disabledAgents
  const off = stored ? stored.includes(status.id) : status.disabled
  const running = [...host.sessions.values()].filter(
    (s) =>
      s.agentId === status.id && (s.status === 'running' || s.status === 'awaiting_permission'),
  ).length
  const set = async (disabled: boolean) => {
    const others = (stored ?? []).filter((id) => id !== status.id)
    setBusy(true)
    try {
      await settings.update({ disabledAgents: disabled ? [...others, status.id] : others })
      haptic.success()
    } catch (failure) {
      fail(disabled ? '没能停用' : '没能启用', failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <ListGroup
      footer={
        off
          ? '已停用：不会启动，也不在选 Agent 的地方列出；会话、登录和配置都留着。'
          : '可以在新会话和定时任务里选它。'
      }
    >
      <SwitchRow
        title="启用"
        value={!off}
        busy={busy}
        disabled={!connected || settings.value === null}
        onChange={(on) => {
          if (on || running === 0) {
            void set(!on)
            return
          }
          void confirm({
            title: `停用 ${status.name}？`,
            message: `这个 Agent 有 ${running} 个会话正在运行回合，停用会停掉这些回合。`,
            confirm: '停用',
          }).then((go) => {
            if (go) void set(true)
          })
        }}
      />
    </ListGroup>
  )
}

function LimitRow({ limit }: { limit: PlanLimit }) {
  const { c } = useTokens()
  const used = Math.max(0, Math.min(100, limit.usedPercent ?? 0))
  return (
    <View
      style={styles.limit}
      accessible
      accessibilityLabel={`${windowName(limit)}：已用 ${percent(limit)}`}
    >
      <View style={styles.limitLine}>
        <Text style={[typeScale.body, styles.flex, { color: c.text }]} numberOfLines={1}>
          {windowName(limit)}
        </Text>
        <Text style={[typeScale.callout, { color: c.textSecondary }]}>{percent(limit)}</Text>
      </View>
      <View style={[styles.track, { backgroundColor: c.track }]}>
        <View style={[styles.fill, { width: `${used}%`, backgroundColor: limitColor(limit, c) }]} />
      </View>
      {limit.resetsAt ? (
        <Text style={[typeScale.footnote, { color: c.textTertiary }]}>
          {resetText(limit.resetsAt)}
        </Text>
      ) : null}
    </View>
  )
}

const RESET_OUTCOME: Record<ResetSpendCode, string> = {
  reset: '已重置，用量已重新读取。',
  nothing_to_reset: '现在没有可以重置的用量窗口，卡没有用掉。',
  no_credit: '账号里已经没有可用的重置卡。',
  already_redeemed: '这张卡刚才已经用过了。',
}

/** Why the reset credits could not be read in full, as the desktop's usage card says it. */
const RESETS_ERROR: Record<NonNullable<AgentStatus['resetsError']>, string> = {
  'sign-in-expired': 'Codex 的登录已过期，重新登录后才能读取重置卡。',
  details: '读到了重置卡的张数，但没读到每张的有效期，暂时不能在这里使用。',
  failed: '没能读取重置卡，稍后会再试。',
}

/** Plan usage, one row per window, with the read and why there is none. */
function UsageGroup({ status, reading }: { status: AgentStatus; reading: boolean }) {
  const host = useHost()
  const connected = useConnected()
  const { busy, run } = useActions()
  const limits = currentLimits(status.limits)
  const observed = Math.max(0, ...limits.map((l) => l.observedAt)) || null
  const readable = canReadLimits(status)
  const refresh = () =>
    void run(
      'limits',
      () =>
        call(host.link!, 'agents.refreshLimits', { agentId: status.id, force: true, ask: true }),
      '没能读取套餐用量',
    )
  const resets = status.resets
  // A credit is spent by its id, which only a read with the details gives.
  const next = resets?.each?.[0] ?? null
  const redeemCredit = async () => {
    if (!resets || !next) return
    const go = await confirm({
      title: '使用一张重置卡？',
      message: `会立即重置正在计算的用量窗口，用掉后不能退回。${next.until === null ? '' : `用掉的是最早到期的一张（${new Date(next.until).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} 到期）。`}现在还有 ${resets.count} 张。`,
      confirm: '使用一张',
      destructive: false,
    })
    if (!go) return
    // One id for this attempt: Codex answers a repeat of it without spending a second credit.
    const requestId = randomUUID()
    await run(
      'reset',
      async () => {
        const { code } = await call(host.link!, 'agents.spendReset', {
          agentId: status.id,
          creditId: next.id,
          requestId,
        })
        Alert.alert(RESET_OUTCOME[code])
      },
      '没能使用重置卡',
    )
  }
  const reason =
    status.limitsReason || status.account?.kind === 'api_key'
      ? limitsWhy(status)
      : reading && status.capabilities.reports
        ? '正在读取套餐用量…'
        : status.signIn === 'required' && status.capabilities.reports
          ? `${status.name} 登录后，套餐用量会显示在这里。`
          : !status.capabilities.reports
            ? `${status.name} 不提供套餐用量。`
            : null
  return (
    <View style={styles.gap}>
      <ListGroup
        header="套餐用量"
        footer={
          status.limitsError ??
          (observed && limits.length > 0 ? readText(observed) : undefined) ??
          undefined
        }
      >
        {limits.length > 0 ? (
          limits.map((limit) => <LimitRow key={limit.window} limit={limit} />)
        ) : reason ? (
          <ListRow key="reason" title={reason} />
        ) : (
          <ListRow key="none" title="套餐限额" value="—" />
        )}
        {limits.length > 0
          ? (status.balances ?? []).map((balance) => {
              const text = balanceText(balance)
              return (
                <ListRow
                  key={`${balance.label}/${balance.currency}`}
                  title={text.name}
                  subtitle={
                    balance.label === 'Extra usage' ? '套餐用量用完后，从这里继续扣。' : undefined
                  }
                  value={text.value}
                />
              )
            })
          : null}
        {resets || status.resetsError ? (
          <ListRow
            key="reset-credits"
            title="重置卡"
            subtitle={
              status.resetsError
                ? RESETS_ERROR[status.resetsError]
                : next
                  ? '用一张可以立即重置当前的用量窗口。'
                  : '账号里现在没有可用的重置卡。'
            }
            value={resets ? `${resets.count} 张` : '—'}
            action={next !== null}
            disabled={!connected || busy('reset') || next === null}
            trailing={busy('reset') ? <Tag label="正在重置…" tone="tint" /> : undefined}
            onPress={() => void redeemCredit()}
          />
        ) : null}
        {readable ? (
          <ListRow
            key="refresh"
            title={limits.length > 0 ? '重新读取套餐用量' : '查看套餐限额'}
            icon="refresh"
            plainIcon
            action
            disabled={!connected || busy('limits')}
            trailing={busy('limits') ? <Tag label="正在读取…" tone="tint" /> : undefined}
            onPress={refresh}
          />
        ) : null}
      </ListGroup>
    </View>
  )
}

/** An OpenCode agent's providers, as it reports them; added and signed in on the computer. */
function Providers({ status }: { status: AgentStatus }) {
  const providers = status.providers ?? []
  return (
    <ListGroup
      header="厂商"
      footer={
        status.providersError ??
        '在电脑上的纸鸢里添加厂商、登录或填写 key；这里只显示它们的状态和用量。'
      }
    >
      {providers.length === 0 ? (
        <ListRow key="none" title="还没有连接厂商。" />
      ) : (
        providers.map((provider) => {
          const active = provider.accounts.find((a) => a.active) ?? provider.accounts[0]
          const limits = provider.usage?.limits ?? []
          const line = [
            active
              ? active.needsAuth
                ? '需要登录'
                : `${active.active ? '使用中' : '已连接'} · ${active.label}`
              : '未连接',
            ...limits.map((l) => `${windowName(l)} ${percent(l)}`),
            ...(provider.usage?.balances ?? []).map((b) => {
              const text = balanceText(b)
              return `${text.name} ${text.value}`
            }),
          ]
          return <ListRow key={provider.id} title={provider.name} subtitle={line.join(' · ')} />
        })
      )}
    </ListGroup>
  )
}

function ApiKeySheet(props: { status: AgentStatus; visible: boolean; onClose(): void }) {
  const host = useHost()
  const { status } = props
  const [value, setValue] = useState({ key: '', baseUrl: '', model: '' })
  useEffect(() => {
    if (props.visible) setValue({ key: '', baseUrl: '', model: '' })
  }, [props.visible])
  const providers = status.apiKey?.providers ?? false
  const note = providers
    ? `key 交给 Claude Code，存进这个 Agent 配置目录里的 settings.json；纸鸢不留副本，也不读回。终端里用这个目录运行 ${status.cli?.command ?? ''} 也能用。`
    : status.harnessId === 'codebuddy'
      ? 'key 交给 Codebuddy Code，存进这个 Agent 配置目录里的 settings.json；纸鸢不留副本，也不读回。要在这个 Agent 用的站点上创建 key：国际站在 codebuddy.ai/profile/keys，国内站在 copilot.tencent.com/profile。'
      : 'key 经 Codex 自己的 codex login 保存；纸鸢不留副本。要接别的服务商，在这个目录的 config.toml 里自己配。'
  const warning = status.isDefault
    ? status.cli?.command
      ? `这是终端里 ${status.harnessName} 也在用的目录，终端里的 ${status.cli.command} 也会改用这个 key。`
      : `这是终端里 ${status.harnessName} 也在用的目录，终端里也会改用这个 key。`
    : undefined
  return (
    <FormSheet
      visible={props.visible}
      title={`${status.name} 的 API key`}
      message={warning}
      onClose={props.onClose}
      submitLabel="保存"
      canSubmit={value.key.trim().length > 0}
      onSubmit={async () => {
        await call(host.link!, 'agents.setApiKey', {
          agentId: status.id,
          key: value.key.trim(),
          ...(providers && value.baseUrl.trim() ? { baseUrl: value.baseUrl.trim() } : {}),
          ...(providers && value.model.trim() ? { model: value.model.trim() } : {}),
        })
      }}
    >
      <FieldLabel>API key</FieldLabel>
      <Field
        value={value.key}
        onChangeText={(key) => setValue((v) => ({ ...v, key }))}
        placeholder="API key"
        secureTextEntry
        textContentType="password"
        mono
        autoFocus
      />
      {providers ? (
        <>
          <FieldLabel>服务地址</FieldLabel>
          <Field
            value={value.baseUrl}
            onChangeText={(baseUrl) => setValue((v) => ({ ...v, baseUrl }))}
            placeholder="Base URL（可选）"
            keyboardType="url"
            mono
          />
          <FieldNote>留空就是 Anthropic 官方；第三方网关填它给的地址。</FieldNote>
          <FieldLabel>模型</FieldLabel>
          <Field
            value={value.model}
            onChangeText={(model) => setValue((v) => ({ ...v, model }))}
            placeholder={`可选，留空用 ${status.harnessName} 的默认`}
            mono
          />
        </>
      ) : null}
      <FieldNote>{note}</FieldNote>
    </FormSheet>
  )
}

/** A variable an agent signs in with, which Huli keeps and hands it when it starts. */
function EnvSheet(props: {
  agentId: AgentId
  agentName: string
  variable: string | null
  onClose(): void
}) {
  const host = useHost()
  const [value, setValue] = useState('')
  const status = host.agents.get(props.agentId)
  const set = status?.authMethods
    .flatMap((m) => m.envVars ?? [])
    .find((v) => v.name === props.variable)?.set
  const shown = useRef(props.variable)
  if (props.variable !== null) shown.current = props.variable
  useEffect(() => {
    if (props.variable !== null) setValue('')
  }, [props.variable])
  const save = (next: string | null) =>
    admin(host.link!, 'marketplace.setAgentEnv', {
      agentId: props.agentId,
      variable: shown.current ?? '',
      value: next,
    }).then(() => host.refresh().catch(() => {}))
  return (
    <FormSheet
      visible={props.variable !== null}
      title={shown.current ?? ''}
      message={set ? `已设置。纸鸢保存它，只在 ${props.agentName} 启动时交给它。` : undefined}
      onClose={props.onClose}
      submitLabel="保存"
      canSubmit={value.trim().length > 0}
      onSubmit={() => save(value)}
    >
      <Field
        value={value}
        onChangeText={setValue}
        placeholder={shown.current ?? ''}
        secureTextEntry
        mono
        autoFocus
      />
      {set ? (
        <View style={styles.row}>
          <Button
            label="清除"
            tone="danger"
            onPress={() =>
              void confirm({ title: `清除 ${shown.current}？`, confirm: '清除' }).then((go) => {
                if (!go) return
                save(null).then(
                  () => {
                    haptic.success()
                    props.onClose()
                  },
                  (failure: unknown) => fail('没能清除', failure),
                )
              })
            }
          />
        </View>
      ) : null}
    </FormSheet>
  )
}

const AUTO = 'auto'

/** A window as the desktop writes it: 200K, 750K, 1M. */
function windowLabel(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
  return `${Math.round(tokens / 1000)}K`
}

/** A Claude Code agent's auto-compact windows and prompt cache duration, in its settings file. */
function ClaudeSettingsGroup({ agentId }: { agentId: AgentId }) {
  const host = useHost()
  const connected = useConnected()
  const read = useRead(`claude-settings:${agentId}`, (link) =>
    call(link, 'agents.claudeSettings', { agentId }),
  )
  const [added, setAdded] = useState<string[]>([])
  const [picker, setPicker] = useState<{ title: string; items: SheetItem[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const settings = read.value

  const save = async (change: Parameters<typeof saveChange>[1]) => {
    setBusy(true)
    try {
      await saveChange(host, change, agentId)
      await read.reload()
      haptic.success()
    } catch (failure) {
      fail('没能保存', failure)
    } finally {
      setBusy(false)
    }
  }

  const windowItems = (current: number | null, auto: string, model: string | null): SheetItem[] => {
    const steps =
      current !== null && !AUTO_COMPACT_STEPS.includes(current)
        ? [...AUTO_COMPACT_STEPS, current].sort((a, b) => a - b)
        : AUTO_COMPACT_STEPS
    return [
      {
        key: AUTO,
        label: auto,
        checked: current === null,
        onPress: () => void save({ setting: 'autoCompactWindow', model, value: null }),
      },
      ...steps.map((tokens) => ({
        key: String(tokens),
        label: windowLabel(tokens),
        checked: current === tokens,
        onPress: () => void save({ setting: 'autoCompactWindow', model, value: tokens }),
      })),
    ]
  }

  if (!settings) {
    if (read.error) {
      return (
        <ListGroup header="Claude Code">
          <ListRow
            title="没能读取设置文件"
            subtitle={read.error}
            value="重试"
            onPress={() => void read.reload()}
          />
        </ListGroup>
      )
    }
    return <SkeletonGroup rows={2} />
  }

  const rows: ClaudeCompactRow[] = [
    ...settings.compact,
    ...added
      .filter((model) => !settings.compact.some((row) => row.model === model))
      .map((model) => ({ model, name: null, window: null })),
  ]
  const nameOf = (row: ClaudeCompactRow) =>
    row.name ?? KNOWN_CLAUDE_MODELS.find((m) => m.id === row.model)?.name ?? row.model
  const unshown = KNOWN_CLAUDE_MODELS.filter((m) => !rows.some((row) => row.model === m.id))
  const disabled = !connected || busy

  return (
    <>
      <ListGroup
        header="自动压缩窗口"
        footer="对话累积到多少 token 时，Claude Code 开始压缩它。可以给所有模型设一个，也可以给某个模型另设。Auto 由 Claude Code 自己决定。项目自己的设置在该项目里优先，改动从下一个会话起生效。"
      >
        <ListRow
          title="所有模型"
          value={settings.defaultWindow === null ? 'Auto' : windowLabel(settings.defaultWindow)}
          chevron
          disabled={disabled}
          onPress={() =>
            setPicker({
              title: '所有模型',
              items: windowItems(settings.defaultWindow, 'Auto', null),
            })
          }
        />
        {rows.map((row) => (
          <ListRow
            key={row.model}
            title={nameOf(row)}
            value={
              row.window === null
                ? settings.defaultWindow === null
                  ? 'Auto'
                  : '跟随所有模型'
                : windowLabel(row.window)
            }
            chevron
            disabled={disabled}
            onPress={() =>
              setPicker({
                title: nameOf(row),
                items: windowItems(
                  row.window,
                  settings.defaultWindow === null ? 'Auto' : '跟随所有模型',
                  row.model,
                ),
              })
            }
          />
        ))}
        {unshown.length > 0 ? (
          <ListRow
            key="add"
            title="添加模型"
            icon="plus"
            plainIcon
            action
            disabled={disabled}
            onPress={() =>
              setPicker({
                title: '选择模型',
                items: unshown.map((model) => ({
                  key: model.id,
                  label: model.name,
                  detail: model.id,
                  onPress: () => setAdded((list) => [...list, model.id]),
                })),
              })
            }
          />
        ) : null}
      </ListGroup>
      <ListGroup
        header="提示词缓存时长"
        footer="Claude Code 让对话的提示词缓存保持多久。Auto：订阅账号在限额内用 1 小时，API key 和云服务商用 5 分钟；1 小时的缓存写入收费更高。项目自己的设置在该项目里优先，改动从下一个会话起生效。"
      >
        <ListRow
          title="时长"
          value={
            settings.promptCacheTtl === '5m'
              ? '5 分钟'
              : settings.promptCacheTtl === '1h'
                ? '1 小时'
                : 'Auto'
          }
          chevron
          disabled={disabled}
          onPress={() =>
            setPicker({
              title: '提示词缓存时长',
              items: [
                { key: AUTO, label: 'Auto', value: null },
                { key: '5m', label: '5 分钟', value: '5m' as const },
                { key: '1h', label: '1 小时', value: '1h' as const },
              ].map((option) => ({
                key: option.key,
                label: option.label,
                checked: settings.promptCacheTtl === option.value,
                onPress: () => void save({ setting: 'promptCacheTtl', value: option.value }),
              })),
            })
          }
        />
      </ListGroup>
      <Sheet
        visible={picker !== null}
        title={picker?.title}
        items={picker?.items ?? []}
        onClose={() => setPicker(null)}
      />
    </>
  )
}

function saveChange(
  host: ReturnType<typeof useHost>,
  change:
    | { setting: 'autoCompactWindow'; model: string | null; value: number | null }
    | { setting: 'promptCacheTtl'; value: '5m' | '1h' | null },
  agentId: AgentId,
): Promise<void> {
  if (!host.link) return Promise.reject(new Error('电脑没有连上。'))
  return call(host.link, 'agents.setClaudeSetting', { agentId, change })
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  shrink: { flexShrink: 1 },
  gap: { gap: space.sm },
  row: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  limit: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.xs + 2 },
  limitLine: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  track: { height: 6, borderRadius: 3, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  qr: { width: 200, height: 200, borderRadius: radius.md },
})
