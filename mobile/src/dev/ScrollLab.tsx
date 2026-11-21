// A developer's screen for the simulator: horizontal scrollers in each of the wrappers a reply's
// code block sits in, so one run tells which wrapper keeps a sideways swipe from scrolling.
// Launched with `-huliDevScroll <mode>`, where mode is `plain` (a vertical ScrollView), `list`
// (the conversation's keyboard-aware Legend List) or either with `-nogh` (no gesture root view).
// On iOS the Pressable one (2) never moves, whatever holds it: the reason the code block and the
// reply take a long press through LongPressView, a plain view where no long press is wired.

import { useState, type ReactElement } from 'react'
import { Platform, Pressable, ScrollView, Settings, StyleSheet, Text, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { KeyboardAwareLegendList } from '@legendapp/list/keyboard'
import { KeyboardGestureArea, KeyboardProvider } from 'react-native-keyboard-controller'
import { useSharedValue } from 'react-native-reanimated'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ThreadRow } from '../components/EntryView'
import { Markdown } from '../components/Markdown'
import { HostProvider } from '../host'
import { ContextMenu } from '../ui/ContextMenu'
import { MenuSheetHost } from '../ui/MenuSheet'
import { SessionRows, type SessionRowsContext } from '../ui/session/context'
import { useSessionTokens } from '../ui/session/palette'
import type { Row } from '../ui/session/turns'
import { devMode } from './devMode'

const ROWS: SessionRowsContext = {
  sessionId: 'dev-scroll-lab',
  root: '/work/huli',
  fork: null,
  forkAtMessage: false,
}

const LONG = (end: string) =>
  `const value = issueToken({ subject: 'someone', audience: 'kite', scope: ['read', 'write'] }) // ${end}`

const code = (end: string) =>
  ['```ts', LONG(end), 'const a = 1', 'const b = 2', 'const c = 3', 'const d = 4', '```'].join('\n')

const table = (end: string) =>
  [
    '| 名称 | 说明 | 路径 | 备注 |',
    '| --- | --- | --- | --- |',
    `| 第一行 | 一段相当长的说明文字放在这里 | /very/long/path/to/some/file.ts | ${end} 结尾 |`,
    '| 第二行 | 又一段相当长的说明文字 | /another/long/path/file.ts | 中间 |',
    '| 第三行 | 再来一段说明文字 | /third/long/path/file.ts | 末尾 |',
  ].join('\n')

/** The mode the app was launched with to show this screen, or null. */
export function launchedScrollLab(): string | null {
  if (!devMode() || Platform.OS !== 'ios') return null
  const raw = Settings.get('huliDevScroll') as unknown
  return typeof raw === 'string' && raw ? raw : null
}

function Probe(props: { id: string; label: string; wrap?: (child: ReactElement) => ReactElement }) {
  const { c } = useSessionTokens()
  const [x, setX] = useState(0)
  const scroller = (
    <ScrollView
      horizontal
      testID={props.id}
      scrollEventThrottle={16}
      onScroll={(event) => setX(Math.round(event.nativeEvent.contentOffset.x))}
      style={{ backgroundColor: c.fill }}
    >
      <Text style={{ color: c.text, fontSize: 15, padding: 10 }}>{LONG(props.id + '-END')}</Text>
    </ScrollView>
  )
  return (
    <View style={styles.item}>
      <Text style={[styles.label, { color: c.textSecondary }]}>
        {props.label} x={x}
      </Text>
      {props.wrap ? props.wrap(scroller) : scroller}
    </View>
  )
}

function Labeled(props: { id: string; label: string; children: ReactElement }) {
  const { c } = useSessionTokens()
  return (
    <View style={styles.item} testID={props.id}>
      <Text style={[styles.label, { color: c.textSecondary }]}>{props.label}</Text>
      {props.children}
    </View>
  )
}

const replyRow = (id: string, markdown: string): Row => ({
  type: 'reply',
  key: id,
  entry: { kind: 'agent', id, markdown, attachments: [], streaming: false },
  part: { index: 0, text: markdown, joint: 'block', last: true },
})

const ITEMS: { key: string; render: () => ReactElement }[] = [
  { key: 'p1', render: () => <Probe id="p1" label="1 plain" /> },
  {
    key: 'p2',
    render: () => (
      <Probe
        id="p2"
        label="2 pressable"
        wrap={(child) => (
          <Pressable onLongPress={() => {}} delayLongPress={400}>
            {child}
          </Pressable>
        )}
      />
    ),
  },
  {
    key: 'p3',
    render: () => (
      <Probe
        id="p3"
        label="3 context menu"
        wrap={(child) => (
          <ContextMenu items={[{ key: 'a', label: 'A', onPress: () => {} }]}>
            {() => child}
          </ContextMenu>
        )}
      />
    ),
  },
  {
    key: 'm4',
    render: () => (
      <Labeled id="m4" label="4 markdown code">
        <Markdown markdown={code('m4-END')} />
      </Labeled>
    ),
  },
  {
    key: 'm5',
    render: () => (
      <Labeled id="m5" label="5 thread row code">
        <ThreadRow row={replyRow('m5', code('m5-END'))} />
      </Labeled>
    ),
  },
  {
    key: 'm6',
    render: () => (
      <Labeled id="m6" label="6 markdown table">
        <Markdown markdown={table('m6-END')} />
      </Labeled>
    ),
  },
]

function Lab(props: { mode: string }) {
  const { c } = useSessionTokens()
  const dock = useSharedValue(0)
  const list = props.mode.startsWith('list')
  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <Text style={[styles.title, { color: c.text }]}>scroll lab {props.mode}</Text>
      {list ? (
        <KeyboardGestureArea interpolator="ios" style={styles.root}>
          <KeyboardAwareLegendList
            contentInsetEndAdjustment={dock}
            data={ITEMS}
            keyExtractor={(item) => item.key}
            renderItem={({ item }) => item.render()}
            estimatedItemSize={110}
            recycleItems={false}
            maintainVisibleContentPosition
            contentContainerStyle={styles.content}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
          />
        </KeyboardGestureArea>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {ITEMS.map((item) => (
            <View key={item.key}>{item.render()}</View>
          ))}
        </ScrollView>
      )}
    </View>
  )
}

export function ScrollLab(props: { mode: string }) {
  const body = (
    <KeyboardProvider>
      <SafeAreaProvider>
        <HostProvider>
          <SessionRows.Provider value={ROWS}>
            <Lab mode={props.mode} />
            <MenuSheetHost />
          </SessionRows.Provider>
        </HostProvider>
      </SafeAreaProvider>
    </KeyboardProvider>
  )
  if (props.mode.endsWith('-nogh')) return body
  return <GestureHandlerRootView style={styles.root}>{body}</GestureHandlerRootView>
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  title: { fontSize: 13, paddingTop: 60, paddingHorizontal: 18 },
  content: { paddingHorizontal: 18, paddingBottom: 40 },
  item: { paddingVertical: 8, gap: 4 },
  label: { fontSize: 12 },
})
