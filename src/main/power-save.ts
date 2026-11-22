// Keeps the computer from idle sleep while agents work: a session's turn, one waiting on the
// user's answer, or a routine run. It never wakes one, the display still sleeps, and the system's
// own lid and battery rules still apply.

import type { PowerSaveBlocker } from 'electron'

export interface AwakeState {
  /** Settings > General: keep the computer awake while agents work. */
  enabled: boolean
  /** Sessions whose turn runs or waits on a permission, as the tray counts them. */
  running: number
  /** Whether any routine run is starting or running. */
  routines: boolean
}

export function staysAwake(state: AwakeState): boolean {
  return state.enabled && (state.running > 0 || state.routines)
}

export class KeepAwake {
  private state: AwakeState
  private blocker: number | null = null

  constructor(
    enabled: boolean,
    private readonly power: Pick<PowerSaveBlocker, 'start' | 'stop'>,
  ) {
    this.state = { enabled, running: 0, routines: false }
  }

  setEnabled(enabled: boolean): void {
    this.apply({ ...this.state, enabled })
  }

  setRunning(running: number): void {
    this.apply({ ...this.state, running })
  }

  setRoutines(routines: boolean): void {
    this.apply({ ...this.state, routines })
  }

  get blocking(): boolean {
    return this.blocker !== null
  }

  private apply(next: AwakeState): void {
    this.state = next
    const awake = staysAwake(next)
    if (awake === (this.blocker !== null)) return
    if (awake) {
      this.blocker = this.power.start('prevent-app-suspension')
    } else {
      if (this.blocker !== null) this.power.stop(this.blocker)
      this.blocker = null
    }
  }
}
