// Huli: the `delegate` scenario, for Kite's reports that a session an agent started ended its turn:
// it starts sessions of its own through Kite's start_session, as a real agent's MCP client would,
// then works on as a long turn that the reports reach midway.

import type { PermissionOption } from '@agentclientprotocol/sdk/unstable'
import { say } from './browser.ts'
import { kiteTools } from './manager.ts'
import type { Scenario } from './turn.ts'

const TITLES = ['审阅第二问的模型', '补画烟气通道示意图', '核对参考文献格式']
const MAX = TITLES.length

const OPTIONS: PermissionOption[] = [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
]

/**
 * `/delegate [--count <n>] [--ask]` starts one session, or up to three, each running `/basic-turn`
 * under a title of its own, then reads on until it is stopped or a minute passes. With `--ask` it
 * first waits on an approval, so the reports of those sessions wait in Kite's queue until it is
 * answered and then go into the turn.
 */
export const delegate: Scenario = async (turn) => {
  const call = await kiteTools(turn)
  if (!call) {
    await say(turn, 'This session has no Kite tools.')
    return 'end_turn'
  }
  const text = turn.prompt.map((block) => (block.type === 'text' ? block.text : '')).join('')
  const asked = /--count\s+(\d+)/.exec(text)
  const count = Math.min(MAX, Math.max(1, Number(asked?.[1] ?? 1)))
  for (const title of TITLES.slice(0, count)) {
    await call('start_session', { prompt: `/basic-turn ${title}`, title, report: true })
  }
  await say(turn, `Started ${count} session(s); I will go on while they work.`)
  if (/--ask\b/.test(text)) {
    const toolCallId = `delegate-${turn.id}`
    const command = 'latexmk -pdf paper.tex'
    await turn.send({
      sessionUpdate: 'tool_call',
      toolCallId,
      title: `Run ${command}`,
      kind: 'execute',
      status: 'pending',
      rawInput: { command },
    })
    const outcome = await turn.requestPermission(
      { toolCallId, title: `Run ${command}`, kind: 'execute', rawInput: { command } },
      OPTIONS,
    )
    if (outcome === 'cancelled') return 'cancelled'
    await turn.send({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: outcome === 'allow-once' ? 'completed' : 'failed',
    })
  }
  // A long turn of reads, as a real agent's, which the reports reach midway.
  const deadline = Date.now() + 60_000
  let step = 0
  while (Date.now() < deadline) {
    if (turn.signal.aborted) return 'cancelled'
    const toolCallId = `delegate-read-${turn.id}-${++step}`
    const title = `Read sections/part${step}.tex`
    await turn.send({
      sessionUpdate: 'tool_call',
      toolCallId,
      title,
      kind: 'read',
      status: 'in_progress',
    })
    await turn.sleep(1500)
    if (turn.signal.aborted) return 'cancelled'
    await turn.send({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' })
  }
  return 'end_turn'
}
