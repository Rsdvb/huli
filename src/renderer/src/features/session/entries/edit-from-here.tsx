import { useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { FilesRestored } from '@shared/agent-host'
import { canEditAt, lastSwitchAt, turnsFrom, usedAtEnd } from '@shared/rewind'
import { rewindTarget, type RewindMode } from '@shared/rewind-target'
import { harnessOf, type ThreadState, type ToolEntry } from '@shared/thread'
import { editFromMessage, rewindToMessage } from '@renderer/app/actions'
import { toast } from '@renderer/components/ui/toast'
import { Popover, PopoverContent } from '@renderer/components/ui/popover'
import { errorMessage, host } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { AGENT_NAMES, agentsOn, useAgentsStore } from '@renderer/stores/agents'
import { hostOfSession, sessionArchived, useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { EditConfirm, type EditFacts } from './edit-confirm'

// Where each entry is and where the latest agent switch is, once per order of a thread.
const places = new WeakMap<readonly string[], { at: Map<string, number>; switchAt: number }>()

function placeOf(state: ThreadState): { at: Map<string, number>; switchAt: number } {
  let place = places.get(state.order)
  if (!place) {
    place = { at: new Map(state.order.map((id, i) => [id, i])), switchAt: lastSwitchAt(state) }
    places.set(state.order, place)
  }
  return place
}

/**
 * Whether a sent message can be edited from: the user's own that started a turn after the latest
 * agent switch. Huli: of any agent's session; one whose agent cannot cut its own conversation
 * carries on in a new session, given the conversation kept. With `rewind`, whether it can be
 * rewound to: a message the user may edit from comes after it.
 */
export function useEditable(
  sessionId: string,
  entryId: string,
  mode: RewindMode = 'edit',
): boolean {
  const ok = useThreadsStore((s) => {
    const session = s.replicas[sessionId]?.state?.session
    return !!session && session.origin !== 'subagent' && session.status !== 'starting'
  })
  const archived = useSessionsStore((s) => sessionArchived(s.byId, sessionId))
  const editable = useThreadsStore((s) => {
    const state = s.replicas[sessionId]?.state
    if (!state) return false
    const place = placeOf(state)
    const target = mode === 'edit' ? entryId : rewindTarget(state, entryId, 'rewind')
    const at = target === null ? undefined : place.at.get(target)
    return at !== undefined && canEditAt(state, at, place.switchAt)
  })
  return ok && !archived && editable
}

/** The session's agent, by name, for what the confirmation says it does. */
function useAgentName(sessionId: string): string {
  const view = useThreadsStore(
    useShallow((s) => {
      const session = s.replicas[sessionId]?.state?.session
      return session ? { agentId: session.agentId, projectPath: session.projectPath } : null
    }),
  )
  return useAgentsStore((s) =>
    view
      ? (agentsOn(s, hostOfSession(view)).byId[view.agentId]?.name ??
        AGENT_NAMES[harnessOf(view.agentId)])
      : '',
  )
}

const FILE_KINDS = new Set<ToolEntry['toolKind']>(['edit', 'delete', 'move'])

function editFacts(state: ThreadState, entryId: string): EditFacts | null {
  const at = state.order.indexOf(entryId)
  if (at < 0) return null
  const files = new Set<string>()
  let commands = false
  for (const id of state.order.slice(at)) {
    const entry = state.byId[id]
    if (entry?.kind !== 'tool') continue
    if (entry.toolKind === 'execute') commands = true
    if (!FILE_KINDS.has(entry.toolKind) || entry.status !== 'completed') continue
    for (const location of entry.locations) files.add(location.path)
    for (const content of entry.content) if (content.type === 'diff') files.add(content.path)
  }
  const { status, background } = state.session
  return {
    turns: turnsFrom(state, at),
    files: files.size,
    commands,
    running: status === 'running' || status === 'awaiting_permission',
    tasks: background?.filter((task) => task.status === 'running').length ?? 0,
    kept: usedAtEnd({ order: state.order.slice(0, at), byId: state.byId }),
  }
}

/** Only the last message, whose turn changed no files and ran nothing, goes back unasked. */
const asks = (facts: EditFacts): boolean =>
  facts.turns > 1 || facts.files > 0 || facts.commands || facts.running || facts.tasks > 0

function restoredToast(sessionId: string, restored: FilesRestored): void {
  const backup = restored.backup
  toast(
    restored.failed > 0
      ? i18n.t('session:rewind.doneSomeFailed', {
          count: restored.restored,
          failed: restored.failed,
        })
      : i18n.t('session:rewind.doneFiles', { count: restored.restored }),
    backup
      ? {
          label: i18n.t('session:rewind.undoFiles'),
          onClick: () => {
            host('sessions.undoRewindFiles', { sessionId, backup }).then(
              () => toast(i18n.t('session:rewind.undoneFiles'), undefined, { tone: 'success' }),
              (e: unknown) => toast(errorMessage(e), undefined, { tone: 'warning' }),
            )
          },
        }
      : undefined,
    { tone: restored.failed > 0 ? 'warning' : 'success', duration: 10_000 },
  )
}

/**
 * Goes back to before `target`: the files first, where asked, so a refusal leaves the
 * conversation as it is too; then Edit from here gives the message back, or Rewind to here keeps
 * the one before it.
 */
async function edit(
  sessionId: string,
  target: string,
  mode: RewindMode,
  token: string | null,
): Promise<void> {
  let restored: FilesRestored | null = null
  try {
    if (token) restored = await host('sessions.restoreFiles', { sessionId, entryId: target, token })
    if (mode === 'edit') await editFromMessage(sessionId, target)
    else await rewindToMessage(sessionId, target)
  } catch (error) {
    toast(i18n.t('session:editFrom.failed', { error: errorMessage(error) }), undefined, {
      tone: 'warning',
    })
  }
  if (restored) restoredToast(sessionId, restored)
}

/**
 * Edit from a message: `start` goes back at once when nothing needs saying, and otherwise opens
 * the confirmation under `anchor`; `popover` is where it shows. Huli: with `rewind`, Rewind to
 * here, which always asks, as it gives nothing back to undo it with.
 */
export function useEditFrom(
  sessionId: string,
  entryId: string,
  mode: RewindMode = 'edit',
): { start: (anchor: Element | null) => void; open: boolean; popover: ReactNode } {
  const agent = useAgentName(sessionId)
  const [asking, setAsking] = useState<{
    anchor: Element
    facts: EditFacts
    target: string
  } | null>(null)
  const start = (anchor: Element | null) => {
    const state = useThreadsStore.getState().replicas[sessionId]?.state
    const target = state ? rewindTarget(state, entryId, mode) : null
    const facts = state && target ? editFacts(state, target) : null
    if (!facts || !target) return
    if (mode === 'edit' && (!asks(facts) || !anchor)) {
      void edit(sessionId, target, mode, null)
      return
    }
    if (!anchor) return
    setAsking({ anchor, facts, target })
  }
  const popover = (
    <Popover open={asking !== null} onOpenChange={(open) => !open && setAsking(null)}>
      {asking && (
        <PopoverContent
          anchor={asking.anchor}
          side="bottom"
          align="end"
          sideOffset={6}
          className="kettu-pop kettu-edit-pop"
        >
          <EditConfirm
            sessionId={sessionId}
            facts={asking.facts}
            mode={mode}
            target={asking.target}
            agent={agent}
            onCancel={() => setAsking(null)}
            onEdit={(token) => {
              const { target } = asking
              setAsking(null)
              void edit(sessionId, target, mode, token)
            }}
          />
        </PopoverContent>
      )}
    </Popover>
  )
  return { start, open: asking !== null, popover }
}
