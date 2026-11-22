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
//
// The list shows its rows only once it has measured those on screen and placed the end, so a
// session opened again must not make it measure from guesses: its rows are built by the same
// builder as last time, so the rows that did not change are the same objects, and Legend List,
// which keeps the heights it measured by key extractor, row object and width, places them where
// they were and shows them on the push's first frames. It keeps none for a list given
// `getItemType`, which it wraps anew on each mount, so rows have no kinds of their own.
//
// The keyboard never lays the list out again: the list fills the screen behind the composer's dock,
// and the keyboard and the dock only add to its inset at the end, while the content is lifted by
// the keyboard's own height on each of its frames, on the UI thread (KeyboardAwareLegendList, over
// keyboard-controller's chat scroll view). So the rows, the dock and the keyboard move as one, and
// nothing settles a frame later once the keyboard stops.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { KeyboardAwareLegendList } from '@legendapp/list/keyboard'
import type { LegendListRef } from '@legendapp/list/react-native'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import Reanimated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated'
import { useIsFocused } from 'expo-router'
import type { ThreadState } from '@shared/thread'
import { devMode } from '../dev/devMode'
import { useComputerId } from '../host'
import { keepResult } from '../dev/FrameMeter'
import type { WritableStore } from '../select'
import { useThreadSelector, type ThreadView } from '../thread'
import { countRender } from '../ui/renders'
import { RevealContext, type AnchorTarget } from '../ui/session/anchors'
import { haptic } from '../ui/session/feedback'
import { useSessionTokens } from '../ui/session/palette'
import { rowBuilder, type Row } from '../ui/session/turns'
import { observeTools } from '../ui/session/work'
import { MarksShown, ToBottomButton } from '../ui/session/Working'
import { SubSessionStart } from './entries/NoteEntries'
import { ThreadRow } from './EntryView'
import { useRecap, type RecapShown } from './RecapLine'

// How far up the conversation may be scrolled before the way back to its end shows.
const AWAY = 280
const AWAY_TYPING = 56
// Points a millisecond a scroll must move to count as a fling.
const FLING = 1.2
// A row's height before it is measured, until some rows have been.
const GUESS = 90
// How far past the screen rows are drawn ahead of a fling.
const DRAW_AHEAD = 500
// Room left above a heading an `#anchor` link scrolls to.
const ANCHOR_ROOM = 8

const NO_ROWS: Row[] = []
const DEV = devMode()
// A reply the simulator scripts time apart, in characters.
const LONG_REPLY = 50_000
const selectThread = (thread: ThreadState | null) => thread
const renderRow = ({ item }: { item: Row }) => <ThreadRow row={item} />

/** What a session's list keeps between its visits: the heights Legend List keeps are by `key`. */
interface ListMemory {
  build: ReturnType<typeof rowBuilder>
  key: (row: Row) => string
}

// As many as the threads the cache keeps in memory (cache.ts).
const MEMORIES_KEPT = 6
const memories = new Map<string, ListMemory>()

function listMemory(sessionId: string): ListMemory {
  const memory = memories.get(sessionId) ?? { build: rowBuilder(), key: (row: Row) => row.key }
  memories.delete(sessionId)
  memories.set(sessionId, memory)
  for (const old of memories.keys()) {
    if (memories.size <= MEMORIES_KEPT) break
    memories.delete(old)
  }
  return memory
}

