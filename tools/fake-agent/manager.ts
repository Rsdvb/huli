// Huli: manager mode's scenarios, for driving a manager and its workers through Kite's tools as
// real agents would. `fake:/manager-demo` is a manager that dispatches three workers and answers
// Kite's reports; `/work` is a worker that may ask a permission, may fail once, edits a file and
// calls report_work; a review prompt from Kite runs `/review`, which asks for changes in its first
// round and approves after. Kite's prompts and reminders route here by their first words.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { RequestError, type McpServer } from '@agentclientprotocol/sdk/unstable'
import { kettu, say } from './browser.ts'
import type { Scenario, Turn } from './turn.ts'

interface CallResult {
  text: string
  structured: Record<string, unknown> | null
  isError: boolean
}

type Call = (name: string, args: Record<string, unknown>) => Promise<CallResult>

/** A client of Kite's MCP server, whose calls show in the thread as the agent's tool calls. */
async function tools(turn: Turn): Promise<Call | null> {
  const server = kettu(turn.session.mcpServers as McpServer[])
  if (!server) return null
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
  ])
  const client = new Client({ name: 'fake-agent', version: '0.1.0' })
  const headers = Object.fromEntries(server.headers.map((h) => [h.name, h.value]))
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }),
  )
  let n = 0
  return async (name, args) => {
    const toolCallId = `kite-${turn.id}-${++n}`
    await turn.send({
      sessionUpdate: 'tool_call',
      toolCallId,
      title: `mcp__${server.name}__${name}`,
      kind: 'other',
      status: 'in_progress',
      rawInput: args,
      locations: [],
      content: [],
    })
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })
    const content = result.content as { type: string; text?: string }[]
    const text = content.find((block) => block.type === 'text')?.text ?? ''
    await turn.send({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: result.isError ? 'failed' : 'completed',
      content: [{ type: 'content', content: { type: 'text', text } }],
    })
    return {
      text,
      structured: (result.structuredContent as Record<string, unknown> | undefined) ?? null,
      isError: result.isError === true,
    }
  }
}

/** Kite's leading blocks (its guide, the manager's or a worker's), then the prompt itself. */
export function withoutBlocks(text: string): { blocks: string[]; rest: string } {
  const blocks: string[] = []
  let rest = text.trimStart()
  for (;;) {
    const match = /^<((?:kite|kettu)-[a-z-]+)>[\s\S]*?<\/\1>\s*/.exec(rest)
    if (!match) break
    blocks.push(match[1]!)
    rest = rest.slice(match[0].length)
  }
  return { blocks, rest }
}

/**
 * The command a prompt routes to in manager mode: `fake:` before a command keeps Kite's blocks
 * ahead of it, and Kite's own prompts go to the scenario that answers them.
 */
