// A developer's screen: a made-up long session in the real conversation list, for measuring how
// it scrolls without a computer. Its options: `entries` in all, `page` for the entries a page
// holds, `stream=1` for a turn that keeps writing, and `label` to name the frame meter's results.
// Opened at huli://dev/long-thread?entries=2000, or at launch with `-huliDevThread "entries=2000"`,
// which shows it in place of the app, never mounting the pairing screen, for a simulator that has
// no computer. Its header counts the entries read so far; `bench=1` times drawing them (RowBench).

import { useMemo } from 'react'
import { Platform, Settings, StyleSheet, TextInput, View } from 'react-native'
import { KeyboardAvoidingView, KeyboardGestureArea } from 'react-native-keyboard-controller'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Conversation } from '../components/Conversation'
import { keyboardOverlap } from '../components/Composer'
import { useMaybeLink } from '../host'
import { useThreadSelector } from '../thread'
import { SessionRows, type SessionRowsContext } from '../ui/session/context'
import { GlassHeader, useHeaderHeight } from '../ui/session/GlassHeader'
import { useSessionTokens } from '../ui/session/palette'
import { WorkingRow } from '../ui/session/Working'
import { devMode } from './devMode'
import { FrameMeter } from './FrameMeter'
import { DEV_SESSION, useLongThread } from './longThread'
import { RowBench } from './RowBench'

export interface LongThreadOptions {
  entries?: string | undefined
  page?: string | undefined
  stream?: string | undefined
  label?: string | undefined
  bench?: string | undefined
}

const ROWS: SessionRowsContext = {
  sessionId: DEV_SESSION,
  root: '/work/huli',
  fork: null,
  forkAtMessage: false,
}

function number(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/** The options the app was launched with to show this screen, or null. */
export function launchedLongThread(): LongThreadOptions | null {
  if (!devMode() || Platform.OS !== 'ios') return null
  const raw = Settings.get('huliDevThread') as unknown
  if (typeof raw !== 'string') return null
  const options: Record<string, string> = {}
  for (const pair of raw.split('&')) {
    const at = pair.indexOf('=')
    if (at > 0) options[pair.slice(0, at)] = decodeURIComponent(pair.slice(at + 1))
  }
  return options
}

export function LongThreadScreen(props: { options: LongThreadOptions }) {
  const { options: params } = props
  const { c } = useSessionTokens()
  const insets = useSafeAreaInsets()
  const headerHeight = useHeaderHeight()
  const options = useMemo(
    () => ({
      entries: number(params.entries, 2000),
      page: number(params.page, 200),
      stream: params.stream === '1',
    }),
    [params.entries, params.page, params.stream],
  )
  const children = useMaybeLink() !== null
  const { view, running } = useLongThread({ ...options, children })
  const since = useMemo(() => Date.now(), [])
  const read = useThreadSelector(view, (thread) => thread?.order.length ?? 0)
  const thread = useThreadSelector(view, (value) => (params.bench === '1' ? value : null))
  return (
    <SessionRows.Provider value={ROWS}>
      <KeyboardAvoidingView
        style={[styles.root, { backgroundColor: c.bg }]}
        behavior="translate-with-padding"
        automaticOffset
        keyboardVerticalOffset={-keyboardOverlap(insets.bottom)}
      >
        <KeyboardGestureArea interpolator="ios" style={styles.root}>
          <Conversation
            view={view}
            sessionId={DEV_SESSION}
            running={running}
            working={
              running ? (
                <View style={styles.working}>
                  <WorkingRow since={since} label="正在运行" tokens={null} waiting={false} />
                </View>
              ) : undefined
            }
            fromParent={false}
            paddingTop={headerHeight + 12}
          />
        </KeyboardGestureArea>
        <View
          style={[
            styles.composer,
            { paddingBottom: insets.bottom + 8, borderTopColor: c.border, backgroundColor: c.bg },
          ]}
        >
          <TextInput
            placeholder="Message"
            placeholderTextColor={c.textTertiary}
            style={[styles.input, { color: c.text, backgroundColor: c.fill }]}
            multiline
          />
        </View>
      </KeyboardAvoidingView>
      <GlassHeader
        floating
        title="Long thread"
        subtitle={`${read} of ${options.entries} entries`}
      />
      {params.bench === '1' && <RowBench thread={thread} label={params.label ?? 'rows'} />}
      <FrameMeter label={params.label ?? `entries=${options.entries}`} top={headerHeight + 4} />
    </SessionRows.Provider>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  working: { paddingTop: 2, paddingBottom: 4 },
  composer: { paddingHorizontal: 12, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth },
  input: { minHeight: 40, borderRadius: 20, paddingHorizontal: 14, paddingTop: 10, fontSize: 16 },
})
