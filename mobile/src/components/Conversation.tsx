// A session's conversation: its rows, newest at the bottom, in an inverted list that keeps its
// place as rows come in and reads older pages as it nears the top, with the way back down once it
// is scrolled up. It alone follows every patch of the thread; the session screen around it reads
// only the parts it shows, so a token streaming in redraws this list and not the composer.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Platform,
  StyleSheet,
  View,
  type ListRenderItem,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
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
// Points a millisecond a scroll must move to count as a fling.
const FLING = 1.2

const NO_ROWS: Row[] = []
const selectThread = (thread: ThreadState | null) => thread
const rowKey = (row: Row) => row.key
const renderRow: ListRenderItem<Row> = ({ item }) => <ThreadRow row={item} />

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
  paddingBottom: number
  /** Set while the conversation scrolls fast. */
  scrolling?: WritableStore<boolean>
}) {
  countRender('Conversation')
  const { c } = useSessionTokens()
  const { view, sessionId: id, running } = props
  const thread = useThreadSelector(view, selectThread)
  const list = useRef<FlatList<Row>>(null)
  const [away, setAway] = useState(false)
  const [fresh, setFresh] = useState(false)

  const buildRows = useMemo(() => rowBuilder(), [])
  const rows = useMemo(() => {
    if (!thread) return NO_ROWS
    observeTools(id, thread)
    return buildRows(thread, running)
  }, [thread, id, running, buildRows])

  // New rows while the user reads further up mark the way back down.
  const newest = rows[0]?.key
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
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = event.nativeEvent.contentOffset.y
      const next = y > AWAY
      setAway((was) => (was === next ? was : next))
      if (!next) setFresh(false)
      if (!scrolling) return
      const now = Date.now()
      const speed = Math.abs(y - last.current.y) / Math.max(1, now - last.current.at)
      last.current = { y, at: now }
      if (speed < FLING) return
      scrolling.set(true)
      if (settle.current) clearTimeout(settle.current)
      settle.current = setTimeout(() => scrolling.set(false), 450)
    },
    [scrolling],
  )

  const toBottom = useCallback(() => {
    haptic.tap()
    list.current?.scrollToOffset({ offset: 0, animated: true })
  }, [])

  const contentStyle = useMemo(
    () => [styles.content, { paddingBottom: props.paddingBottom }],
    [props.paddingBottom],
  )

  return (
    <>
      <FlatList
        ref={list}
        inverted
        data={rows}
        keyExtractor={rowKey}
        renderItem={renderRow}
        onEndReached={view.loadOlder}
        onEndReachedThreshold={0.6}
        onScroll={onScroll}
        scrollEventThrottle={64}
        ListHeaderComponent={
          props.pending ? (
            <>
              {props.working}
              {props.pending}
            </>
          ) : (
            props.working
          )
        }
        ListFooterComponent={
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
        contentContainerStyle={contentStyle}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        initialNumToRender={14}
        maxToRenderPerBatch={10}
        windowSize={11}
        // Android draws rows far off screen otherwise; iOS clips them itself.
        removeClippedSubviews={Platform.OS === 'android'}
        maintainVisibleContentPosition={MAINTAIN}
      />
      <ToBottomButton visible={away} fresh={fresh} onPress={toBottom} />
    </>
  )
}

const MAINTAIN = { minIndexForVisible: 1, autoscrollToTopThreshold: 40 }

const styles = StyleSheet.create({
  content: { paddingHorizontal: 18, paddingTop: 12 },
  older: { paddingVertical: 14, alignItems: 'center' },
  end: { height: 4 },
})
