import { describe, expect, it } from 'vitest'
import { consoleCall, exceptionEntry, logEntry, shownAt } from './console'

// Shaped as Electron 44's Chromium sends them for a page that throws and rejects.
const APP = 'http://localhost:5173/app.js'

const thrown = {
  exceptionDetails: {
    text: 'Uncaught',
    url: APP,
    lineNumber: 2,
    exception: {
      type: 'object',
      subtype: 'error',
      className: 'TypeError',
      description:
        "TypeError: Cannot read properties of null (reading 'length')\n" +
        `    at render (${APP}:3:26)\n    at ${APP}:4:18`,
    },
    stackTrace: {
      callFrames: [
        { functionName: 'render', url: APP, lineNumber: 2, columnNumber: 25 },
        { functionName: '', url: APP, lineNumber: 3, columnNumber: 17 },
      ],
    },
  },
}

const rejected = {
  exceptionDetails: {
    text: 'Uncaught (in promise)',
    url: APP,
    lineNumber: 4,
    exception: {
      type: 'object',
      subtype: 'error',
      className: 'TypeError',
      description: `TypeError: fetch failed\n    at load (${APP}:5:33)`,
    },
  },
}

describe('errors nothing caught', () => {
  it('reads a thrown error with its message and stack', () => {
    expect(exceptionEntry(thrown)).toEqual({
      level: 'error',
      text: "Uncaught TypeError: Cannot read properties of null (reading 'length')",
      url: APP,
      line: 3,
      stack: [`render (${APP}:3:26)`, `${APP}:4:18`],
    })
  })

  it('reads an unhandled rejection, its stack from the error when the event has none', () => {
    expect(exceptionEntry(rejected)).toMatchObject({
      level: 'error',
      text: 'Uncaught (in promise) TypeError: fetch failed',
      line: 5,
      stack: [`load (${APP}:5:33)`],
    })
  })

  it('reads thrown values that are not errors', () => {
    const plain = {
      exceptionDetails: { text: 'Uncaught', exception: { type: 'string', value: 'nope' } },
    }
    expect(exceptionEntry(plain).text).toBe('Uncaught nope')
    const number = {
      exceptionDetails: {
        text: 'Uncaught (in promise)',
        exception: { type: 'number', value: 42, description: '42' },
      },
    }
    expect(exceptionEntry(number).text).toBe('Uncaught (in promise) 42')
    expect(exceptionEntry({ exceptionDetails: { text: 'Uncaught SyntaxError: bad' } }).text).toBe(
      'Uncaught SyntaxError: bad',
    )
  })
})

describe('console calls', () => {
  it('keeps the stack of an error and shows a logged object', () => {
    const entry = consoleCall({
      type: 'error',
      args: [
        { type: 'string', value: 'save failed' },
        {
          type: 'object',
          className: 'Object',
          description: 'Object',
          preview: { properties: [{ name: 'status', type: 'number', value: '500' }] },
        },
      ],
      stackTrace: {
        callFrames: [{ functionName: 'save', url: APP, lineNumber: 9, columnNumber: 3 }],
      },
    })
    expect(entry).toEqual({
      level: 'error',
      text: 'save failed {status: 500}',
      url: APP,
      line: 10,
      stack: [`save (${APP}:10:4)`],
    })
  })

  it('keeps no stack for plain logs', () => {
    const entry = consoleCall({
      type: 'log',
      args: [{ type: 'string', value: 'ready' }],
      stackTrace: { callFrames: [{ functionName: 'boot', url: APP, lineNumber: 0 }] },
    })
    expect(entry.stack).toEqual([])
    expect(
      logEntry({ entry: { level: 'warning', text: 'slow', url: APP, lineNumber: 0 } }),
    ).toEqual({
      level: 'warn',
      text: 'slow',
      url: APP,
      line: 1,
      stack: [],
    })
  })

  it('filters by level, each with the more severe ones', () => {
    const levels = ['error', 'warn', 'info', 'log', 'debug']
    expect(levels.filter((level) => shownAt(level, 'error'))).toEqual(['error'])
    expect(levels.filter((level) => shownAt(level, 'warn'))).toEqual(['error', 'warn'])
    expect(levels.filter((level) => shownAt(level, 'info'))).toEqual([
      'error',
      'warn',
      'info',
      'log',
    ])
    expect(levels.filter((level) => shownAt(level, 'all'))).toEqual(levels)
  })
})
