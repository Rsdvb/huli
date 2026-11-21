// Huli: Settings > Agent > an agent > Reset environment, as the desktop's dialog (agent-reset.tsx): signs the
// agent out and removes the ids and caches it made on the computer, its history and settings
// kept. The list is read from the computer as the page opens, so it names exactly what goes.

import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import {
  AGENT_RESET_CATEGORIES,
  type AgentResetCategory,
  type AgentResetItem,
  type AgentResetPreview,
  type AgentResetResult,
} from '@shared/agent-reset'
import type { AgentId } from '@shared/thread'
import { admin } from '../../admin'
import { formatBytes } from '../../attachments'
import { useAgent, useHostActions, useMaybeLink } from '../../host'
import { hostErrorText } from '../../hostErrors'
import {
  Button,
  call,
  confirm,
  GroupNote,
  ManagePage,
  Notice,
  ReadState,
  SwitchRow,
  useConnected,
  useRead,
} from '../../manage/kit'
import { EmptyState } from '../../ui/EmptyState'
import { haptic } from '../../ui/haptics'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { space, type as typeScale, useTokens } from '../../ui/tokens'

const CATEGORY: Record<AgentResetCategory, { name: string; hint: string }> = {
  credentials: {
    name: '退出登录和凭据',
    hint: '登录令牌、OAuth 文件、API key，包括纸鸢替它存的。',
  },
  identifiers: { name: '本机标识', hint: '它在电脑上生成的匿名 ID，下次启动会重新生成。' },
  caches: {
    name: '缓存和临时文件',
    hint: '功能开关缓存、遥测队列、日志、Shell 快照、临时文件夹。',
  },
}

const STORES: Record<NonNullable<AgentResetItem['store']>, string> = {
  keychain: '钥匙串',
  'credential-manager': '凭据管理器',
  'secret-service': '系统密钥环',
}

interface Places {
  folder: string | null
  home: string
}

function under(target: string, base: string): string | null {
  for (const sep of ['/', '\\']) {
    const prefix = base.endsWith(sep) ? base : base + sep
    if (target.startsWith(prefix)) return target.slice(prefix.length)
  }
  return null
}

/** The path as the list shows it: from the agent's folder inside it, else from `~`. */
function shortPath(target: string, places: Places): string {
  const inFolder = places.folder ? under(target, places.folder) : null
  if (inFolder !== null) return inFolder
  const inHome = under(target, places.home)
  if (inHome !== null) return `~${target.includes('\\') ? '\\' : '/'}${inHome}`
  return target
}

function parentOf(target: string): string {
  const cut = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'))
  return cut > 0 ? target.slice(0, cut) : target
}

/** One line of a list: an item, or the same keys taken out of several files of one folder. */
function linesOf(items: AgentResetItem[]): { item: AgentResetItem; files: number }[] {
  const lines: { item: AgentResetItem; files: number }[] = []
  const groups = new Map<string, { item: AgentResetItem; files: number }>()
  for (const item of items) {
    if (item.kind !== 'keys' || item.problem) {
      lines.push({ item, files: 1 })
      continue
    }
    const key = `${parentOf(item.path)}\0${(item.keys ?? []).join(',')}`
    const group = groups.get(key)
    if (group) group.files++
    else {
      const line = { item, files: 1 }
      groups.set(key, line)
      lines.push(line)
    }
  }
  return lines
}

function itemText(item: AgentResetItem, files: number, places: Places): string {
  const where = shortPath(item.path, places)
  const sep = item.path.includes('\\') ? '\\' : '/'
  switch (item.kind) {
    case 'file':
      return where
    case 'folder':
      return `${where}${sep}`
    case 'keys': {
      const file =
        files > 1 ? `${shortPath(parentOf(item.path), places)}${sep}（${files} 个文件）` : where
      return item.problem
        ? `${file}（不是有效的 JSON，不会改）`
        : `${file}：${(item.keys ?? []).join('、')}`
    }
    case 'secret':
      return `${STORES[item.store ?? 'keychain']}：${item.path}`
    case 'logout':
      return item.path === 'logout' ? '用它自己的退出登录' : `运行 ${item.path}`
    case 'api-key':
      return `纸鸢交给它的 API key（${where}）`
    case 'kite-key':
      return `纸鸢保存的 ${item.path}`
  }
}

export default function AgentResetScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>()
  const status = useAgent(id)
  if (!id || !status) {
    return (
      <ManagePage title="重置环境">
        <EmptyState
          icon="sparkles"
          title="找不到这个 Agent"
          message="它可能已在电脑上移除。"
          action={{ label: '返回', onPress: () => router.back() }}
        />
      </ManagePage>
    )
  }
  return <ResetBody agentId={status.id} name={status.name} harnessName={status.harnessName} />
}

