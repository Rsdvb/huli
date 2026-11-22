import { describe, expect, it } from 'vitest'
import { parseCommand } from './commands'

describe('parseCommand', () => {
  it('reads plain text as a message', () => {
    expect(parseCommand('  fix the build  ')).toEqual({ kind: 'text', text: 'fix the build' })
  })

  it('sends a double slash to the agent as written', () => {
    expect(parseCommand('//compact now')).toEqual({ kind: 'text', text: '/compact now' })
  })

  it('reads the commands and their aliases', () => {
    expect(parseCommand('/list')).toEqual({ kind: 'list' })
    expect(parseCommand('/LS')).toEqual({ kind: 'list' })
    expect(parseCommand('/help')).toEqual({ kind: 'help' })
    expect(parseCommand('/start')).toEqual({ kind: 'help' })
    expect(parseCommand('/stop')).toEqual({ kind: 'stop' })
    expect(parseCommand('/y')).toEqual({ kind: 'allow' })
    expect(parseCommand('/n')).toEqual({ kind: 'deny' })
    expect(parseCommand('/status')).toEqual({ kind: 'status' })
  })

  it('drops the bot name Telegram adds in a group', () => {
    expect(parseCommand('/list@kite_bot')).toEqual({ kind: 'list' })
    expect(parseCommand('/s@kite_bot 2')).toEqual({ kind: 'select', index: 2 })
  })

  it('reads a session number, or none to ask which one', () => {
    expect(parseCommand('/s 3')).toEqual({ kind: 'select', index: 3 })
    expect(parseCommand('/s')).toEqual({ kind: 'select', index: null })
    expect(parseCommand('/s 0')).toEqual({ kind: 'select', index: null })
    expect(parseCommand('/s abc')).toEqual({ kind: 'select', index: null })
  })

  it('reads the slash a Chinese keyboard types', () => {
    expect(parseCommand('、list')).toEqual({ kind: 'list' })
    expect(parseCommand('／s ３')).toEqual({ kind: 'select', index: 3 })
    expect(parseCommand('、2')).toEqual({ kind: 'pick', choices: [2], note: '' })
  })

  it('leaves a sentence that starts with 、 as a message', () => {
    expect(parseCommand('、然后呢')).toEqual({ kind: 'text', text: '、然后呢' })
    expect(parseCommand('、hello there')).toEqual({ kind: 'text', text: '、hello there' })
  })

  it('reads options with a note', () => {
    expect(parseCommand('/2')).toEqual({ kind: 'pick', choices: [2], note: '' })
    expect(parseCommand('/1 3')).toEqual({ kind: 'pick', choices: [1, 3], note: '' })
    expect(parseCommand('/1,3')).toEqual({ kind: 'pick', choices: [1, 3], note: '' })
    expect(parseCommand('/2 use the old API\nand keep tests')).toEqual({
      kind: 'pick',
      choices: [2],
      note: 'use the old API\nand keep tests',
    })
    expect(parseCommand('/2 3apples')).toEqual({ kind: 'pick', choices: [2], note: '3apples' })
    expect(parseCommand('/1 1')).toEqual({ kind: 'pick', choices: [1], note: '' })
  })

  it('reads a new session with a project and an agent', () => {
    expect(parseCommand('/new')).toEqual({ kind: 'new', project: null, agent: null })
    expect(parseCommand('/new 2')).toEqual({ kind: 'new', project: '2', agent: null })
    expect(parseCommand('/new kite Claude Code')).toEqual({
      kind: 'new',
      project: 'kite',
      agent: 'Claude Code',
    })
  })

  it('keeps the lines of a message sent into the running turn', () => {
    expect(parseCommand('/now stop that\nand do this')).toEqual({
      kind: 'now',
      text: 'stop that\nand do this',
    })
    expect(parseCommand('/now')).toEqual({ kind: 'now', text: '' })
  })

  it('reads an artifact number', () => {
    expect(parseCommand('/get 1')).toEqual({ kind: 'get', index: 1 })
    expect(parseCommand('/get')).toEqual({ kind: 'unknown', name: 'get' })
  })

  it('names an unknown command', () => {
    expect(parseCommand('/compact')).toEqual({ kind: 'unknown', name: 'compact' })
    expect(parseCommand('/')).toEqual({ kind: 'unknown', name: '' })
  })
})
