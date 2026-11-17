import { MotionConfig } from 'motion/react'
import { useSettingsStore } from '@renderer/stores/settings'
import { App } from './app'
import { CatchRender, CrashScreen } from './crash-screen'

/**
 * Every Motion animation honors the Reduce motion setting, and the OS setting under System. An
 * error that rendering throws shows the crash screen instead of an empty window.
 */
export function Root() {
  const reduceMotion = useSettingsStore((s) => s.settings.appearance.reduceMotion)
  return (
    <MotionConfig reducedMotion={reduceMotion === 'always' ? 'always' : 'user'}>
      <CatchRender fallback={(details) => <CrashScreen details={details} />}>
        <App />
      </CatchRender>
    </MotionConfig>
  )
}
