// What drawing the conversation's rows costs on the JS thread, apart from scrolling: a moment after
// the screen opens, every row of the thread read so far is mounted off screen, and the time from
// asking to drawing them laid out (React's render, the layout of the native views and their text)
// is taken, five times with the rows unmounted between. The first round meets the rows new; later
// ones find what the rows keep between mounts. The times go to huli-frames.json with the meter's.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View, useWindowDimensions } from 'react-native'
import type { ThreadState } from '@shared/thread'
import { ThreadRow } from '../components/EntryView'
import { rowBuilder } from '../ui/session/turns'
import { keepResult } from './FrameMeter'

const ROUNDS = 5

export function RowBench(props: { thread: ThreadState | null; label: string }) {
  const { thread, label } = props
  const width = useWindowDimensions().width - 36
  const rows = useMemo(() => (thread ? rowBuilder()(thread, false) : []), [thread])
  const [shown, setShown] = useState(false)
  const asked = useRef(0)
  const times = useRef<number[]>([])
  const done = useRef(false)

  const ask = useCallback(() => {
    asked.current = performance.now()
    setShown(true)
  }, [])

  useEffect(() => {
    const timer = setTimeout(ask, 2500)
    return () => clearTimeout(timer)
  }, [ask])

  useLayoutEffect(() => {
    if (!shown) return
    times.current.push(Math.round(performance.now() - asked.current))
    const timer = setTimeout(() => setShown(false), 300)
    return () => clearTimeout(timer)
  }, [shown])

  useEffect(() => {
    if (shown || times.current.length === 0 || done.current) return
    if (times.current.length < ROUNDS) {
      const timer = setTimeout(ask, 500)
      return () => clearTimeout(timer)
    }
    done.current = true
    keepResult({ label: `${label} bench`, rows: rows.length, mountMs: times.current })
  }, [shown, label, rows.length, ask])

  return (
    <View pointerEvents="none" style={[styles.bench, { width }]}>
      {shown && rows.map((row) => <ThreadRow key={row.key} row={row} />)}
    </View>
  )
}

const styles = StyleSheet.create({
  bench: { position: 'absolute', top: 0, left: -4000, opacity: 0 },
})
