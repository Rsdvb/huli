// Huli: Kite's own Node.js from the phone, wherever an agent waits for it: the computer's
// environment as it last said, the one-tap install with its progress, Stop and why it failed, the
// update and removal of Kite's own, and the choice to always use it. The computer does the work
// (`environment.installNode`) and reports in `environment.changed`, as on the desktop.

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { EnvironmentInfo, HostEvent, NodeRuntimeInfo, NodeTask } from '@shared/agent-host'
import { useMaybeLink } from '../host'
import { openUrl } from '../system/openUrl'
import { showNotice } from '../ui/NoticeBar'
import { ListRow } from '../ui/ListRow'
import { haptic } from '../ui/haptics'
import { hostErrorText } from '../hostErrors'
import { Button, call, fail, Notice, SwitchRow, Tag, useConnected, useRead, type Read } from './kit'

/** Where to install Node.js by hand, as the desktop links it. */
export const NODE_MANUAL_URL = 'https://nodejs.org/zh-cn/download'

/** The computer's environment, read again whenever it says it changed. */
export function useEnvironment(): Read<EnvironmentInfo> {
  const link = useMaybeLink()
  const connected = useConnected()
  const read = useRead(
    connected ? 'agents-environment' : null,
    (link) => call(link, 'agents.environment', undefined),
    ['environment.changed'],
  )
  const { set } = read
  useEffect(() => {
    if (!link) return
    return link.onHostEvent((raw) => {
      const event = raw as HostEvent
      if (event.type === 'environment.changed') set(() => event.info)
    })
  }, [link, set])
  return read
}

const PHASES: Record<NodeTask['phase'], string> = {
  checking: '正在查找最新版…',
  downloading: '正在下载',
  verifying: '正在校验…',
  extracting: '正在解压…',
  removing: '正在移除…',
}

/** What the install or removal is doing, in a few words, with how much arrived. */
export function nodeTaskText(task: NodeTask): string {
  if (task.phase !== 'downloading') return PHASES[task.phase]
  const percent = task.progress !== null ? ` ${Math.floor(task.progress * 100)}%` : ''
  return `${PHASES.downloading} ${task.version ?? 'Node.js'}${percent}`
}

/** What the Node.js agents run on says, the user's or Kite's own, with its version. */
export function nodeLine(node: NodeRuntimeInfo): string {
  const required = node.required?.replace(/^>=\s*/, '') ?? ''
  if (node.using === 'kite' && node.kite) return `纸鸢的 Node.js ${node.kite.version}`
  if (!node.system) return '没有找到 Node.js，有些 Agent 需要它'
  if (!node.system.version) return '系统的 Node.js 运行不了'
  if (!node.system.suitable)
    return `系统的 ${node.system.version} 太旧，有些 Agent 要 ${required} 或更高`
  return `系统的 Node.js ${node.system.version}`
}

export interface NodeInstall {
  node: NodeRuntimeInfo | null
  task: NodeTask | null
  running: boolean
  /** The install was asked for and its first progress has not come yet. */
  starting: boolean
  stopping: boolean
  /** Why the last install or removal failed, as the host keeps it or the request said. */
  failure: string | null
  install(): void
  stop(): void
  remove(): void
}

/**
 * Starts, stops and removes Kite's Node.js on the computer. A failure shows where the install
 * does, never as an alert, and a stop the user asked for is no failure.
 */
export function useNodeInstall(environment: Read<EnvironmentInfo>): NodeInstall {
  const link = useMaybeLink()
  const node = environment.value?.node ?? null
  const task = node?.task ?? null
  const running = task?.state === 'running'
  const [asked, setAsked] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const stopped = useRef(false)
  useEffect(() => {
    if (!running) setStopping(false)
  }, [running])

  const install = useCallback(() => {
    if (!link) return
    stopped.current = false
    setError(null)
    setAsked(true)
    const updating = !!node?.kite
    call(link, 'environment.installNode', undefined)
      .then(
        (result) => {
          haptic.success()
          showNotice({
            text: result.installed
              ? `已安装 Node.js ${result.version}`
              : `Node.js ${result.version} 已是最新`,
            tone: 'success',
          })
        },
        (failure: unknown) => {
          if (stopped.current) return
          haptic.warning()
          setError(hostErrorText(failure, updating ? '没能更新 Node.js。' : '没能安装 Node.js。'))
        },
      )
      .finally(() => {
        setAsked(false)
        void environment.reload()
      })
  }, [link, node?.kite, environment])

  const stop = useCallback(() => {
    if (!link) return
    stopped.current = true
    setStopping(true)
    call(link, 'environment.cancelNodeInstall', undefined).then(
      () => showNotice({ text: '已停止安装 Node.js', tone: 'info' }),
      (failure: unknown) => {
        stopped.current = false
        setStopping(false)
        fail('没能停止安装', failure)
      },
    )
  }, [link])

  const remove = useCallback(() => {
    if (!link) return
    setError(null)
    call(link, 'environment.removeNode', undefined).then(
      () => {
        haptic.success()
        showNotice({ text: '已移除纸鸢的 Node.js', tone: 'success' })
      },
      (failure: unknown) => {
        haptic.warning()
        setError(hostErrorText(failure, '没能移除 Node.js。'))
      },
    )
  }, [link])

  const kept = task?.state === 'failed' ? task.error : null
  return {
    node,
    task,
    running,
    starting: asked && !running,
    stopping,
    failure: running ? null : (kept ?? error),
    install,
    stop,
    remove,
  }
}