/** How far the conversation is scrolled up from its end, which the dock and keyboard inset. */
function distanceFromEnd(event: NativeSyntheticEvent<NativeScrollEvent>): number {
  const { contentInset, contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
  return contentSize.height + contentInset.bottom - layoutMeasurement.height - contentOffset.y
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
  /** Where the recap of time away goes for the screen to show, under its header. */
  recapSlot?: WritableStore<RecapShown | null>
  /** The room the recap's bar takes while it shows, added to `paddingTop`. */
  recapRoom?: number
  /** Set while the conversation scrolls fast. */
  scrolling?: WritableStore<boolean>
  /** The turn waits for the user, which the way back to the newest message shows. */
  waiting?: boolean
  /** What the running turn does now, which the way back's dots act out. */
  phase?: string | null
  /** The height of the dock over the list's end: the composer and what stands above it. */
  dock: SharedValue<number>
  /** How much of the dock's bottom room the keyboard covers once it is up (keyboardOverlap). */
  keyboardOverlap: number
}) {
  countRender('Conversation')
  const { c } = useSessionTokens()
  const { view, sessionId: id, running } = props
  // Covered by another screen, the conversation holds what it showed rather than following every
  // patch out of sight, and catches up once in front again.
  const focused = useIsFocused()
  const thread = useThreadSelector(view, selectThread, undefined, !focused)
  const list = useRef<LegendListRef>(null)
  const [away, setAway] = useState(false)
  const [fresh, setFresh] = useState(false)

  const memory = useMemo(() => listMemory(id), [id])
  const rows = useMemo(() => {
    if (!thread) return NO_ROWS
    observeTools(id, thread)
    return memory.build(thread, running)
  }, [thread, id, running, memory])
  // The list's size before its layout, whose width its kept heights are restored at.
  const screen = useWindowDimensions()
  const listSize = useMemo(
    () => ({ width: screen.width, height: screen.height }),
    [screen.width, screen.height],
  )

  // New rows while the user reads further up mark the way back down.
  // A reply growing past another of its parts is the same reply.
  const endRow = rows[rows.length - 1]
  const newest = endRow?.type === 'reply' ? endRow.entry.id : endRow?.key
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

  // What happened while the user was away, and the way back to where they left off, which the
  // screen shows in a bar under its header; the conversation makes room for it at its top.
  const { recap, done: doneWithRecap } = useRecap(useComputerId(), id, view, thread, focused)
  const paddingTop = props.paddingTop + (recap ? (props.recapRoom ?? 0) : 0)
  const jumpFrom = useRef<string | null>(null)
  const { recapSlot } = props
  useEffect(() => {
    recapSlot?.set(
      recap
        ? {
            recap,
            jump: () => {
              jumpFrom.current = recap.from
              doneWithRecap()
            },
            dismiss: doneWithRecap,
          }
        : null,
    )
  }, [recapSlot, recap, doneWithRecap])
  useEffect(() => () => recapSlot?.set(null), [recapSlot])
  // Jumped: once the bar has gone and given its room back, so the first new row comes to just
  // under the header.
  useEffect(() => {
    const from = jumpFrom.current
    if (from === null || recap || !thread) return
    jumpFrom.current = null
    const start = thread.order.indexOf(from)
    if (start < 0) return
    const after = new Set(thread.order.slice(start))
    const index = rows.findIndex((row) =>
      row.type === 'run'
        ? row.entries.some((entry) => after.has(entry.id))
        : (row.type === 'entry' || row.type === 'reply') && after.has(row.entry.id),
    )
    if (index < 0) return
    requestAnimationFrame(() => {
      void list.current?.scrollToIndex({ index, animated: true, viewOffset: headerRoom.current })
    })
  }, [recap, thread, rows])

  const toBottom = useCallback(() => {
    haptic.tap()
    void list.current?.scrollToEnd({ animated: true })
  }, [])

  // A reply's `#anchor` link: its heading comes to just under the floating header. The same
  // function for the list's life, as every reply's text takes it.
  const headerRoom = useRef(paddingTop)
  headerRoom.current = paddingTop
  const reveal = useCallback((target: AnchorTarget) => {
    const scroller = list.current?.getNativeScrollRef()
    if (!scroller) return
    target.measureInWindow((_x, y) => {
      scroller.measureInWindow((_left: number, top: number) => {
        const now = list.current
        if (!now) return
        const offset = now.getState().scroll + y - top - headerRoom.current - ANCHOR_ROOM
        void now.scrollToOffset({ offset: Math.max(0, offset), animated: true })
      })
    })
  }, [])

  // The way back down floats over the dock, and rises with it and the keyboard on the UI thread.
  const keyboard = useReanimatedKeyboardAnimation()
  const { dock, keyboardOverlap } = props
  const overDock = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: -(
          dock.value +
          Math.max(0, -keyboard.height.value - keyboardOverlap * keyboard.progress.value)
        ),
      },
    ],
  }))

  // For the simulator scripts: how long the list took from its mount to show its rows, which it
  // does once it has placed the end of the thread, and to lay out the first row of a long reply,
  // which may come later than a thread read from the cache.
  const mountedAt = useRef(Date.now())
  const rowCount = useRef(0)
  rowCount.current = rows.length
  const keep = useCallback((label: string) => {
    const at = Date.now()
    keepResult({ label, ms: at - mountedAt.current, rows: rowCount.current, at })
  }, [])
  const onLoad = useCallback(() => keep('conversation-shown'), [keep])
  const longDrawn = useRef(false)
  const onItemSizeChanged = useCallback(
    ({ itemData }: { itemData: Row }) => {
      const entry = itemData.type === 'reply' || itemData.type === 'entry' ? itemData.entry : null
      if (longDrawn.current || entry?.kind !== 'agent' || entry.markdown.length < LONG_REPLY) return
      longDrawn.current = true
      keep('long-reply-drawn')
    },
    [keep],
  )

  const contentStyle = useMemo(() => [styles.content, { paddingTop }], [paddingTop])

  return (
    <RevealContext value={reveal}>
      <KeyboardAwareLegendList
        ref={list}
        contentInsetEndAdjustment={dock}
        keyboardOffset={keyboardOverlap}
        data={rows}
        keyExtractor={memory.key}
        renderItem={renderRow}
        estimatedItemSize={GUESS}
        estimatedListSize={listSize}
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
        {...(DEV ? { onLoad, onItemSizeChanged } : {})}
        onStartReached={view.loadOlder}
        onStartReachedThreshold={0.6}
        onScroll={onScroll}
        scrollEventThrottle={64}
        ListHeaderComponent={
          view.loadingOlder ? (
            <View style={styles.older}>
              <ActivityIndicator size="small" color={c.textTertiary} />
            </View>
          ) : view.olderError && view.hasOlder ? (
            // A page that failed is not asked for again by scrolling, which reached the top
            // already: it says so, with a way to try again.
            <Pressable
              onPress={view.loadOlder}
              accessibilityRole="button"
              accessibilityLabel={`${view.olderError}，重试`}
              style={({ pressed }) => [
                styles.older,
                styles.olderFailed,
                pressed && { opacity: 0.6 },
              ]}
            >
              <Text style={[styles.olderText, { color: c.textSecondary }]} numberOfLines={2}>
                {view.olderError}
              </Text>
              <Text style={[styles.olderText, { color: c.tint, fontWeight: '600' }]}>重试</Text>
            </Pressable>
          ) : !view.hasOlder && props.fromParent ? (
            <SubSessionStart sessionId={id} />
          ) : (
            <View style={styles.end} />
          )
        }
        ListFooterComponent={
          // Scrolled away, the working line is out of sight, and its marks hold still.
          <MarksShown value={!away}>
            {props.working}
            {props.pending}
          </MarksShown>
        }
        contentContainerStyle={contentStyle}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
      />
      <Reanimated.View pointerEvents="box-none" style={[styles.overDock, overDock]}>
        <ToBottomButton
          visible={away}
          fresh={fresh}
          state={props.waiting ? 'waiting' : running ? 'running' : 'idle'}
          phase={props.phase ?? null}
          onPress={toBottom}
        />
      </Reanimated.View>
    </RevealContext>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 18, paddingBottom: 12 },
  older: { paddingVertical: 14, alignItems: 'center' },
  olderFailed: { flexDirection: 'row', justifyContent: 'center', gap: 8 },
  olderText: { fontSize: 13, lineHeight: 18 },
  end: { height: 4 },
  // Tall enough to hold the button, whose touches a zero-height box would not reach.
  overDock: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 72 },
})
