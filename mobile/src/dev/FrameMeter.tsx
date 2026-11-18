// A frame meter for the developer's screens: tapped, it counts the gaps between the UI thread's
// frames (through a Reanimated frame callback, which runs late when the UI thread is busy) and
// between the JS thread's (through requestAnimationFrame); tapped again, it shows and keeps what
// it counted: frames per second, frames dropped, and the hitch time ratio in milliseconds of
// lateness per second, as Instruments reports hitches. Each result is added to `huli-frames.json`
// in the app's documents, with when it started and ended, for the simulator scripts to read.

import { useRef, useState } from 'react'
import { Pressable, StyleSheet, Text } from 'react-native'
import { useFrameCallback, useSharedValue } from 'react-native-reanimated'
import { File, Paths } from 'expo-file-system'
import { tallyRenders } from '../ui/renders'

export interface FrameStats {
  label: string
  startedAt: number
  endedAt: number
  ui: ThreadStats
  js: ThreadStats
  /** Renders of the counted components while it measured (renders.ts). */
  renders: Record<string, number>
}

interface ThreadStats {
  fps: number
  frames: number
  /** Frames the display showed with nothing new: a gap of two intervals drops one. */
  dropped: number
  /** Milliseconds a second that frames came later than the display's interval. */
  hitchMsPerS: number
  /** Gaps longer than 50 ms, which read as a stutter. */
  long: number
  worstMs: number
}

/** Gaps by whole milliseconds; the last bucket takes every longer one. */
const BUCKETS = 401

function stats(gaps: readonly number[], worst: number): ThreadStats {
  let frames = 0
  let ms = 0
  let mode = 0
  for (let g = 0; g < gaps.length; g++) {
    frames += gaps[g]!
    ms += g * gaps[g]!
    if (gaps[g]! > gaps[mode]!) mode = g
  }
  // The display's interval is the usual gap: 60 or 120 Hz.
  const interval = mode > 0 && mode < 12 ? 1000 / 120 : 1000 / 60
  let dropped = 0
  let late = 0
  let long = 0
  for (let g = 0; g < gaps.length; g++) {
    const n = gaps[g]!
    if (n === 0) continue
    const missed = Math.max(0, Math.round(g / interval) - 1)
    dropped += missed * n
    if (missed > 0) late += (g - interval) * n
    if (g > 50) long += n
  }
  return {
    fps: ms > 0 ? Math.round((frames / ms) * 10000) / 10 : 0,
    frames,
    dropped,
    hitchMsPerS: ms > 0 ? Math.round((late / ms) * 10000) / 10 : 0,
    long,
    worstMs: Math.round(worst),
  }
}

/** Adds a result to huli-frames.json, for the simulator scripts. */
export function keepResult(result: object): void {
  try {
    const file = new File(Paths.document, 'huli-frames.json')
    let all: object[] = []
    if (file.exists) {
      try {
        all = JSON.parse(file.textSync()) as object[]
      } catch {
        all = []
      }
    }
    all.push(result)
    file.create({ overwrite: true })
    file.write(JSON.stringify(all, null, 1))
  } catch (error) {
    console.warn('Could not keep the frame counts', error)
  }
}

export function FrameMeter(props: { label: string; top: number }) {
  const [running, setRunning] = useState(false)
  const [last, setLast] = useState<FrameStats | null>(null)
  const uiGaps = useSharedValue<number[]>([])
  const uiWorst = useSharedValue(0)
  const frame = useFrameCallback((info) => {
    'worklet'
    const gap = info.timeSincePreviousFrame
    if (gap === null) return
    const bucket = Math.min(BUCKETS - 1, Math.round(gap))
    uiGaps.modify((gaps) => {
      'worklet'
      gaps[bucket] = (gaps[bucket] ?? 0) + 1
      return gaps
    })
    if (gap > uiWorst.value) uiWorst.value = gap
  }, false)
  const js = useRef({ gaps: [] as number[], worst: 0, at: 0, id: 0, startedAt: 0 })

  const start = () => {
    uiGaps.value = new Array<number>(BUCKETS).fill(0)
    uiWorst.value = 0
    js.current = {
      gaps: new Array<number>(BUCKETS).fill(0),
      worst: 0,
      at: 0,
      id: 0,
      startedAt: Date.now(),
    }
    const tick = (time: number) => {
      const j = js.current
      if (j.at > 0) {
        const gap = time - j.at
        j.gaps[Math.min(BUCKETS - 1, Math.round(gap))]!++
        j.worst = Math.max(j.worst, gap)
      }
      j.at = time
      j.id = requestAnimationFrame(tick)
    }
    js.current.id = requestAnimationFrame(tick)
    frame.setActive(true)
    tallyRenders(true)
    setRunning(true)
  }

  const stop = () => {
    frame.setActive(false)
    cancelAnimationFrame(js.current.id)
    const result: FrameStats = {
      label: props.label,
      startedAt: js.current.startedAt,
      endedAt: Date.now(),
      ui: stats(uiGaps.value, uiWorst.value),
      js: stats(js.current.gaps, js.current.worst),
      renders: tallyRenders(false),
    }
    keepResult(result)
    setLast(result)
    setRunning(false)
  }

  return (
    <Pressable
      testID="frame-meter"
      onPress={running ? stop : start}
      style={[styles.meter, { top: props.top }]}
    >
      <Text style={styles.text}>
        {running
          ? 'measuring…'
          : last
            ? `UI ${last.ui.fps} fps, ${last.ui.dropped} dropped, ${last.ui.hitchMsPerS} ms/s\nJS ${last.js.fps} fps, ${last.js.dropped} dropped, ${last.js.hitchMsPerS} ms/s`
            : 'measure'}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  meter: {
    position: 'absolute',
    right: 8,
    zIndex: 50,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  text: { color: 'white', fontSize: 11, fontVariant: ['tabular-nums'] },
})
