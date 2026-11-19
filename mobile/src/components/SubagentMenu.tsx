// A session's sub-agents, opened from the count on its row as the desktop's badge opens its card:
// each one with whether it runs, or how long it ran, opening its session, and a switch that keeps
// the finished ones in the list. More than a menu holds open the sub-sessions screen instead.
//
// The system's menu is rebuilt whole whenever what it shows changes, even while it is open: its
// rows then drew over each other and its scroll went back to the top. So it shows only what
// changes when a sub-agent starts or ends, never a clock or a running count of tool calls; the
// screen shows those.

import { useCallback, useMemo, type ReactElement } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import type { SessionSummary } from '@shared/agent-host'
import { sameItems, useConnected, useHostSelector, useLink, type HostData } from '../host'
import { setPrefs, usePrefs } from '../prefs'
import { sessionTitle } from '../sessions'
import { spanText } from '../ui/session/format'
import { NativeMenu } from '../ui/session/NativeMenu'
import type { MenuEntry, MenuSource } from '../ui/session/Popover'
import { listedSubagents, subagentRunning, useSubagentDigests } from '../ui/session/subagents'

// More rows than this scroll in a menu, which is not made for that: the screen lists them.
const MENU_MOST = 8

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
  const many = listed.length > MENU_MOST
  const digestOf = useSubagentDigests(link, many ? [] : listed, connected)
  const running = listed.filter(subagentRunning).length

  const row = (child: SessionSummary): MenuEntry => {
    const live = subagentRunning(child)
    // A finished one's time is read once and stays; a running one's would tick.
    const ran = live ? null : (digestOf(child.id)?.durationMs ?? null)
    const failed = child.attention === 'error' || child.status === 'failed'
    const meta = [
      live ? '运行中' : failed ? '失败' : '已完成',
      ran !== null ? spanText(Math.max(0, ran)) : null,
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
  if (many) {
    return (
      <Pressable
        onPress={() => router.push({ pathname: '/subagents/[id]', params: { id: props.parentId } })}
        accessibilityRole="button"
        accessibilityLabel={`${listed.length} 个子 Agent${running > 0 ? `，${running} 个运行中` : ''}`}
        style={styles.hit}
      >
        <View style={styles.pad}>{props.children}</View>
      </Pressable>
    )
  }
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
