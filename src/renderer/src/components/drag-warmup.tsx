import { useEffect, useState } from 'react'
import { DragDropProvider, useDragDropManager, useDraggable } from '@dnd-kit/react'
import { useViewStore } from '@renderer/stores/view'
import type { lightPlugins } from './drag-feedback'

const WARM_ID = 'kettu-drag-warmup'

/** Only Feedback, the plugin that registers dnd-kit's stylesheet, told apart by its code. */
const feedbackOnly: typeof lightPlugins = (defaults) =>
  defaults.filter((plugin) => /\bretain\b/.test(String(plugin)))

function WarmDrag() {
  const manager = useDragDropManager()
  useDraggable({ id: WARM_ID })
  useEffect(() => {
    if (!manager) return
    try {
      manager.actions.start({ source: WARM_ID, coordinates: { x: 0, y: 0 } })
      manager.actions.stop({ canceled: true })
    } catch {
      // A later dnd-kit that starts no drag this way only loses the warm-up.
    }
  }, [manager])
  return null
}

/**
 * Huli: dnd-kit adds its stylesheet to the page as a drag first starts, and takes it away once no
 * provider holds it. The sheet declares a cascade layer, and adding or removing a sheet with one
 * makes Chromium rebuild the page's fonts and lay out all of its text again: a frame of about
 * 140 ms on the first drag of the sidebar's rows or a panel's tabs beside 300 rows. Once the
 * window is idle after launch, this starts and cancels a drag of an item without an element, which
 * nothing shows, so the sheet comes in then and stays: dnd-kit shares it between providers.
 */
export function DragWarmup() {
  const launched = useViewStore((s) => s.main.kind !== 'launch')
  const [warm, setWarm] = useState(false)
  useEffect(() => {
    if (!launched || warm) return
    const go = (): void => setWarm(true)
    // Safari, where the web client may run, has no idle callbacks.
    if (typeof requestIdleCallback === 'function') {
      const id = requestIdleCallback(go)
      return () => cancelIdleCallback(id)
    }
    const id = setTimeout(go, 1)
    return () => clearTimeout(id)
  }, [launched, warm])
  if (!warm) return null
  return (
    <DragDropProvider plugins={feedbackOnly}>
      <WarmDrag />
    </DragDropProvider>
  )
}
