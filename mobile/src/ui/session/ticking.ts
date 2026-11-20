// The clock that sheets and lines counting down to a reset go by.

import { useQuarterMinute } from './now'

/** The time now, read again every 15 seconds while `on`, on the screen's shared clock. */
export function useTicking(on: boolean): number {
  return useQuarterMinute(on)
}
