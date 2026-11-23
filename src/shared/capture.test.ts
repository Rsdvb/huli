import { describe, expect, it } from 'vitest'
import { MIN_CAPTURE_POINTS, parseCaptureRegion } from './capture'
import { isMiniSessionId } from './mini-window'

const display = { width: 1920, height: 1080 }

describe("Huli: the screenshot overlay's region", () => {
  it('takes a region inside the display, in whole points', () => {
    expect(parseCaptureRegion({ x: 10.4, y: 20.6, width: 100, height: 50 }, display)).toEqual({
      x: 10,
      y: 21,
      width: 100,
      height: 50,
    })
  })

  it('keeps a region that runs off the display to the display', () => {
    expect(parseCaptureRegion({ x: 1900, y: -30, width: 400, height: 100 }, display)).toEqual({
      x: 1900,
      y: 0,
      width: 20,
      height: 70,
    })
  })

  it.each([
    ['nothing', null],
    ['a list', [0, 0, 10, 10]],
    ['a stray click', { x: 5, y: 5, width: MIN_CAPTURE_POINTS - 1, height: 50 }],
    ['text for numbers', { x: '0', y: 0, width: 10, height: 10 }],
    ['an endless number', { x: 0, y: 0, width: Infinity, height: 10 }],
    ['a region off the display', { x: 5000, y: 5000, width: 100, height: 100 }],
  ])('refuses %s', (_, value) => {
    expect(parseCaptureRegion(value, display)).toBeNull()
  })
})

describe("Huli: the mini window's session", () => {
  it('is a session id, never a long or a broken one', () => {
    expect(isMiniSessionId('s-123')).toBe(true)
    expect(isMiniSessionId('')).toBe(false)
    expect(isMiniSessionId('x'.repeat(257))).toBe(false)
    expect(isMiniSessionId('a\0b')).toBe(false)
    expect(isMiniSessionId(7)).toBe(false)
  })
})
