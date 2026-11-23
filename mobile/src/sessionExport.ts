// Huli: 分享为 Markdown, the phone's export of a session: the whole thread read from its computer,
// written by the desktop's own exporter (src/shared/session-export.ts), its secrets masked as the
// desktop's exports mask them, and handed to the share sheet. Pictures show by their alt text,
// since a share carries one file.

import { Platform, Share } from 'react-native'
import { Directory, File, Paths } from 'expo-file-system'
import type { SessionSummary } from '@shared/agent-host'
import { createRedactor, looksSecret, REDACTED } from '@shared/log/redact'
import type { HostLink } from '@shared/remote/link'
import {
  EXPORT_ASSET,
  sessionMarkdown,
  type ExportKey,
  type ExportSession,
} from '@shared/session-export'
import type { OlderPage, SessionSnapshot, ThreadEntry } from '@shared/thread'

/** The words the export writes, as the desktop's Chinese has them. */
const WORDS: Record<ExportKey, string> = {
  agent: 'Agent',
  model: '模型',
  project: '项目',
  started: '开始于',
  updated: '最后活动',
  exported: '导出于',
  you: '你',
  fromSession: '另一个会话的 Agent',
  thinking: '思考',
  details: '输入和输出',
  input: '输入',
  output: '输出',
  'status.pending': '等待中',
  'status.in_progress': '运行中',
  'status.completed': '已完成',
  'status.failed': '失败',
  'status.cancelled': '已取消',
  denied: '已拒绝',
  plan: '计划，第 {{version}} 版',
  planApproved: '已批准',
  planDeclined: '已退回',
  note: '备注',
  question: '问题',
  answer: '回答',
  noAnswer: '（没有回答）',
  todo: '待办',
  subagent: '子 Agent：{{title}}',
  compacted: '之前的对话已压缩',
  attached: '附件：{{name}}',
  commit: '已提交',
  pushed: '已推送 {{count}} 个提交到 {{upstream}}',
  branch: '在分支 {{branch}}',
  pullRequest: '已开 Pull Request：',
  artifact: '产物「{{title}}」，第 {{version}} 版',
  memory: '记忆：{{title}}',
  takeover: '{{agent}} 接手了会话',
  otherSession: '来自另一个会话的消息',
  linesMore: '还有 {{count}} 行',
  image: '图片',
  media: '媒体：{{name}}',
  changes: '改动',
  changesTotal: '{{count}} 个文件，+{{added}} −{{removed}} 行',
}

function words(key: ExportKey, values?: Record<string, string | number>): string {
  return WORDS[key].replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''))
}

function time(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// As the desktop's exports mask secrets: the logs' rules, a value after a secret-like name only
// when it reads as one, and a mark a Markdown viewer shows.
const redact = createRedactor({ platform: 'linux', namedValue: looksSecret })

function masked(markdown: string): string {
  return redact(markdown).split(REDACTED).join('‹redacted›')
}

async function wholeThread(link: HostLink, sessionId: string): Promise<ThreadEntry[]> {
  const snapshot = (await link.request('sessions.snapshot', {
    sessionId,
    from: 0,
  })) as SessionSnapshot
  let entries = snapshot.entries
  let older = snapshot.older
  while (older !== null) {
    const page = (await link.request('sessions.page', { sessionId, before: older })) as OlderPage
    entries = [...page.entries, ...entries]
    older = page.older
  }
  return entries
}

/** The file's name: the session's title without what a file name cannot hold. */
function fileName(title: string): string {
  const base =
    title
      .replace(/[\\/:*?"<>|\n\r\t]+/g, ' ')
      .trim()
      .slice(0, 80) || '会话'
  return `${base}.md`
}

/** Builds the session's Markdown and hands it to the share sheet. */
export async function shareSessionMarkdown(
  link: HostLink,
  summary: SessionSummary,
  agentName: string,
): Promise<void> {
  const entries = await wholeThread(link, summary.id)
  const title = summary.title ?? '未命名会话'
  const session: ExportSession = {
    sessionId: summary.id,
    title,
    agent: agentName,
    model: summary.model,
    project: summary.scratch ? null : summary.projectPath,
    root: summary.projectPath,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    entries,
  }
  const { markdown } = sessionMarkdown({
    session,
    options: { thoughts: false, tools: false, subagents: false },
    text: { t: words, time },
    exportedAt: Date.now(),
  })
  // A share carries one file, so a picture shows by its alt text.
  const text = masked(markdown).replace(
    new RegExp(`!\\[([^\\]]*)\\]\\(${EXPORT_ASSET}[^)]*\\)`, 'g'),
    '*($1)*',
  )
  const folder = new Directory(Paths.cache, 'huli-share')
  if (folder.exists) folder.delete()
  folder.create({ intermediates: true, idempotent: true })
  const file = new File(folder, fileName(title))
  file.create()
  await file.write(text)
  if (Platform.OS === 'ios') {
    await Share.share({ url: file.uri, title })
    return
  }
  await Share.share({ message: text, title })
}
