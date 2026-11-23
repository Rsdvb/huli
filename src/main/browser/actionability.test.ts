import { describe, expect, it } from 'vitest'
import {
  actionProblem,
  AUTO_WAIT_MS,
  pauseBefore,
  waitedFailure,
  type Probe,
} from './actionability'
import { elementMet, selectorMet } from './page-wait'

const ready: Probe = {
  connected: true,
  visible: true,
  enabled: true,
  editable: true,
  inside: true,
  covered: null,
  x: 10,
  y: 20,
}

describe('whether an element can take an action', () => {
  it('passes one that is on the page, visible, enabled and uncovered', () => {
    for (const action of ['click', 'type', 'select'] as const) {
      expect(actionProblem(ready, action)).toBeNull()
    }
  })

  it('fails a removed element at once, without waiting', () => {
    expect(actionProblem({ ...ready, connected: false }, 'click')).toMatchObject({
      code: 'stale_ref',
      retry: false,
    })
  })

  it('waits for one that is hidden, disabled, read-only, off screen or covered', () => {
    expect(actionProblem({ ...ready, visible: false }, 'type')?.message).toMatch(/not visible/)
    expect(actionProblem({ ...ready, enabled: false }, 'click')?.message).toMatch(/disabled/)
    expect(actionProblem({ ...ready, editable: false }, 'type')?.message).toMatch(/read-only/)
    expect(actionProblem({ ...ready, inside: false }, 'click')?.message).toMatch(/outside/)
    const covered = actionProblem({ ...ready, covered: 'div#overlay "Loading…"' }, 'click')
    expect(covered).toMatchObject({ code: 'invalid', retry: true })
    expect(covered?.message).toBe('has its centre covered by div#overlay "Loading…".')
  })

  it('checks only what an action needs', () => {
    // Typing focuses the field, so a label drawn over it or a scrolled page does not matter.
    expect(actionProblem({ ...ready, covered: 'label "Email"', inside: false }, 'type')).toBeNull()
    expect(actionProblem({ ...ready, editable: false }, 'click')).toBeNull()
    expect(actionProblem({ ...ready, editable: false, covered: 'div' }, 'select')).toBeNull()
  })

  it('says how long it waited and what to do', () => {
    const problem = actionProblem({ ...ready, enabled: false }, 'click')!
    expect(waitedFailure('"Pay"', problem, true)).toBe(
      `"Pay" is disabled. It still was after ${AUTO_WAIT_MS / 1000} s. Check what the page needs before it enables it.`,
    )
    const gone = actionProblem({ ...ready, connected: false }, 'click')!
    expect(waitedFailure('ref e4', gone, true)).toBe(
      'ref e4 is no longer on the page. Take a new snapshot.',
    )
  })

  it('checks often at first, then every half second', () => {
    const pauses = Array.from({ length: 10 }, (_, attempt) => pauseBefore(attempt))
    expect(pauses.slice(0, 3)).toEqual([0, 20, 50])
    expect(pauses.slice(-3)).toEqual([500, 500, 500])
  })
})

describe('what browser_wait_for waits for', () => {
  it('ends on the state of the elements a selector matches', () => {
    expect(selectorMet('visible', 2, 1)).toBe(true)
    expect(selectorMet('visible', 2, 0)).toBe(false)
    expect(selectorMet('hidden', 2, 0)).toBe(true)
    expect(selectorMet('hidden', 0, 0)).toBe(true)
    expect(selectorMet('attached', 1, 0)).toBe(true)
    expect(selectorMet('detached', 1, 0)).toBe(false)
    expect(selectorMet('detached', 0, 0)).toBe(true)
  })

  it('ends on the state of a ref’s element', () => {
    expect(elementMet('visible', true, true)).toBe(true)
    expect(elementMet('hidden', true, false)).toBe(true)
    expect(elementMet('hidden', false, false)).toBe(true)
    expect(elementMet('detached', true, false)).toBe(false)
    expect(elementMet('attached', true, false)).toBe(true)
  })
})
