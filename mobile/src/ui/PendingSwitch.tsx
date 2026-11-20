// A switch for a setting the computer keeps: it takes the new position at once and holds it while
// the computer applies the change, rather than snap back until the computer's answer flips it. A
// failure puts it back; so does an answer that never brings the new value.

import { useEffect, useRef, useState } from 'react'
import { Switch } from 'react-native'
import { useTokens } from './tokens'

/** How long a change the computer took may wait for its new value before the switch gives up. */
const SETTLE_MS = 5000

export function PendingSwitch(props: {
  /** The computer's value. */
  value: boolean
  /** Applies the change; a rejection, or false, says it failed. */
  onChange(next: boolean): Promise<unknown>
  disabled?: boolean
  accessibilityLabel?: string
}) {
  const { c } = useTokens()
  const [pending, setPending] = useState<boolean | null>(null)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => clearTimeout(settle.current ?? undefined), [])
  // The computer's value caught up: the switch follows it again.
  if (pending !== null && props.value === pending) setPending(null)
  return (
    <Switch
      value={pending ?? props.value}
      disabled={props.disabled}
      trackColor={{ true: c.success }}
      accessibilityLabel={props.accessibilityLabel}
      onValueChange={(next) => {
        setPending(next)
        clearTimeout(settle.current ?? undefined)
        props.onChange(next).then(
          (result) => {
            if (result === false) setPending(null)
            else settle.current = setTimeout(() => setPending(null), SETTLE_MS)
          },
          () => setPending(null),
        )
      }}
    />
  )
}
