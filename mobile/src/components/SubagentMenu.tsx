// A session's sub-agents, opened from the count on its row as the desktop's badge opens its card:
// each one with its tool calls and how long it has run or ran, opening its session, and a switch
// that keeps the finished ones in the list.

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import type { SessionSummary } from '@shared/agent-host'
import { sameItems, useConnected, useHostSelector, useLink, type HostData } from '../host'
import { setPrefs, usePrefs } from '../prefs'
import { sessionTitle } from '../sessions'
import { spanText } from '../ui/session/format'
import { NativeMenu } from '../ui/session/NativeMenu'
import type { MenuEntry, MenuSource } from '../ui/session/Popover'
import { listedSubagents, subagentRunning, useSubagentDigests } from '../ui/session/subagents'

/** Re-renders each second while `on`, for the running ones' clocks. */
function useSecond(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [on])
  return now
}

export function SubagentMenu(props: { parentId: string; children: ReactElement }) {
  const link = useLink()
  const connected = useConnected()
  const { showFinishedSubagents } = usePrefs()
  // Its own sub-agents only, so another session's change passes the row's badge by.
  const all = useHostSelector(
    useCallback(
      (d: HostData) =>
        [...d.sessions.values()].filter(
          (s) => s.parentId === props.parentId && s.origin === 'subagent',
        ),
      [props.parentId],
    ),
    sameItems,
  )
  const listed = useMemo(
    () => listedSubagents(all, showFinishedSubagents),
    [all, showFinishedSubagents],
  )
  const digestOf = useSubagentDigests(link, listed, connected)
  const running = listed.filter(subagentRunning).length
  const now = useSecond(running > 0)

  const row = (child: SessionSummary): MenuEntry => {
    const digest = digestOf(child.id)
    const live = subagentRunning(child)
    const elapsed = live
      ? now - (child.turnStartedAt ?? child.createdAt)
      : (digest?.durationMs ?? null)
    const failed = child.attention === 'error' || child.status === 'failed'
    const meta = [
      live ? (digest?.tools != null ? `${digest.tools} 个工具` : null) : failed ? '失败' : '已完成',
      elapsed !== null ? spanText(Math.max(0, elapsed)) : null,
    ]
      .filter(Boolean)
      .join(' · ')
    const subtitle =
      child.permissionCount > 0
        ? ['需要授权', child.description].filter(Boolean).join(' · ')
        : child.description
    return {
      key: child.id,
      label: sessionTitle(child),
      ...(subtitle ? { subtitle } : {}),
      ...(meta ? { detail: meta } : {}),
      onPress: () => router.push(`/session/${child.id}`),
    }
  }

  const source: MenuSource = {
    root: 'subagents',
    pages: (id) =>
      id !== 'subagents'
        ? null
        : {
            entries: [
              {
                kind: 'divider',
                key: 'head',
                title:
                  running > 0 ? `这个会话的子 Agent · ${running} 个运行中` : '这个会话的子 Agent',
              },
              ...listed.map(row),
              { kind: 'divider', key: 'end' },
              {
                key: 'finished',
                label: '显示已结束的子 Agent',
                // `toggle` is the switch's state, not a flag: set to true, it read as on whatever
                // the setting was.
                toggle: showFinishedSubagents,
                onPress: () => setPrefs({ showFinishedSubagents: !showFinishedSubagents }),
              },
            ],
            empty: '没有在运行的子 Agent',
          },
  }

  if (all.length === 0) return props.children
  // The badge sits inside its session's row: claiming the touch keeps the row from opening the
  // session under the menu, which the tap opens. Padding the label gives it a finger's room, and
  // the margins take the room back so the row's line keeps its height.
  return (
    <View onStartShouldSetResponder={() => true} style={styles.hit}>
      <NativeMenu source={source}>
        <View style={styles.pad}>{props.children}</View>
      </NativeMenu>
    </View>
  )
}

const ROOM = 12

const styles = StyleSheet.create({
  hit: { marginVertical: -ROOM, marginHorizontal: -ROOM / 2 },
  pad: { paddingVertical: ROOM, paddingHorizontal: ROOM / 2 },
})
