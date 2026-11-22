import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({}))

const { highlightConfig, parsePickColor, visiblePart } = await import('./pick')

describe('parsePickColor', () => {
  it('takes three channels of 0 to 255', () => {
    expect(parsePickColor({ r: 0, g: 128, b: 255 })).toEqual({ r: 0, g: 128, b: 255 })
    expect(parsePickColor({ r: 1, g: 2, b: 3, a: 9 })).toEqual({ r: 1, g: 2, b: 3 })
  })

  it('refuses what is not a color', () => {
    expect(parsePickColor(null)).toBeNull()
    expect(parsePickColor('#fff')).toBeNull()
    expect(parsePickColor({ r: 256, g: 0, b: 0 })).toBeNull()
    expect(parsePickColor({ r: -1, g: 0, b: 0 })).toBeNull()
    expect(parsePickColor({ r: 0.5, g: 0, b: 0 })).toBeNull()
    expect(parsePickColor({ r: '1', g: 0, b: 0 })).toBeNull()
  })

  it('draws the outline in it', () => {
    const config = highlightConfig({ r: 10, g: 20, b: 30 })
    expect(config.borderColor).toEqual({ r: 10, g: 20, b: 30, a: 0.75 })
    expect(config.showInfo).toBe(true)
    expect(config.showStyles).toBe(false)
  })
})

describe('visiblePart', () => {
  it('cuts a box to the viewport', () => {
    expect(visiblePart({ x: 10, y: 20, width: 30, height: 40 }, 800, 600)).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    })
    expect(visiblePart({ x: -10, y: 590, width: 30, height: 40 }, 800, 600)).toEqual({
      x: 0,
      y: 590,
      width: 20,
      height: 10,
    })
  })

  it('has none of a box out of view', () => {
    expect(visiblePart({ x: 0, y: 700, width: 30, height: 40 }, 800, 600)).toBeNull()
    expect(visiblePart({ x: 10, y: 10, width: 0, height: 40 }, 800, 600)).toBeNull()
  })
})
