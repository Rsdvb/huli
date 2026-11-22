import { describe, expect, it } from 'vitest'
import { MANAGER_TOOLS, reportInput, startInput, WORKER_TOOLS } from './tools'

describe("manager mode's tool arguments", () => {
  it('takes a dispatch with its optional parts, trimmed', () => {
    expect(
      startInput({
        worker: '写手',
        task: '修复时钟',
        title: ' 时钟 ',
        kind: 'implement',
        acceptance: [' 测试通过 '],
        files: ['src/clock.ts'],
        request_id: 'r1',
      }),
    ).toEqual({
      worker: '写手',
      task: '修复时钟',
      title: '时钟',
      kind: 'implement',
      acceptance: ['测试通过'],
      files: ['src/clock.ts'],
      requestId: 'r1',
    })
    expect(startInput({ worker: '写手', task: 't' })).toEqual({
      worker: '写手',
      task: 't',
      acceptance: [],
      files: [],
    })
  })

  it('refuses unknown arguments, blank text, bad kinds and long lists', () => {
    expect(() => startInput({ worker: '写手', task: 't', extra: 1 })).toThrow(/Unknown argument/)
    expect(() => startInput({ worker: '写手', task: '  ' })).toThrow(/task/)
    expect(() => startInput({ task: 't' })).toThrow(/worker is needed/)
    expect(() => startInput({ worker: '写手', task: 't', kind: 'boss' })).toThrow(/kind/)
    expect(() =>
      startInput({ worker: '写手', task: 't', acceptance: Array.from({ length: 11 }, () => 'x') }),
    ).toThrow(/acceptance/)
    expect(() => startInput({ worker: '写手', task: 'x'.repeat(20_001) })).toThrow(/task/)
    expect(() => startInput('nope')).toThrow()
  })

  it('takes a report with findings, and refuses one that does not fit', () => {
    expect(
      reportInput({
        status: 'done',
        summary: '可以合并',
        verdict: 'changes',
        changed_files: ['src/a.ts'],
        findings: [
          { level: 'must', file: 'src/a.ts', line: 3, text: 'null' },
          { level: 'nit', text: '命名' },
        ],
      }),
    ).toEqual({
      status: 'done',
      summary: '可以合并',
      verdict: 'changes',
      changed: ['src/a.ts'],
      findings: [
        { level: 'must', file: 'src/a.ts', line: 3, text: 'null' },
        { level: 'nit', text: '命名' },
      ],
    })
    expect(() => reportInput({ summary: 's' })).toThrow(/status is needed/)
    expect(() => reportInput({ status: 'stopped', summary: 's' })).toThrow(/status/)
    expect(() => reportInput({ status: 'done', summary: 's', verdict: 'maybe' })).toThrow(/verdict/)
    expect(() =>
      reportInput({ status: 'done', summary: 's', findings: [{ level: 'must' }] }),
    ).toThrow(/text/)
    expect(() =>
      reportInput({
        status: 'done',
        summary: 's',
        findings: [{ level: 'must', text: 't', line: 0 }],
      }),
    ).toThrow(/line/)
    expect(() => reportInput({ status: 'done', summary: 'x'.repeat(1501) })).toThrow(/summary/)
  })

  it('lists the dispatch and report tools from the start for Claude Code', () => {
    const always = [...MANAGER_TOOLS, ...WORKER_TOOLS]
      .filter((tool) => tool._meta?.['anthropic/alwaysLoad'])
      .map((tool) => tool.name)
    expect(always).toEqual(['list_workers', 'start_worker', 'report_work'])
  })
})