function ResetBody(props: { agentId: AgentId; name: string; harnessName: string }) {
  const { c } = useTokens()
  const link = useMaybeLink()
  const connected = useConnected()
  const { refresh } = useHostActions()
  const read = useRead(`agent-reset:${props.agentId}`, (link) =>
    call(link, 'agents.resetPreview', { agentId: props.agentId }),
  )
  const [picked, setPicked] = useState<Record<AgentResetCategory, boolean>>({
    credentials: true,
    identifiers: true,
    caches: true,
  })
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ result: AgentResetResult; places: Places } | null>(null)

  const empty = ReadState({ read, what: '要清理的内容', icon: 'restore', rows: 4 })
  const preview = read.value

  const run = async (current: AgentResetPreview, categories: AgentResetCategory[]) => {
    if (!link) return
    const go = await confirm({
      title: `重置 ${props.name} 的环境？`,
      message: '勾选的内容会从电脑上删掉，不能撤销。会话记录和设置会保留。',
      confirm: '重置',
    })
    if (!go) return
    setRunning(true)
    setError(null)
    try {
      const done = await call(link, 'agents.reset', { agentId: props.agentId, categories })
      // The keys Kite keeps for the agent are the app's settings, not the agent's files.
      if (categories.includes('credentials')) {
        for (const item of current.items.filter((each) => each.kind === 'kite-key')) {
          try {
            await admin(link, 'marketplace.setAgentEnv', {
              agentId: props.agentId,
              variable: item.path,
              value: null,
            })
            done.removed.push(item)
          } catch (failure) {
            done.failed.push({ item, error: hostErrorText(failure) })
          }
        }
      }
      if (done.failed.length > 0) haptic.warning()
      else haptic.success()
      setResult({ result: done, places: { folder: current.folder, home: current.home } })
      await refresh().catch(() => {})
    } catch (failure) {
      haptic.warning()
      setError(hostErrorText(failure, '没能重置。'))
    } finally {
      setRunning(false)
    }
  }

  if (result) {
    const { removed, failed } = result.result
    return (
      <ManagePage title="重置环境">
        <Notice
          tone={failed.length > 0 ? 'warning' : 'success'}
          title={
            failed.length > 0
              ? `删掉了 ${removed.length} 项，${failed.length} 项没删掉`
              : `已重置，删掉了 ${removed.length} 项。`
          }
          actions={<Button label="完成" tone="primary" onPress={() => router.back()} />}
        >
          下次启动时它会重新生成需要的文件。需要的话再登录一次。
        </Notice>
        {failed.length > 0 ? (
          <ListGroup header="没删掉的">
            {failed.map(({ item, error: why }) => (
              <ListRow
                key={`${item.category}:${item.kind}:${item.path}`}
                title={itemText(item, 1, result.places)}
                subtitle={why}
              />
            ))}
          </ListGroup>
        ) : null}
      </ManagePage>
    )
  }

  const categories = preview
    ? AGENT_RESET_CATEGORIES.filter(
        (category) => picked[category] && preview.items.some((item) => item.category === category),
      )
    : []
  const total = preview
    ? preview.items
        .filter((item) => categories.includes(item.category))
        .reduce((sum, item) => sum + (item.bytes ?? 0), 0)
    : 0
  const blocked = !preview || preview.busy.length > 0 || categories.length === 0

  return (
    <ManagePage
      title="重置环境"
      subtitle={props.name}
      intro="让它回到刚装好时的样子。开始前，纸鸢会先停掉它空闲的会话和进程。"
      onRefresh={() => read.reload()}
    >
      {empty ??
        (preview ? (
          <>
            {preview.busy.length > 0 ? (
              <Notice
                tone="warning"
                title={`${preview.busy.length} 个会话正在运行，先停下或等它们做完`}
                actions={<Button label="再检查" onPress={() => void read.reload()} />}
              >
                {preview.busy.map((session) => session.title ?? '未命名会话').join(' · ')}
              </Notice>
            ) : null}
            {preview.outside > 0 ? (
              <Notice
                tone="warning"
                title={`官方 Claude Code 正开着（${preview.outside} 个）`}
                actions={<Button label="再检查" onPress={() => void read.reload()} />}
              >
                它可能把删掉的文件写回去，请先在电脑上关掉它。
              </Notice>
            ) : null}
            {preview.shared ? (
              <GroupNote>
                {preview.shared === 'app'
                  ? `${props.harnessName} 应用也用这份登录，它也会退出登录。`
                  : `你自己运行的 ${props.harnessName} 也用这个文件夹，会一起被重置。`}
              </GroupNote>
            ) : null}
            {AGENT_RESET_CATEGORIES.map((category) => {
              const items = preview.items.filter((item) => item.category === category)
              const known = preview.known.includes(category)
              const places = { folder: preview.folder, home: preview.home }
              return (
                <ListGroup
                  key={category}
                  footer={
                    !known
                      ? category === 'credentials'
                        ? `其余凭据纸鸢不清楚 ${props.name} 放在哪，只会用它自己的退出登录。`
                        : `纸鸢不清楚 ${props.name} 把这些放在哪，不会动。`
                      : items.length === 0
                        ? '电脑上没有。'
                        : undefined
                  }
                >
                  <SwitchRow
                    title={CATEGORY[category].name}
                    subtitle={CATEGORY[category].hint}
                    value={picked[category] && items.length > 0}
                    disabled={running || items.length === 0}
                    onChange={(on) => setPicked((now) => ({ ...now, [category]: on }))}
                  />
                  {linesOf(items).map(({ item, files }) => (
                    <ListRow
                      key={`${item.kind}:${item.path}`}
                      title={itemText(item, files, places)}
                      subtitle={item.problem}
                      value={item.bytes !== null ? formatBytes(item.bytes) : undefined}
                    />
                  ))}
                </ListGroup>
              )
            })}
            <GroupNote>
              {preview.kept.length > 0
                ? `保留会话记录和设置：${preview.kept.join('、')}`
                : '会话记录和设置会保留。'}
            </GroupNote>
            {error ? (
              <Text style={[typeScale.footnote, styles.error, { color: c.danger }]} selectable>
                {error}
              </Text>
            ) : null}
            <View style={styles.actions}>
              <Button
                label={total > 0 ? `重置（共 ${formatBytes(total)}）` : '重置'}
                tone="danger"
                wide
                busy={running}
                disabled={!connected || blocked}
                onPress={() => void run(preview, categories)}
              />
            </View>
          </>
        ) : null)}
    </ManagePage>
  )
}

const styles = StyleSheet.create({
  error: { marginHorizontal: space.lg },
  actions: { marginHorizontal: space.lg },
})
