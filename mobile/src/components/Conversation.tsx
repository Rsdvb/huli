// A session's conversation: its rows, oldest first and newest at the bottom, where it opens. It
// stays at the bottom while the newest row grows, if the reader is there; keeps its place when
// older pages come in at the top or a row above changes height; reads older pages as it nears the
// top; and shows the way back down once it is scrolled up. It alone follows every patch of the
// thread; the session screen around it reads only the parts it shows, so a token streaming in
// redraws this list and not the composer.
//
// Legend List draws it rather than an inverted FlatList: it measures rows of any height as they
// come into view, anchors the view on a row when the rows above it change, and follows the end on
// its own, so no row is laid out twice nor the list flipped. Rows are not recycled between items:
// cards keep drafts and open parts in state of their own, which must not pass to another row.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  ActivityIndicator,
  Keyboard,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { LegendList, type LegendListRef } from '@legendapp/list/react-native'
import type { ThreadState } from '@shared/thread'
import type { WritableStore } from '../select'
import { useThreadSelector, type ThreadView } from '../thread'
import { countRender } from '../ui/renders'
import { haptic } from '../ui/session/feedback'
import { useSessionTokens } from '../ui/session/palette'
import { rowBuilder, type Row } from '../ui/session/turns'
import { observeTools } from '../ui/session/work'
import { ToBottomButton } from '../ui/session/Working'
import { SubSessionStart } from './entries/NoteEntries'
import { ThreadRow } from './EntryView'

// How far up the conversation may be scrolled before the way back to its end shows.
const AWAY = 280
const AWAY_TYPING = 56
// Points a millisecond a scroll must move to count as a fling.
const FLING = 1.2
// A row's height before it is measured, until rows of its kind have been.
const GUESS = 90
// How far past the screen rows are drawn ahead of a fling.
const DRAW_AHEAD = 500

const NO_ROWS: Row[] = []
const selectThread = (thread: ThreadState | null) => thread
const rowKey = (row: Row) => row.key
const renderRow = ({ item }: { item: Row }) => <ThreadRow row={item} />

/** A row's kind: the list guesses a row's height from those of its kind measured so far. */
function rowType(row: Row): string {
  return row.type === 'entry' ? row.entry.kind : row.type
}

/** How far the conversation is scrolled up from its end. */
function distanceFromEnd(event: NativeSyntheticEvent<NativeScrollEvent>): number {
  const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
  return contentSize.height - layoutMeasurement.height - contentOffset.y
}

export function Conversation(props: {
  view: ThreadView
  sessionId: string
  /** The turn runs: its last run of work is the latest. */
  running: boolean
  /** What shows under the newest row, as the running turn's line. */
  working: ReactElement | undefined
  /** Under that: the messages waiting on the phone to go. */
  pending?: ReactElement
  /** With no older page, the sub-session's first line names the session it started from. */
  fromParent: boolean
  /** Room above the oldest row, under the floating header. */
  paddingTop: number
  /** Set while the conversation scrolls fast. */
  scrolling?: WritableStore<boolean>
  /** The turn waits for the user, which the way back to the newest message shows. */
  waiting?: boolean
}) {
  countRender('Conversation')
  const { c } = useSessionTokens()
  const { view, sessionId: id, running } = props
  const thread = useThreadSelector(view, selectThread)
  const list = useRef<LegendListRef>(null)
  const [away, setAway] = useState(false)
  const [fresh, setFresh] = useState(false)

  const buildRows = useMemo(() => rowBuilder(), [])
  const rows = useMemo(() => {
    if (!thread) return NO_ROWS
    observeTools(id, thread)
    return buildRows(thread, running)
  }, [thread, id, running, buildRows])

  // New rows while the user reads further up mark the way back down.
  const newest = rows[rows.length - 1]?.key
  const seenNewest = useRef(newest)
  useEffect(() => {
    if (newest !== seenNewest.current && away) setFresh(true)
    seenNewest.current = newest
  }, [newest, away])

  // A fling: what floats over the conversation's top steps aside until it settles.
  const { scrolling } = props
  const last = useRef({ y: 0, at: 0 })
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (settle.current) clearTimeout(settle.current)
    },
    [],
  )
  // With the keyboard up the view is short, so the way back shows as soon as the newest row, the
  // working line, scrolls out of it.
  const keyboardUp = useRef(false)
  const fromEnd = useRef(0)
  const place = useCallback((distance: number) => {
    fromEnd.current = distance
    const next = distance > (keyboardUp.current ? AWAY_TYPING : AWAY)
    setAway((was) => (was === next ? was : next))
    if (!next) setFresh(false)
  }, [])
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => {
      keyboardUp.current = true
      place(fromEnd.current)
    })
    const hidden = Keyboard.addListener('keyboardDidHide', () => {
      keyboardUp.current = false
      place(fromEnd.current)
    })
    return () => {
      shown.remove()
      hidden.remove()
    }
  }, [place])
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      place(distanceFromEnd(event))
      if (!scrolling) return
      const y = event.nativeEvent.contentOffset.y
      const now = Date.now()
      const speed = Math.abs(y - last.current.y) / Math.max(1, now - last.current.at)
      last.current = { y, at: now }
      if (speed < FLING) return
      scrolling.set(true)
      if (settle.current) clearTimeout(settle.current)
      settle.current = setTimeout(() => scrolling.set(false), 450)
    },
    [scrolling, place],
  )

  const toBottom = useCallback(() => {
    haptic.tap()
    void list.current?.scrollToEnd({ animated: true })
  }, [])

  const contentStyle = useMemo(
    () => [styles.content, { paddingTop: props.paddingTop }],
    [props.paddingTop],
  )

  return (
    <>
      <LegendList
        ref={list}
        data={rows}
        keyExtractor={rowKey}
        renderItem={renderRow}
        getItemType={rowType}
        estimatedItemSize={GUESS}
        drawDistance={DRAW_AHEAD}
        recycleItems={false}
        // Opens at the newest row, a short thread sitting at the bottom as a chat does.
        initialScrollAtEnd
        alignItemsAtEnd
        // At the end, it stays there as the reply grows, rows come in and the keyboard opens.
        maintainScrollAtEnd
        maintainScrollAtEndThreshold={0.1}
        // Anywhere else, the rows on screen stay put as pages come in above or rows change.
        maintainVisibleContentPosition
        onStartReached={view.loadOlder}
        onStartReachedThreshold={0.6}
        onScroll={onScroll}
        scrollEventThrottle={64}
        ListHeaderComponent={
          view.loadingOlder ? (
            <View style={styles.older}>
              <ActivityIndicator size="small" color={c.textTertiary} />
            </View>
          ) : !view.hasOlder && props.fromParent ? (
            <SubSessionStart sessionId={id} />
          ) : (
            <View style={styles.end} />
          )
        }
        ListFooterComponent={
          props.pending ? (
            <>
              {props.working}
              {props.pending}
            </>
          ) : (
            props.working
          )
        }
        contentContainerStyle={contentStyle}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      />
      <ToBottomButton
        visible={away}
        fresh={fresh}
        state={props.waiting ? 'waiting' : running ? 'running' : 'idle'}
        onPress={toBottom}
      />
    </>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 18, paddingBottom: 12 },
  older: { paddingVertical: 14, alignItems: 'center' },
  end: { height: 4 },
})
