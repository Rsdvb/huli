// Huli: the even pace's tick over a plan bar: where the window's use would stand by now were it
// spread evenly from its start, so the user sees whether they run ahead or behind. As the desktop.

import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import type { PlanLimit } from '@shared/agent-host'
import { evenPacePercent } from '@shared/plan-limits'

/** What the tick says, for the bar's accessibility label; null where the window has none. */
export function paceWords(limit: PlanLimit, now: number): string | null {
  const pace = evenPacePercent(limit, now)
  return pace === null ? null : `按均匀速度此刻应已用 ${Math.round(pace)}%`
}

/** A bar with the tick over it; the bar keeps its own clipping, which the tick stands out of. */
export function PacedBar(props: {
  limit: PlanLimit
  now: number
  /** The bar's height, which the tick stands out of by 2 points above and below. */
  height: number
  color: string
  children: ReactNode
}) {
  const pace = evenPacePercent(props.limit, props.now)
  return (
    <View>
      {props.children}
      {pace !== null && (
        <View
          pointerEvents="none"
          style={[
            styles.tick,
            { left: `${pace}%`, height: props.height + 4, backgroundColor: props.color },
          ]}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  tick: { position: 'absolute', top: -2, width: 2, marginLeft: -1, borderRadius: 1 },
})
