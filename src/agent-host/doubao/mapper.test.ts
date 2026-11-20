// What the Doubao mapper makes of Doubao CLI 2.37.2's stream-json, replayed from its scrubbed output.

import { describe, expect, it } from 'vitest'
import type { ThreadEntry, ToolEntry } from '@shared/thread'
import { DoubaoThread, fixtureLines, fixtureText } from '../testing/fake-doubao'
import { after, commandResult, DoubaoMapper } from './mapper'
import type { ExportedTurn, StreamEvent } from './protocol'

// The folder the recorded turns ran in, as the CLI wrote it.
const CWD = 'C:\\work\\kite-doubao'

function play(name: string) {
  const thread = new DoubaoThread(CWD)
  const mapper = new DoubaoMapper(CWD)
  const unmapped: string[] = []
  for (const line of fixtureLines(name)) {
    const event = JSON.parse(line) as StreamEvent
    const out = mapper.event(event, thread.context())
    if (out) thread.apply(out)
    else unmapped.push(event.type)
  }
  return { thread, entries: thread.entries, unmapped }
}

const tools = (entries: ThreadEntry[]) =>
  entries.filter((entry): entry is ToolEntry => entry.kind === 'tool')
const replies = (entries: ThreadEntry[]) =>
  entries.flatMap((entry) => (entry.kind === 'agent' ? [entry.markdown] : []))