export function managerRoute(text: string): string | null {
  if (text.startsWith('fake:')) return text.slice('fake:'.length)
  if (/^(请审阅|Review the change)/.test(text)) return `/review ${text}`
  if (/^(审阅者「|The reviewer ")/.test(text)) return `/work ${text}`
  if (/^(Kite 汇报|Kite report)/.test(text)) return `/manager-demo ${text}`
  if (/^(你的审阅还没有结论|Your review has no verdict)/.test(text)) return `/review ${text}`
  if (
    /^(你还没有调用 report_work|You have not called report_work|Kite 重启了|Kite restarted)/.test(
      text,
    )
  ) {
    return `/work --read ${text}`
  }
  return null
}

/** The prompt's text without Kite's blocks ahead of it, with its flags. */
function promptOf(turn: Turn): { text: string; blocks: string[] } {
  const full = turn.prompt.map((block) => (block.type === 'text' ? block.text : '')).join('')
  const { blocks, rest } = withoutBlocks(full)
  return { text: rest.startsWith('fake:') ? rest.slice('fake:'.length) : rest, blocks }
}

function flag(text: string, name: string): string | null {
  const at = text.indexOf(`--${name}`)
  if (at < 0) return null
  const after = text.slice(at + name.length + 2).trimStart()
  const value = after.split(/\s/)[0] ?? ''
  return value.startsWith('--') ? '' : value
}

/** What the demo manager knows of its workers, by its session. */
const demos = new Map<string, { helper: string | null; retried: boolean }>()
/** Workers that failed once already, by session, for `--fail-once`. */
const failed = new Set<string>()

/** `fake:/manager-demo`: dispatches a writer that asks first, an odd job that fails once and a planner. */
export const managerDemo: Scenario = async (turn) => {
  const { text, blocks } = promptOf(turn)
  const call = await tools(turn)
  if (!call) {
    await say(turn, 'This session has no Kite tools.')
    return 'end_turn'
  }
  const state = demos.get(turn.session.id) ?? { helper: null, retried: false }
  demos.set(turn.session.id, state)
  const wake = /^(Kite 汇报|Kite report)/.test(text)
  if (!wake) {
    await call('list_workers', {})
    const writer = await call('start_worker', {
      worker: '写手',
      title: '修复时钟读取',
      task: 'fake:/work --ask\n把 setup 里读两次时钟改成只读一次，并补一个回归测试。',
      acceptance: ['时钟只读一次', '测试通过'],
      files: ['clock.ts'],
    })
    const helper = await call('start_worker', {
      worker: '杂活',
      title: '补文档',
      task: 'fake:/work --fail-once --file docs.md\n在 docs.md 里写一段时钟的说明。',
    })
    await call('start_worker', {
      worker: '规划',
      title: '查重试库',
      task: 'fake:/work --read --secret\n看看项目里有没有现成的重试工具。',
    })
    state.helper = typeof helper.structured?.id === 'string' ? helper.structured.id : null
    const told = blocks.includes('kite-manager') ? '（收到了总管说明）' : ''
    await say(
      turn,
      `已派出三个工人${told}：写手修复时钟（${writer.isError ? writer.text : '已开始'}），杂活补文档，规划查重试库。做完 Kite 会叫我。`,
    )
    return 'end_turn'
  }
  const helperFailed = text.split('\n').some((line) => /杂活/.test(line) && /失败/.test(line))
  if (!state.retried && helperFailed) {
    const listed = await call('list_workers', {})
    const helper =
      state.helper ??
      ((listed.structured?.workers ?? []) as { id: string; name: string }[]).find(
        (w) => w.name === '杂活',
      )?.id ??
      null
    if (!helper) {
      await say(turn, '杂活失败了，但我找不到它。')
      return 'end_turn'
    }
    state.retried = true
    await call('send_message', { id: helper, text: 'fake:/work --file docs.md\n再试一次。' })
    await say(turn, '杂活失败了，我让它再试一次。')
    return 'end_turn'
  }
  const list = await call('list_workers', {})
  const workers = (list.structured?.workers ?? []) as { status: string }[]
  const busy = workers.some((w) =>
    ['running', 'starting', 'awaiting_permission'].includes(w.status),
  )
  await say(
    turn,
    busy ? '收到汇报，还有工人在做，等它们。' : '全部完成：时钟只读一次，文档补好了，审阅通过。',
  )
  return 'end_turn'
}

/** `/work [--ask] [--secret] [--fail-once] [--file <path>] [--read]`: a task, reported with report_work. */
export const work: Scenario = async (turn) => {
  const { text } = promptOf(turn)
  const call = await tools(turn)
  if (flag(text, 'fail-once') !== null && !failed.has(turn.session.id)) {
    failed.add(turn.session.id)
    await say(turn, '开始做……')
    throw RequestError.internalError(undefined, '余额不足：假装的失败')
  }
  if (flag(text, 'ask') !== null) {
    const toolCallId = `ask-${turn.id}`
    const command = 'pnpm add -D p-retry'
    await turn.send({
      sessionUpdate: 'tool_call',
      toolCallId,
      title: `Run ${command}`,
      kind: 'execute',
      status: 'pending',
      rawInput: { command, description: 'Adds a retry helper' },
    })
    const outcome = await turn.requestPermission(
      { toolCallId, title: `Run ${command}`, kind: 'execute', rawInput: { command } },
      [
        { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    )
    if (outcome === 'cancelled') return 'cancelled'
    await turn.send({
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: outcome === 'allow' ? 'completed' : 'failed',
    })
  }
  if (flag(text, 'secret') !== null && call) {
    // As an agent does: the call returns within a minute while the card waits, so it calls again.
    for (let tries = 0; tries < 15; tries++) {
      const result = await call('request_secrets', {
        title: 'Demo API key',
        reason: 'The fake retry service needs a key.',
        fields: [{ name: 'DEMO_API_KEY', label: 'API key' }],
      })
      if (!/has not answered/i.test(result.text)) break
    }
  }
  const changed: string[] = []
  if (flag(text, 'read') === null) {
    const file = flag(text, 'file') || 'clock.ts'
    const path = join(turn.session.cwd, file)
    const before = await readFile(path, 'utf8').catch(() => null)
    const after = `${before ?? ''}// ${turn.session.model}: ${new Date().toISOString()}\n`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, after)
    await turn.send({
      sessionUpdate: 'tool_call',
      toolCallId: `edit-${turn.id}`,
      title: `Edit ${file}`,
      kind: 'edit',
      status: 'completed',
      locations: [{ path }],
      content: [{ type: 'diff', path, oldText: before, newText: after }],
    })
    changed.push(file)
  }
  await turn.sleep(300)
  const fixing = /(审阅者「|The reviewer ")/.test(text)
  const summary = fixing
    ? '按审阅意见处理了 null 的情况。'
    : changed.length > 0
      ? `改好了 ${changed.join(', ')}。`
      : '查过了：项目里没有现成的重试工具，建议用 p-retry。'
  if (call) await call('report_work', { status: 'done', summary, changed_files: changed })
  await say(turn, summary)
  return 'end_turn'
}

/** A review prompt from Kite: changes in round 1, approve after, with report_work. */
export const review: Scenario = async (turn) => {
  const { text } = promptOf(turn)
  const call = await tools(turn)
  const round = Number(
    /第 (\d+)\/\d+ 轮/.exec(text)?.[1] ?? /round (\d+) of/.exec(text)?.[1] ?? '1',
  )
  const approve = round >= Number(process.env.FAKE_AGENT_APPROVE_ON ?? '2')
  await turn.sleep(300)
  const summary = approve ? '可以合并。' : '有一处没处理 null。'
  if (call) {
    await call('report_work', {
      status: 'done',
      summary,
      verdict: approve ? 'approve' : 'changes',
      findings: approve
        ? []
        : [{ level: 'must', file: 'clock.ts', line: 1, text: 'clock 为 null 时没处理' }],
    })
  }
  await say(turn, `${summary}\nVERDICT: ${approve ? 'APPROVE' : 'CHANGES'}`)
  return 'end_turn'
}
