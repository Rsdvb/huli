// Settings › 用量记录: whether the 用量 tab counts the agents' own logs, each agent's logs with
// re-importing them, syncing now, and clearing Huli's own record.

import { StyleSheet, Text, View } from 'react-native'
import type { UsageLogStatus, UsageStatus } from '@shared/usage'
import { useHost } from '../../host'
import {
  Button,
  call,
  confirm,
  ManagePage,
  ReadState,
  SwitchRow,
  useActions,
  useConnected,
  useHostSettings,
  useRead,
} from '../../manage/kit'
import { ago } from '../../sessions'
import { AgentAvatar } from '../../ui/AgentAvatar'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { space, type as typeScale, useTokens } from '../../ui/tokens'

function bytesText(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`
  return `${n} B`
}

function dateText(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
}

export default function UsageRecords() {
  const { c } = useTokens()
  const host = useHost()
  const connected = useConnected()
  const status = useRead<UsageStatus>(
    'usage-status',
    (link) => call(link, 'usage.status', undefined),
    ['usage.status', 'usage.changed'],
  )
  const settings = useHostSettings()
  const actions = useActions()
  const value = status.value
  const scanning = value?.scanning ?? null
  const fromComputer = settings.value?.usage.fromComputer ?? value?.fromComputer ?? false
  const agentName = (id: string) => host.agents.get(id)?.name ?? id

  const facts = (log: UsageLogStatus): string => {
    const parts: string[] = []
    if (log.found === null) parts.push(scanning ? '正在读取日志…' : '尚未读取')
    else if (!log.found) parts.push('没有找到日志')
    else if (log.first !== null)
      parts.push(`${dateText(log.first)} 起 · ${log.rows.toLocaleString('zh-CN')} 次请求`)
    else parts.push('还没有请求')
    if (log.syncedAt !== null) parts.push(`${ago(log.syncedAt)}同步`)
    return parts.join(' · ')
  }

  const reimport = async (log: UsageLogStatus) => {
    const name = agentName(log.agentId)
    const ok = await confirm({
      title: `重新导入 ${name} 的日志？`,
      message: `纸鸢会清除从 ${name} 导入的数据，然后重新读取它的日志。Agent 已经从日志中删除的历史无法恢复。`,
      confirm: '重新导入',
    })
    if (!ok || !host.link) return
    await actions.run(
      `reimport:${log.agentId}`,
      () => call(host.link!, 'usage.reimport', { agentId: log.agentId }),
      '没能重新导入',
    )
    void status.reload()
  }

  const clear = async () => {
    const ok = await confirm({
      title: '清除纸鸢的用量记录？',
      message: '删除纸鸢自己统计的数据。Agent 自己的日志不受影响。',
      confirm: '清除记录',
    })
    if (!ok || !host.link) return
    await actions.run('clear', () => call(host.link!, 'usage.clearRecord', undefined), '没能清除')
    void status.reload()
  }

  return (
    <ManagePage
      title="用量记录"
      intro="「用量」页统计哪些用量。"
      onRefresh={() => Promise.all([status.reload(), settings.reload()])}
    >
      {value === null ? (
        <ReadState read={status} what="用量记录" icon="chart" rows={3} />
      ) : (
        <>
          {value.unavailable ? (
            <Text style={[typeScale.footnote, styles.note, { color: c.danger }]}>
              无法读取用量数据库。请重启纸鸢；如果仍然无法读取，请报告问题。
            </Text>
          ) : null}
          <ListGroup
            header="统计来源"
            footer="同时统计 Claude Code、Codex 和 opencode 在纸鸢之外的日志。只读 token 数、模型和时间，不读内容。"
          >
            <SwitchRow
              title="统计电脑上的用量"
              icon="desktop"
              value={fromComputer}
              busy={actions.busy('from')}
              disabled={!connected || settings.value === null}
              onChange={(on) =>
                void actions.run(
                  'from',
                  () => settings.update({ usage: { fromComputer: on } }),
                  '无法修改',
                )
              }
            />
          </ListGroup>

          {fromComputer ? (
            <View style={styles.section}>
              <View style={styles.head}>
                <Text style={[typeScale.headline, { color: c.textSecondary }]}>日志</Text>
                <Button
                  label="立即同步"
                  icon="refresh"
                  busy={actions.busy('sync') || scanning !== null}
                  disabled={!connected}
                  onPress={() =>
                    void actions
                      .run('sync', () => call(host.link!, 'usage.sync', undefined), '同步失败')
                      .then(() => status.reload())
                  }
                />
              </View>
              {scanning && scanning.bytes > 0 ? (
                <Text style={[typeScale.footnote, styles.note, { color: c.textSecondary }]}>
                  正在读取 Agent 的日志：{bytesText(scanning.doneBytes)} /{' '}
                  {bytesText(scanning.bytes)}
                </Text>
              ) : null}
              <ListGroup>
                {value.logs.map((log) => (
                  <ListRow
                    key={log.agentId}
                    title={agentName(log.agentId)}
                    subtitle={
                      log.error ?? [log.locations.join(', '), facts(log)].filter(Boolean).join('\n')
                    }
                    leading={<AgentAvatar agentId={log.agentId} size={30} />}
                    trailing={
                      <Button
                        label="重新导入…"
                        busy={actions.busy(`reimport:${log.agentId}`)}
                        disabled={!connected || !log.found || scanning !== null}
                        onPress={() => void reimport(log)}
                      />
                    }
                  />
                ))}
              </ListGroup>
            </View>
          ) : null}

          <ListGroup
            header="危险操作"
            footer={
              value.recordSince
                ? `删除纸鸢自己统计的数据（${dateText(value.recordSince)} 起）。Agent 自己的日志不受影响。`
                : '删除纸鸢自己统计的数据。Agent 自己的日志不受影响。'
            }
          >
            <ListRow
              title="清除纸鸢的记录…"
              icon="trash"
              plainIcon
              iconTint={c.danger}
              destructive
              disabled={!connected || value.recordSince === null || actions.busy('clear')}
              onPress={() => void clear()}
            />
          </ListGroup>
        </>
      )}
    </ManagePage>
  )
}

const styles = StyleSheet.create({
  section: { gap: space.sm },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginLeft: space.lg,
  },
  note: { marginHorizontal: space.lg },
})
