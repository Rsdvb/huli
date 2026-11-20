// Huli: Export… in a session's menu: the dialog's state, and the export itself. The page reads the
// whole thread and its pictures from the session's host, builds the Markdown (shared
// session-export.ts), and hands both to main, which masks secrets, asks where and writes.

import { create } from 'zustand'
import type { SessionSummary } from '@shared/agent-host'
import {
  sessionMarkdown,
  type ExportFormat,
  type ExportKey,
  type ExportOptions,
  type ExportSession,
  type SessionExportRequest,
} from '@shared/session-export'
import type { ConfigOption, ThreadEntry } from '@shared/thread'
import { fullTime } from '@renderer/lib/format'
import { host } from '@renderer/lib/host'
import { hostPath } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'
import { readJson, writeJson } from '@renderer/lib/storage'
import { agentsOn, useAgentsStore } from '@renderer/stores/agents'
import { hostOfSession, sessionTitle, useSessionsStore } from '@renderer/stores/sessions'

export interface ExportChoice {
  format: ExportFormat
  options: ExportOptions
}

const CHOICE_KEY = 'huli-session-export'
const DEFAULT_CHOICE: ExportChoice = {
  format: 'md',
  options: { thoughts: false, tools: false, subagents: false },
}

/** The choice last exported with, kept for the next export. */
export function lastChoice(): ExportChoice {
  const kept = readJson<Partial<ExportChoice> | null>(CHOICE_KEY, null)
  const format = (['md', 'zip', 'pdf'] as const).find((f) => f === kept?.format)
  return {
    format: format ?? DEFAULT_CHOICE.format,
    options: { ...DEFAULT_CHOICE.options, ...kept?.options },
  }
}

export function keepChoice(choice: ExportChoice): void {
  writeJson(CHOICE_KEY, choice)
}

interface ExportStore {
  /** The session whose export the dialog asks about; null while it is closed. */
  summary: SessionSummary | null
}

export const useExportStore = create<ExportStore>()(() => ({ summary: null }))

/** Opens the dialog for the session, as its menu's Export… does. */
export function askExport(summary: SessionSummary): void {
  useExportStore.setState({ summary })
}

/** Whether this window can save an export: the desktop app's, which has main. */
export function canExport(): boolean {
  return typeof window.kettu.exportSession === 'function'
}

/** Every entry of the thread, from its start. */
async function wholeThread(sessionId: string): Promise<{
  entries: ThreadEntry[]
  config: ConfigOption[]
}> {
  const snapshot = await host('sessions.snapshot', { sessionId, from: 0 })
  let entries = snapshot.entries
  let older = snapshot.older
  while (older !== null) {
    const page = await host('sessions.page', { sessionId, before: older })
    entries = [...page.entries, ...entries]
    older = page.older
  }
  return { entries, config: snapshot.session.config }
}

/** The model's name as the session's model menu shows it, else its id. */
function modelName(config: readonly ConfigOption[], fallback: string | null): string | null {
  const option = config.find((o) => o.category === 'model' && o.type === 'select')
  if (!option) return fallback
  const choice = option.choices?.find((c) => c.value === option.value)
  return choice?.name ?? (typeof option.value === 'string' ? option.value : fallback)
}

async function exportSessionOf(summary: SessionSummary): Promise<ExportSession> {
  const { entries, config } = await wholeThread(summary.id)
  const agents = agentsOn(useAgentsStore.getState(), hostOfSession(summary))
  return {
    sessionId: summary.id,
    title: sessionTitle(summary),
    agent: agents.byId[summary.agentId]?.name ?? summary.agentId,
    model: modelName(config, summary.model),
    project: summary.scratch ? null : hostPath(summary.projectPath),
    root: hostPath(summary.projectPath),
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    entries,
  }
}

/** The sub-agents' sessions the thread names, read a level at a time. */
async function subagentSessions(root: ExportSession): Promise<Map<string, ExportSession>> {
  const found = new Map<string, ExportSession>()
  let level = [root]
  for (let depth = 0; depth < 3 && level.length > 0; depth++) {
    const ids = level.flatMap((session) =>
      session.entries.flatMap((entry) =>
        entry.kind === 'subagent' && !found.has(entry.sessionId) ? [entry.sessionId] : [],
      ),
    )
    const { byId } = useSessionsStore.getState()
    const read = await Promise.all(
      ids.map(async (id) => {
        const summary = byId[id]
        if (!summary) return null
        try {
          return await exportSessionOf(summary)
        } catch {
          // A sub-agent that cannot be read is named without its thread.
          return null
        }
      }),
    )
    level = read.filter((session): session is ExportSession => session !== null)
    for (const session of level) found.set(session.sessionId, session)
  }
  return found
}

function base64Bytes(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Builds the export of the session and has main save it; false when the user cancelled. */
export async function exportSession(
  summary: SessionSummary,
  choice: ExportChoice,
): Promise<boolean> {
  const save = window.kettu.exportSession
  if (!save) throw new Error('Only the desktop app saves exports')
  const session = await exportSessionOf(summary)
  const children = choice.options.subagents ? await subagentSessions(session) : new Map()
  const t = i18n.getFixedT(null, 'session')
  const { markdown, images } = sessionMarkdown({
    session,
    children,
    options: choice.options,
    exportedAt: Date.now(),
    text: {
      t: (key: ExportKey, values) => t(`export.text.${key}`, values),
      time: fullTime,
    },
  })
  const read = await Promise.all(
    images.map(async (image) => {
      try {
        const data =
          image.source.kind === 'data'
            ? base64Bytes(image.source.data)
            : new Uint8Array(
                (
                  await host('sessions.blob', {
                    sessionId: image.source.sessionId,
                    hash: image.source.hash,
                  })
                ).bytes,
              )
        return { name: image.name, data }
      } catch {
        // A picture the host no longer has shows as its alt text.
        return null
      }
    }),
  )
  const request: SessionExportRequest = {
    format: choice.format,
    title: session.title,
    markdown,
    images: read.filter((image) => image !== null),
  }
  return save(request)
}
