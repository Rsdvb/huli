// Settings › Agent › one harness: its version and updates, installing it, the program that runs, the
// package Huli adds for it, the agents that use it, and uninstalling it.

import { useState } from 'react'
import { Alert, Linking, StyleSheet, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { router, useLocalSearchParams } from 'expo-router'
import type { AgentInstallMethod, AgentStatus, AgentTask } from '@shared/agent-host'
import type { SettingsPatch } from '@shared/settings'
import type { AgentId } from '@shared/thread'
import { admin } from '../../admin'
import { Sheet } from '../../components/Sheet'
import { useHost } from '../../host'
import {
  adapterOnlyUpdate,
  cliOutdated,
  harnessVersion,
  installKind,
  isInstalled,
  listedInstalled,
  METHOD_NAMES,
  readiness,
  showsCurrent,
  startInstall,
  usableAgents,
  VENDORS,
  type InstallKind,
} from '../../manage/agents'
import {
  Button,
  call,
  Code,
  confirm,
  FieldNote,
  FormSheet,
  GroupNote,
  homeShort,
  LogLines,
  ManagePage,
  Notice,
  ReadState,
  Tag,
  useActions,
  useConnected,
  useRead,
  type Read,
} from '../../manage/kit'
import { ago } from '../../sessions'
import { AgentAvatar } from '../../ui/AgentAvatar'
import { EmptyState } from '../../ui/EmptyState'
import { haptic } from '../../ui/haptics'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { Press } from '../../ui/Press'
import { radius, space, type as typeScale, useTokens } from '../../ui/tokens'

type Actions = ReturnType<typeof useActions>

export default function HarnessScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>()
  const host = useHost()
  const status = id ? host.agents.get(id as AgentId) : undefined
  const list: Read<AgentStatus> = {
    value: host.loaded ? (status ?? null) : null,
    error: null,
    reload: () => host.refresh().catch(() => {}),
    set: () => {},
  }
  const empty = ReadState({ read: list, what: 'Harness', icon: 'box' })
  if (!status) {
    return (
      <ManagePage title="Harness" onRefresh={() => host.refresh()}>
        {empty ?? (
          <EmptyState
            icon="box"
            title="找不到这个 Harness"
            action={{ label: '返回', onPress: () => router.back() }}
          />
        )}
      </ManagePage>
    )
  }
  return <HarnessBody status={status} />
}