/**
 * The install's buttons for a notice: Install (or Retry after a failure), Stop while it runs, and
 * installing by hand; only the link where the computer cannot install it.
 */
export function NodeInstallButtons({ state }: { state: NodeInstall }) {
  const connected = useConnected()
  const { node, running } = state
  const manual = (
    <Button
      label="手动安装"
      icon="external"
      tone="plain"
      onPress={() => openUrl(NODE_MANUAL_URL)}
    />
  )
  if (!node?.installable) return manual
  if (running && state.task?.kind === 'install') {
    return (
      <Button
        label={state.stopping ? '正在停止…' : '停止安装'}
        icon="stop"
        busy={state.stopping}
        disabled={!connected}
        onPress={state.stop}
      />
    )
  }
  return (
    <>
      <Button
        label={state.failure ? '重试' : node.kite ? '更新纸鸢的 Node.js' : '一键安装 Node.js'}
        icon="download"
        tone="primary"
        busy={state.starting || running}
        disabled={!connected}
        onPress={state.install}
      />
      {manual}
    </>
  )
}

/** The line a notice shows under its title: what runs now, the install's progress or failure. */
export function nodeInstallText(state: NodeInstall): string {
  const { node, task } = state
  if (!node) return '正在读取电脑上的 Node.js…'
  if (state.running && task)
    return `${nodeTaskText(task)}${task.source ? ` · 来自 ${task.source}` : ''}`
  if (state.failure) {
    return `${task?.kind === 'remove' ? 'Node.js 移除失败' : 'Node.js 安装失败'}：${state.failure}`
  }
  return node.installable
    ? `${nodeLine(node)}。纸鸢可以把 Node.js 装在自己的文件夹里，不需要管理员权限，不改系统设置。`
    : `${nodeLine(node)}。这台电脑没有纸鸢能装的 Node.js，请手动安装。`
}

/**
 * A notice where an agent waits for Node.js, as on an agent's or a harness's page: what the
 * computer has, and the install with its progress, Stop and failure.
 */
export function NodeNotice(props: { title: string }) {
  const state = useNodeInstall(useEnvironment())
  return (
    <Notice
      tone={state.failure ? 'error' : 'warning'}
      busy={state.running || state.starting}
      title={props.title}
      actions={<NodeInstallButtons state={state} />}
    >
      {nodeInstallText(state)}
    </Notice>
  )
}

/**
 * Settings › Agent › 环境's rows for Node.js: what agents run on, the install's progress and Stop,
 * a failure, Install or Update, Remove and the choice to always use Kite's. Rows, not a
 * component, so the group draws its lines between them.
 */
export function nodeRows(
  state: NodeInstall,
  props: { connected: boolean; onChoose(kite: boolean): void },
) {
  const { node, task } = state
  if (!node) return []
  const lacking = node.using === null || (node.using === 'system' && !node.system?.suitable)
  const rows: ReactElement[] = [
    <ListRow
      key="node"
      title="Node.js"
      subtitle={nodeLine(node)}
      value={node.using === 'kite' ? node.kite?.version : (node.system?.version ?? undefined)}
    />,
  ]
  if (state.running && task) {
    rows.push(
      <ListRow
        key="node-task"
        title={nodeTaskText(task)}
        subtitle={task.source ? `来自 ${task.source}` : undefined}
        trailing={<Tag label={task.kind === 'remove' ? '正在移除' : '正在安装'} tone="tint" />}
      />,
    )
    if (task.kind === 'install') {
      rows.push(
        <ListRow
          key="node-stop"
          title={state.stopping ? '正在停止…' : '停止安装'}
          icon="stop"
          plainIcon
          action
          disabled={!props.connected || state.stopping}
          onPress={state.stop}
        />,
      )
    }
    return rows
  }
  if (state.failure) {
    rows.push(
      <ListRow
        key="node-failed"
        title={task?.kind === 'remove' ? 'Node.js 移除失败' : 'Node.js 安装失败'}
        subtitle={state.failure}
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
        disabled={!props.connected || state.starting}
        trailing={state.starting ? <Tag label="正在开始…" tone="tint" /> : undefined}
        onPress={state.install}
      />,
    )
  }
  if (node.kite) {
    rows.push(
      <SwitchRow
        key="node-choice"
        title="始终用纸鸢的 Node.js"
        subtitle={
          node.choice === 'kite'
            ? 'Agent 一律用纸鸢装的这一份。'
            : '系统的 Node.js 够新时用系统的，否则用纸鸢的。'
        }
        value={node.choice === 'kite'}
        disabled={!props.connected}
        onChange={props.onChoose}
      />,
      <ListRow
        key="node-remove"
        title="移除纸鸢的 Node.js"
        icon="trash"
        plainIcon
        destructive
        disabled={!props.connected}
        onPress={state.remove}
      />,
    )
  }
  return rows
}