describe('the Doubao mapper', () => {
  it('streams a reply into one message, which its whole text then settles', () => {
    const { entries, unmapped } = play('simple.jsonl')
    expect(unmapped).toEqual(['system'])
    expect(entries).toEqual([
      expect.objectContaining({ kind: 'agent', markdown: '1+1 等于 2。', streaming: false }),
    ])
  })

  it('gives no entry an id the host would take for one of its numbered own', () => {
    // The host numbers its entries past every `<word>:<digits>` id, and Doubao's ids are 17 digits.
    for (const name of ['simple.jsonl', 'tools.jsonl', 'interleaved.jsonl', 'risky-denied.jsonl']) {
      for (const entry of play(name).entries) {
        if (entry.kind !== 'notice') expect(entry.id).not.toMatch(/^\w+:\d+$/)
      }
    }
  })

  it('shows a read and a command with their output, and the command’s exit code', () => {
    const { entries } = play('tools.jsonl')
    const [read, command] = tools(entries)
    expect(read).toMatchObject({
      toolKind: 'read',
      status: 'completed',
      locations: [{ path: 'C:\\work\\kite-doubao\\hello.txt' }],
    })
    expect(read!.title).toContain('hello.txt')
    expect(read!.title).not.toContain('C:\\work')
    expect(command).toMatchObject({
      title: 'echo kite-ok',
      toolKind: 'execute',
      rawInput: 'echo kite-ok',
      description: 'Print kite-ok',
      status: 'completed',
      exitCode: 0,
      content: [{ type: 'markdown', markdown: '```\nkite-ok\n```' }],
    })
    expect(replies(entries).at(-1)).toContain('kite-ok')
  })

  it('keeps a write’s and an edit’s diff, since their results are empty', () => {
    const { entries } = play('write.jsonl')
    const [, write, , edit] = tools(entries)
    expect(write).toMatchObject({
      toolKind: 'edit',
      status: 'completed',
      content: [
        {
          type: 'diff',
          path: 'C:\\work\\kite-doubao\\note.txt',
          oldText: null,
          newText: 'kite-write-test',
        },
      ],
    })
    expect(edit).toMatchObject({
      status: 'completed',
      content: [
        {
          type: 'diff',
          oldText: 'second line: banana',
          newText: 'second line: cherry',
        },
      ],
    })
  })

  it('names searches by their pattern, and fails a command that exited with an error', () => {
    const { entries } = play('search-fail.jsonl')
    const [glob, grep, failed] = tools(entries)
    expect(glob).toMatchObject({ toolKind: 'search', status: 'completed' })
    expect(glob!.title).toContain('*.txt')
    expect(grep!.title).toContain('cherry')
    expect(failed).toMatchObject({ status: 'failed', exitCode: 1 })
    expect((failed!.content[0] as { markdown: string }).markdown).toContain('Get-Item')
  })

  it('gives each stretch of a message between its calls an entry, without repeating them', () => {
    const { entries } = play('interleaved.jsonl')
    expect(entries.map((entry) => entry.kind)).toEqual([
      'agent',
      'tool',
      'tool',
      'agent',
      'tool',
      'agent',
    ])
    const texts = replies(entries)
    expect(texts[0]).toBe('接下来我先读取 hello.txt，查看其中已有的内容。')
    expect(texts[2]).toMatch(/^任务已完成/)
    expect(texts.join('').match(/任务已完成/g)).toHaveLength(1)
    expect(entries.every((entry) => entry.kind !== 'agent' || !entry.streaming)).toBe(true)
  })

  it('marks a call the CLI refused to escalate as denied, and says what it refused', () => {
    const { entries } = play('escalation-denied.jsonl')
    const [call] = tools(entries)
    expect(call).toMatchObject({
      status: 'cancelled',
      denied: { by: 'mode', reason: expect.stringContaining('授权目录之外') },
    })
    const notice = entries.find((entry) => entry.kind === 'notice')
    expect(notice).toMatchObject({ severity: 'warning' })
    expect((notice as { description: string }).description).toContain('授权目录之外')
  })

  it('says what a risky action it refused asked, though no call shows for it', () => {
    const { entries } = play('risky-denied.jsonl')
    expect(tools(entries).every((call) => call.status === 'completed')).toBe(true)
    const notice = entries.find((entry) => entry.kind === 'notice')
    expect((notice as { description: string }).description).toContain('删除当前目录下的 note.txt')
  })

  it('ends a reply that was still streaming when the turn stopped', () => {
    const thread = new DoubaoThread(CWD)
    const mapper = new DoubaoMapper(CWD)
    const delta = fixtureLines('simple.jsonl')[1]!
    thread.apply(mapper.event(JSON.parse(delta) as StreamEvent, thread.context())!)
    expect(thread.entries[0]).toMatchObject({ streaming: true })
    thread.apply(mapper.finish())
    expect(thread.entries[0]).toMatchObject({ streaming: false })
  })

  it('replays an export as the user’s messages and the replies, without what Kettu sent ahead', () => {
    const thread = new DoubaoThread(CWD)
    thread.replaying = true
    const turns = JSON.parse(fixtureText('export.json')) as ExportedTurn[]
    const ahead: ExportedTurn = {
      query: '<kettu-guide>Use the tools.</kettu-guide>\n\nHi',
      response: 'Hello',
    }
    thread.apply(new DoubaoMapper(CWD).replay([...turns, ahead], thread.context()))
    expect(
      thread.entries.map((entry) =>
        entry.kind === 'user'
          ? ['user', entry.content.map((part) => (part.type === 'text' ? part.text : '')).join('')]
          : entry.kind === 'agent'
            ? ['agent', entry.markdown]
            : [entry.kind],
      ),
    ).toEqual([
      ['user', '用一句话回答：1+1 等于几？'],
      ['agent', '1+1 等于 2。'],
      ['user', '我刚才问你的是什么问题？只复述问题。'],
      ['agent', '你刚才问的是：“用一句话回答：1+1 等于几？”'],
      ['user', 'Hi'],
      ['agent', 'Hello'],
    ])
  })
})

describe('Doubao’s words', () => {
  it('reads a command’s exit code and output, whatever its command holds', () => {
    expect(
      commandResult("echo 'a'", "Command 'echo 'a'' exited with code 0. stdout: a\r\n"),
    ).toEqual({ code: 0, output: 'a\r\n' })
    expect(commandResult(null, 'no such prefix')).toEqual({ code: null, output: 'no such prefix' })
  })

  it('finds what a whole text adds to the stretches before it, their spacing aside', () => {
    expect(after('ab\n\ncd', 'a b')).toBe('cd')
    expect(after('xy', 'ab')).toBeNull()
    expect(after('ab', 'ab')).toBeNull()
  })
})