function HarnessBody({ status }: { status: AgentStatus }) {
  const { c } = useTokens()
  const host = useHost()
  const connected = useConnected()
  const actions = useActions()
  const { busy, run } = actions
  const [installing, setInstalling] = useState(false)
  const [uninstalling, setUninstalling] = useState(false)
  const [updated, setUpdated] = useState(false)
  const environment = useRead(
    'harness-environment',
    (link) => call(link, 'agents.environment', undefined),
    ['environment.changed'],
  )
  const harness = status.harnessId
  const name = status.harnessName
  const r = readiness(status)
  const outdated = cliOutdated(status) !== null
  const installed = listedInstalled(status) || isInstalled(status) || outdated
  const kind = installKind(status)
  const version = harnessVersion(status)
  const vendor = VENDORS[harness]
  const adapter = status.package?.name.split('/').at(-1)
  const connection = vendor
    ? status.package?.isSdk || harness === 'codex' || harness === 'deepseek'
      ? `${vendor} · 经它自己的接口连接`
      : adapter
        ? `${vendor} · 经 ${adapter} 连接`
        : `${vendor} · 直接以 ACP 模式运行`
    : null
  const users = usableAgents(host.agents.values()).filter((a) => a.harnessId === harness)

  const refresh = async () => {
    await host.refresh()
    await environment.reload()
  }

  const install = (method?: AgentInstallMethod['id'] | null) =>
    void run(
      'install',
      async () => {
        await startInstall(host.link!, harness, method)
        await host.refresh()
      },
      '安装失败',
    )

  const update = () =>
    void run(
      'update',
      async () => {
        await call(host.link!, 'agents.update', { agentId: harness })
        setUpdated(true)
      },
      '更新失败',
    )

  const updateCli = () =>
    void run(
      'update',
      async () => {
        await call(host.link!, 'agents.updateCli', { agentId: harness })
        setUpdated(true)
      },
      '更新失败',
    )

  const cancelTask = () =>
    void run(
      'cancel',
      () => call(host.link!, 'agents.cancelTask', { agentId: harness }),
      '没能取消',
    )

  const retryTask = (task: AgentTask) => {
    if (task.kind === 'update') {
      if (task.method) updateCli()
      else update()
    } else install(task.method)
  }

  const reloadEnvironment = () =>
    void run(
      'environment',
      async () => {
        await call(host.link!, 'agents.reloadEnvironment', undefined)
        await host.refresh()
      },
      '没能重新加载环境',
    )

  const uninstall = (removeProgram: boolean) =>
    void run(
      'uninstall',
      async () => {
        const link = host.link!
        const result = await call(link, 'agents.uninstall', { agentId: harness, removeProgram })
        for (const agent of users) {
          await admin(link, 'settings.removeAgent', { agentId: agent.id, trash: false })
        }
        await admin(link, 'settings.update', {
          patch: { agents: { [harness]: { uninstalled: true, enabled: false } } } as SettingsPatch,
        })
        await host.refresh().catch(() => {})
        if (result.error) {
          haptic.warning()
          Alert.alert(`已卸载 ${name}`, result.error)
        }
      },
      '没能卸载',
    )

  const askUninstall = async () => {
    if (status.uninstallCommand) {
      haptic.warning()
      setUninstalling(true)
      return
    }
    const go = await confirm({
      title: `卸载 ${name}？`,
      message: `纸鸢会删除为 ${name} 安装的包，并移除你在这里添加的 Agent；正在运行的回合会停止。它们的会话仍保留、能查看。你自己的程序、登录和配置目录都不动。`,
      confirm: '卸载',
    })
    if (go) uninstall(false)
  }

  const reinstall = async () => {
    const go = await confirm({
      title: `重新安装 ${status.package?.name ?? name}？`,
      message: '删掉 纸鸢装的这一份，重新安装。',
      confirm: '重新安装',
    })
    if (!go) return
    void run(
      'reinstall',
      () => call(host.link!, 'agents.reinstall', { agentId: harness }),
      '没能重新安装',
    )
  }

  return (
    <ManagePage
      title={name}
      onRefresh={refresh}
      overlay={
        <>
          <InstallSheet
            status={status}
            visible={installing}
            onClose={() => setInstalling(false)}
            onInstall={(method) => install(method)}
            onReload={async () => {
              await call(host.link!, 'agents.reloadEnvironment', undefined)
              await host.refresh()
            }}
          />
          <Sheet
            visible={uninstalling}
            title={`卸载 ${name}？`}
            message={`纸鸢会删除为 ${name} 安装的包，并移除你在这里添加的 Agent；正在运行的回合会停止。它们的会话仍保留、能查看。你自己的程序、登录和配置目录都不动。\n\n${status.uninstallCommand ?? ''}`}
            items={[
              { key: 'keep', label: '卸载', destructive: true, onPress: () => uninstall(false) },
              {
                key: 'program',
                label: '同时用这条命令卸载程序',
                destructive: true,
                onPress: () => uninstall(true),
              },
            ]}
            onClose={() => setUninstalling(false)}
          />
        </>
      }
    >
      <View style={[styles.hero, { backgroundColor: c.surface, borderColor: c.border }]}>
        <AgentAvatar agentId={harness} name={name} size={56} />
        <View style={styles.flex}>
          <Text style={[typeScale.title, { color: c.text }]} numberOfLines={2}>
            {name}
          </Text>
          {connection ? (
            <Text style={[typeScale.footnote, { color: c.textSecondary }]}>{connection}</Text>
          ) : null}
        </View>
      </View>

      {r.kind !== 'failed' && r.kind !== 'missing' && status.detail ? (
        <GroupNote>{status.detail}</GroupNote>
      ) : null}
      {r.kind === 'missing' && !kind && !outdated ? (
        <Notice
          tone="warning"
          title={r.message}
          actions={
            r.url ? (
              <Button
                label={r.action}
                icon="external"
                onPress={() => void Linking.openURL(r.url!).catch(() => {})}
              />
            ) : undefined
          }
        />
      ) : null}

      {status.movedAccounts ? (
        <Notice
          tone={status.movedAccounts.refused ? 'warning' : 'info'}
          title={
            status.movedAccounts.refused ? `${status.name} 用不了这个账号` : `${name} 适合谁用`
          }
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

      <TaskNotice
        status={status}
        installed={installed}
        actions={actions}
        updated={updated}
        onDismissUpdated={() => setUpdated(false)}
        onCancel={cancelTask}
        onRetry={retryTask}
        onUpdate={update}
        onUpdateCli={updateCli}
        onRecheck={reloadEnvironment}
      />

      {r.kind === 'failed' && !status.task ? (
        <Notice
          tone="error"
          title={`${name} 没能启动`}
          actions={
            <Button
              label="重试"
              tone="primary"
              busy={busy('retry')}
              disabled={!connected}
              onPress={() =>
                void run(
                  'retry',
                  () => call(host.link!, 'agents.retry', { agentId: status.id }),
                  '没能重试',
                )
              }
            />
          }
        >
          {r.message}
        </Notice>
      ) : null}

      {status.uninstalled ? (
        <Notice
          tone="info"
          title="已从纸鸢卸载"
          actions={
            <Button
              label="安装"
              tone="primary"
              busy={busy('install')}
              disabled={!connected}
              onPress={() => install()}
            />
          }
        >
          重新安装后即可使用；配置和会话都保留着。
        </Notice>
      ) : null}

      {kind ? (
        <InstallNotice
          status={status}
          kind={kind}
          busy={busy('install')}
          connected={connected}
          onInstall={() => install()}
          onOpen={() => setInstalling(true)}
          onCancel={cancelTask}
        />
      ) : null}

      <VersionGroup status={status} actions={actions} version={version} />

      <ProgramGroup status={status} version={version} />

      {status.package ? (
        <ListGroup
          header="纸鸢装的包"
          footer={
            status.package.isSdk
              ? `纸鸢不带 ${name}，只装驱动它的 SDK；更新只在 ${status.package.version.split('.').slice(0, 2).join('.')}.x 之内。`
              : harness === 'deepseek'
                ? `就是 ${name} 本身，纸鸢用你的 Node.js 运行它。`
                : `纸鸢经这个适配器运行 ${name}，用你的 Node.js。`
          }
        >
          <ListRow
            title={status.package.name}
            subtitle={
              status.package.installed
                ? status.package.isSdk
                  ? `${status.package.version} · 装在纸鸢的数据目录，不含 CLI`
                  : `${status.package.version} · 装在纸鸢的数据目录`
                : '首次使用时安装'
            }
          />
          {status.update ? (
            <ListRow
              key="update"
              title={`更新到 ${status.update.adapterVersion}`}
              icon="download"
              plainIcon
              action
              disabled={!connected || busy('update') || status.task?.state === 'running'}
              onPress={update}
            />
          ) : null}
        </ListGroup>
      ) : null}

      <ListGroup header="Agent">
        <ListRow
          title="在用它的"
          subtitle={users.length > 0 ? users.map((a) => a.name).join('、') : '—'}
        />
        <ListRow
          title="在 Agent 里管理"
          chevron
          onPress={() => router.navigate('/settings/agents')}
        />
      </ListGroup>

      {installed ? (
        <ListGroup header="高级">
          <View style={styles.block}>
            <Text style={[typeScale.body, { color: c.text }]}>启动命令</Text>
            <Code>{status.launchCommand}</Code>
            <View style={styles.row}>
              <Button
                label="复制启动命令"
                icon="copy"
                onPress={() =>
                  void Clipboard.setStringAsync(status.launchCommand).then(() => haptic.success())
                }
              />
            </View>
          </View>
          {status.package?.installed ? (
            <ListRow
              key="reinstall"
              title="重新安装"
              subtitle="删掉 纸鸢装的这一份，重新安装。"
              icon="refresh"
              plainIcon
              action
              disabled={
                !connected || busy('reinstall') || r.kind === 'installing' || r.kind === 'starting'
              }
              trailing={busy('reinstall') ? <Tag label="正在安装…" tone="tint" /> : undefined}
              onPress={() => void reinstall()}
            />
          ) : null}
          {status.package && !status.package.isSdk && environment.value?.nodeVersion ? (
            <ListRow key="node" title="Node.js" value={environment.value.nodeVersion} />
          ) : null}
        </ListGroup>
      ) : null}

      {installed && !status.uninstalled ? (
        <ListGroup footer="删除纸鸢为它安装的包；你自己的程序、登录和配置都保留。">
          <ListRow
            title={`卸载 ${name}…`}
            destructive
            disabled={!connected || busy('uninstall')}
            trailing={busy('uninstall') ? <Tag label="正在卸载…" tone="danger" /> : undefined}
            onPress={() => void askUninstall()}
          />
        </ListGroup>
      ) : null}

      <GroupNote>要换用电脑上别处的程序，请在电脑上的纸鸢里选择可执行文件。</GroupNote>
    </ManagePage>
  )
}

/** A notice's line of text, in the secondary color. */
function Muted({ children }: { children: string }) {
  const { c } = useTokens()
  return (
    <Text style={[typeScale.footnote, { color: c.textSecondary }]} selectable>
      {children}
    </Text>
  )
}

/** An update on offer, under way, failed or just done, in one notice under the title. */
function TaskNotice(props: {
  status: AgentStatus
  installed: boolean
  actions: Actions
  updated: boolean
  onDismissUpdated(): void
  onCancel(): void
  onRetry(task: AgentTask): void
  onUpdate(): void
  onUpdateCli(): void
  onRecheck(): void
}) {
  const host = useHost()
  const connected = useConnected()
  const { status, actions } = props
  const name = status.harnessName
  const harness = status.harnessId
  const task =
    status.task && (status.task.kind === 'update' || props.installed) ? status.task : null
  const updating = task?.kind === 'update'
  const version = harnessVersion(status)
  const cliUpdate = status.cli?.update ?? null
  const next = cliUpdate?.version ?? status.update?.cliVersion ?? status.update?.adapterVersion

  if (task?.state === 'running') {
    return (
      <Notice
        tone="info"
        busy
        title={
          updating && next
            ? `正在将 ${name} 更新到 ${next}…`
            : updating
              ? `正在更新 ${name}`
              : `正在安装 ${name}`
        }
        actions={
          <Button
            label={updating ? '取消更新' : '取消安装'}
            busy={actions.busy('cancel')}
            onPress={props.onCancel}
          />
        }
      >
        <Muted>
          {updating ? '正在运行的会话不受影响。' : (task.progress.at(-1) ?? task.command)}
        </Muted>
        <LogLines lines={task.progress.length > 0 ? task.progress : [task.command]} />
      </Notice>
    )
  }
  if (task?.state === 'failed') {
    return (
      <Notice
        tone="error"
        title={updating ? '更新失败' : '安装失败'}
        actions={
          <>
            <Button
              label="重试"
              icon="refresh"
              tone="primary"
              disabled={!connected}
              onPress={() => props.onRetry(task)}
            />
            <Button
              label="复制日志"
              icon="copy"
              onPress={() =>
                void Clipboard.setStringAsync(
                  [`$ ${task.command}`, ...task.progress, task.error ?? ''].join('\n'),
                ).then(() => haptic.success())
              }
            />
            <Button label="关闭" tone="plain" onPress={props.onCancel} />
          </>
        }
      >
        <Muted>
          {updating
            ? '现在的版本照常可用。如果是网络问题，可以先在电脑上看看 高级 › 代理，再重试。'
            : (task.error ?? '')}
        </Muted>
        <LogLines lines={task.progress.length > 0 ? task.progress : [task.command]} failed />
      </Notice>
    )
  }
  const minimum = cliOutdated(status)
  if (cliUpdate) {
    const isOld = minimum !== null
    return (
      <Notice
        tone={isOld ? 'warning' : 'info'}
        title={isOld ? `${name} 需要更新` : `${name} ${cliUpdate.version} 已发布`}
        actions={
          <Button
            label={`更新到 ${cliUpdate.version}`}
            tone="primary"
            busy={actions.busy('update')}
            disabled={!connected}
            onPress={props.onUpdateCli}
          />
        }
      >
        <Muted>
          {isOld
            ? `你的 ${name} ${version ?? ''} 比纸鸢要的旧，更新后才能用。`
            : status.package?.isSdk
              ? `你装的是 ${version ?? ''}。更新按你装 ${name} 的方式运行，Claude Agent SDK 一并换成对应的版本；命令在下面。`
              : `你装的是 ${version ?? ''}。更新按你装 ${name} 的方式运行，命令在下面。`}
        </Muted>
        <Code>{cliUpdate.command}</Code>
      </Notice>
    )
  }
  if (minimum !== null) {
    return (
      <Notice
        tone="warning"
        title={`${name} 需要更新`}
        actions={
          <Button
            label="重新检测"
            tone="primary"
            busy={actions.busy('environment')}
            disabled={!connected}
            onPress={props.onRecheck}
          />
        }
      >
        {`你的 ${name} ${version ?? ''} 比纸鸢要的旧（至少 ${minimum}）。按你装它的方式更新，装好后再点“重新检测”。`}
      </Notice>
    )
  }
  if (status.update) {
    const adapter = adapterOnlyUpdate(status)
    const cli = status.release ? status.update.adapterVersion : status.update.cliVersion
    const skip = () =>
      void actions.run(
        'skip',
        () =>
          call(host.link!, status.updateSkipped ? 'agents.unskipUpdate' : 'agents.skipUpdate', {
            agentId: harness,
          }),
        '没能更改',
      )
    return (
      <Notice
        tone="info"
        title={
          adapter
            ? `${adapter.name} ${status.update.adapterVersion} 已发布`
            : cli && cli !== version
              ? `${name} ${cli} 已发布`
              : `${name} 有新版本`
        }
        actions={
          <>
            <Button
              label="更新"
              tone="primary"
              busy={actions.busy('update')}
              disabled={!connected}
              onPress={props.onUpdate}
            />
            <Button
              label={status.updateSkipped ? '恢复提醒' : '跳过这次更新'}
              tone="plain"
              busy={actions.busy('skip')}
              disabled={!connected}
              onPress={skip}
            />
          </>
        }
      >
        {adapter
          ? `当前是 ${adapter.name} ${adapter.version}，即运行你的 ${status.cli?.command ?? ''} 的${status.package?.isSdk ? ' SDK' : '适配器'}。新版本装在当前版本旁边：正在运行的会话不受影响，${name} 下次启动时使用新版本，仍然用你的 ${status.cli?.command ?? ''}；装不上也不影响现在的版本。`
          : `当前是 ${status.release?.version ?? version ?? status.package?.version ?? ''}。新版本装在当前版本旁边：正在运行的会话不受影响，${name} 下次启动时使用新版本；装不上也不影响现在的版本。`}
      </Notice>
    )
  }
  if (props.updated) {
    return (
      <Notice
        tone="success"
        title={`${name} 已更新`}
        actions={<Button label="关闭" tone="plain" onPress={props.onDismissUpdated} />}
      >
        {`${name} 下次启动时使用新版本。`}
      </Notice>
    )
  }
  return null
}

/** Installing a harness: its program by a route in the sheet, or Huli's package; then progress. */
function InstallNotice(props: {
  status: AgentStatus
  kind: InstallKind
  busy: boolean
  connected: boolean
  onInstall(): void
  onOpen(): void
  onCancel(): void
}) {
  const { status, kind } = props
  const name = status.harnessName
  const task = status.task?.kind === 'install' ? status.task : null
  if (task?.state === 'running' || status.state === 'installing') {
    const lines = task ? task.progress : status.progress
    return (
      <Notice
        tone="info"
        busy
        title={`正在安装 ${name}`}
        actions={
          task || status.package ? <Button label="取消安装" onPress={props.onCancel} /> : undefined
        }
      >
        <Muted>{lines.at(-1) ?? task?.command ?? ''}</Muted>
        <LogLines lines={lines} />
      </Notice>
    )
  }
  if (task?.state === 'failed') return null
  if (kind === 'package') {
    if (status.package?.isSdk) return null
    return (
      <Notice
        tone="info"
        title={`安装 ${name}`}
        actions={
          <Button
            label="安装"
            tone="primary"
            busy={props.busy}
            disabled={!props.connected}
            onPress={props.onInstall}
          />
        }
      >
        {`纸鸢会把 ${status.package?.name ?? ''} 装进自己的数据目录，用你的 Node.js 运行。`}
      </Notice>
    )
  }
  return (
    <Notice
      tone="info"
      title={`安装 ${name}`}
      actions={
        <Button
          label="安装…"
          tone="primary"
          busy={props.busy}
          disabled={!props.connected}
          onPress={props.onOpen}
        />
      }
    >
      {status.cli
        ? `纸鸢只用你自己装的 ${status.cli.command}，不带一份。按厂商文档里的一种方式装上它。`
        : '纸鸢在后台装好它，装完这一页会直接变成已安装的状态。'}
    </Notice>
  )
}

/**
 * Installing the user's own program, such as Claude Code: the vendor's routes, the recommended
 * first, those whose tool is missing disabled, and the command that runs, which can be copied.
 */
function InstallSheet(props: {
  status: AgentStatus
  visible: boolean
  onClose(): void
  onInstall(method: AgentInstallMethod['id']): void
  onReload(): Promise<void>
}) {
  const { c } = useTokens()
  const { status } = props
  const [picked, setPicked] = useState<AgentInstallMethod['id'] | null>(null)
  const available = status.installMethods.filter((m) => m.available)
  const method = available.find((m) => m.id === picked) ?? available[0] ?? null
  const vendor = VENDORS[status.harnessId]
  const name = status.harnessName
  const hasMethods = status.installMethods.length > 0
  return (
    <FormSheet
      visible={props.visible}
      title={`安装 ${name}`}
      message={
        hasMethods
          ? vendor
            ? `纸鸢不自带 ${name}，用的是你电脑上装的那份。选一种 ${vendor} 文档里的安装方式，纸鸢会在后台运行它，装好后重新检测 ${name}。`
            : `选一种文档里的安装方式，纸鸢会在后台运行它，装好后重新检测 ${name}。`
          : `按下面的要求安装 ${name}，完成后重新加载环境以检测它。`
      }
      onClose={props.onClose}
      submitLabel={method ? '安装' : '重新加载环境'}
      onSubmit={async () => {
        if (method) props.onInstall(method.id)
        else await props.onReload()
      }}
      maxHeight={720}
    >
      {status.installMethods.map((m, index) => {
        const on = method?.id === m.id
        return (
          <Press
            key={m.id}
            disabled={!m.available}
            scale={false}
            accessibilityRole="radio"
            accessibilityState={{ selected: on, disabled: !m.available }}
            onPress={() => {
              haptic.select()
              setPicked(m.id)
            }}
            style={[
              styles.method,
              {
                backgroundColor: on ? c.tintSoft : c.fill,
                borderColor: on ? c.tint : 'transparent',
              },
            ]}
          >
            <Text style={[typeScale.callout, styles.flex, { color: on ? c.tint : c.text }]}>
              {METHOD_NAMES[m.id]}
            </Text>
            {index === 0 && m.available ? <Tag label="推荐" tone="success" /> : null}
            {!m.available ? <Tag label="未找到" /> : null}
          </Press>
        )
      })}
      {!method && status.detail ? <FieldNote>{status.detail}</FieldNote> : null}
      {method ? (
        <>
          <FieldNote>{method.id === 'archive' ? '要下载的' : '要运行的'}</FieldNote>
          <Code>{method.command}</Code>
          <View style={styles.row}>
            <Button
              label="复制命令"
              icon="copy"
              onPress={() =>
                void Clipboard.setStringAsync(method.command).then(() => haptic.success())
              }
            />
          </View>
          <FieldNote>
            {method.id === 'archive'
              ? '纸鸢会为这台电脑下载并安装这个文件。'
              : '也能复制到你自己的终端里运行，装好后回来点“重新加载环境”。'}
          </FieldNote>
        </>
      ) : null}
      {method && status.installNotice ? <FieldNote>{status.installNotice}</FieldNote> : null}
      {status.installUrl ? (
        <View style={styles.row}>
          <Button
            label="安装指南"
            icon="external"
            onPress={() => void Linking.openURL(status.installUrl!).catch(() => {})}
          />
        </View>
      ) : null}
    </FormSheet>
  )
}

/** The harness's version, whether a newer one exists, and the check for it. */
function VersionGroup(props: { status: AgentStatus; actions: Actions; version: string | null }) {
  const host = useHost()
  const connected = useConnected()
  const { status, actions } = props
  const checkedAt = status.updateCheckedAt
  const checks =
    !!status.package || !!status.cli || !!status.release?.registry || checkedAt !== null
  const updating = status.task?.kind === 'update' && status.task.state === 'running'
  const next = status.cli?.update?.version ?? status.update?.cliVersion ?? null
  const current = !next && !status.update && showsCurrent(status)
  const stated = next
    ? `${next} 已发布`
    : status.update
      ? status.package?.isSdk
        ? `SDK ${status.update.adapterVersion} 已发布`
        : status.package
          ? `适配器 ${status.update.adapterVersion} 已发布`
          : `${status.update.adapterVersion} 已发布`
      : current
        ? '已是最新'
        : null
  const line = !checks
    ? '由它自己的安装程序更新，不经过纸鸢。'
    : actions.busy('check')
      ? '正在检查…'
      : updating
        ? '正在更新…'
        : [stated, checkedAt ? `${ago(checkedAt)}检查过` : '还没有检查过']
            .filter(Boolean)
            .join(' · ')
  return (
    <ListGroup header="版本" footer={line}>
      <ListRow
        title={props.version ?? '未提供'}
        trailing={
          next || status.update ? (
            <Tag label="可更新" tone="tint" />
          ) : current ? (
            <Tag label="已是最新" tone="success" />
          ) : undefined
        }
      />
      {checks ? (
        <ListRow
          key="check"
          title="检查更新"
          icon="refresh"
          plainIcon
          action
          disabled={!connected || updating || actions.busy('check')}
          trailing={actions.busy('check') ? <Tag label="正在检查…" tone="tint" /> : undefined}
          onPress={() =>
            void actions.run(
              'check',
              async () => {
                await call(host.link!, 'agents.checkUpdates', undefined)
                await host.refresh()
              },
              '无法检查更新',
            )
          }
        />
      ) : null}
    </ListGroup>
  )
}

/** The program that runs: the user's own CLI or binary, its version and how it was installed. */
function ProgramGroup({ status, version }: { status: AgentStatus; version: string | null }) {
  const installed = status.cli?.installed ?? null
  const command = status.cli?.command ?? status.binaryCommand
  if (!command) return null
  const method = status.cli?.method ?? null
  const path = installed?.path ?? status.binaryPath ?? status.binaryOverride ?? null
  const problem = installed?.problem
  const note = installed?.variable
    ? `由 ${installed.variable} 指定`
    : problem?.kind === 'unsupported'
      ? `你的 ${command} 需要通过 Shell 才能运行。`
      : problem?.kind === 'failed'
        ? problem.reason
        : !path
          ? `PATH 中没有找到 ${command}。`
          : null
  return (
    <ListGroup header="程序" footer={note ?? undefined}>
      <ListRow
        title={command}
        subtitle={
          method
            ? `你自己装的 · ${METHOD_NAMES[method]}`
            : status.package?.isSdk
              ? '你自己装的，由 SDK 运行。'
              : status.release
                ? '纸鸢装的，在纸鸢的数据目录里。'
                : '你自己装的，由纸鸢运行。'
        }
        value={version ?? undefined}
      />
      <ListRow key="path" title={path ? homeShort(path) : `PATH 中的 ${command}`} />
    </ListGroup>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  row: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  block: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm },
  method: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 48,
    paddingHorizontal: space.md + 2,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
})
