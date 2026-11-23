import { afterEach, describe, expect, it } from 'vitest'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { MarketTools } from '../marketplace/publish-tools'
import { FEATURE_IDS, FEATURES, type FeatureDef } from '@shared/features'
import { PLAN_PROMPT } from '../plan-tool'
import { CORE_TOOLS, declared, GATEWAY_TOOL } from '../tool-gateway'
import { ArtifactService, type AgentProcess, type ArtifactServiceDeps } from './service'

const services: ArtifactService[] = []

async function started(): Promise<ArtifactService> {
  const deps = { log: () => {}, plan: {}, sessions: {} } as unknown as ArtifactServiceDeps
  const service = new ArtifactService(deps)
  services.push(service)
  await service.start()
  return service
}

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()))
})

describe('the servers a session attaches with', () => {
  // An agent that writes its servers onto a command line would show the token to every user.
  it('mark the token as a secret', async () => {
    const service = await started()
    const process = { closed: new Promise<void>(() => {}) } as AgentProcess
    const servers = [
      ...service.servers('s1', '/repo'),
      ...service.folderServers(process, '/repo', 's2'),
    ]
    expect(servers).toHaveLength(2)
    for (const server of servers) expect(server.secret).toBe(true)
  })

  // Allowed tools run without asking the user, so none may reach past Kettu's own data.
  it("allow without asking only Kettu's plan, report, memory, session, workflow, Marketplace and settings tools, its guide, listing, reading and naming terminals and reading pages", async () => {
    const service = await started()
    const process = { closed: new Promise<void>(() => {}) } as AgentProcess
    const expected = [
      'set_plan',
      // A terminal of the user's asks them in Kettu's own card before these reach it.
      'terminal_list',
      'terminal_read',
      'terminal_wait',
      'terminal_rename',
      'browser_snapshot',
      'browser_take_screenshot',
      'browser_wait_for',
      'browser_console_messages',
      'browser_network_requests',
      'browser_network_request',
      'browser_downloads',
      'report_problem',
      'list_memories',
      'read_memory',
      'remember',
      'update_memory',
      'forget_memory',
      'list_agents',
      'list_sessions',
      'get_session',
      'rename_session',
      'set_board_status',
      'archive_session',
      'start_session',
      'read_session_history',
      'send_message',
      // Huli: manager mode's own tools, which check what each may do themselves.
      'list_workers',
      'start_worker',
      'get_worker',
      'stop_worker',
      'answer_worker_request',
      'report_work',
      'list_workflows',
      'suggest_workflow',
      'create_workflow',
      'report_step',
      'pick_step_agents',
      'marketplace_check',
      'marketplace_mine',
      // Publishing and unlisting ask the user in Kettu's own card before anything leaves.
      'marketplace_publish',
      'marketplace_unlist',
      'find_settings',
      'open_settings',
      'change_settings',
      // Kettu's own card asks the user for the values, so the agent's prompt never does.
      'request_secrets',
      // So does the theme's, unless the session is in Full access.
      'read_theme',
      'set_theme_colors',
      'read_kettu_guide',
    ]
    for (const server of [
      ...service.servers('s1', '/repo'),
      ...service.folderServers(process, '/repo', 's2'),
    ]) {
      expect(server.type === 'stdio' ? [] : [...(server.autoAllow ?? [])].sort()).toEqual(
        [...expected].sort(),
      )
    }
  })
})

/**
 * What the service answers a request of an agent's, as a session's token reaches it; `gateway` for
 * an agent given the short list.
 */
async function answer<T>(
  service: ArtifactService,
  method: string,
  params: unknown,
  gateway = false,
): Promise<{ result?: T; error?: { message: string } }> {
  const [server] = service.servers('s1', '/repo', gateway)
  if (!server || server.type !== 'http') throw new Error('No server')
  const response = await fetch(server.url, {
    method: 'POST',
    headers: {
      ...Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return (await response.json()) as { result?: T; error?: { message: string } }
}

async function rpc<T>(service: ArtifactService, method: string, params: unknown): Promise<T> {
  return (await answer<T>(service, method, params)).result!
}

/** A call of the gateway from a session given the short list. */
async function viaGateway(service: ArtifactService, args: unknown): Promise<CallToolResult> {
  const body = await answer<CallToolResult>(
    service,
    'tools/call',
    { name: GATEWAY_TOOL, arguments: args },
    true,
  )
  if (!body.result) throw new Error(body.error?.message ?? 'No result')
  return body.result
}

const texts = (result: CallToolResult): string =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')

const INITIALIZE = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'test', version: '1' },
}

/** A service with memory, the Marketplace, computer use and workflow suggestions on. */
async function everythingOn(): Promise<ArtifactService> {
  const deps = {
    log: () => {},
    plan: {},
    sessions: {},
    memory: { service: { enabled: true } },
    market: { on: true },
    computer: { call: () => Promise.reject(new Error('not in this test')) },
    workflow: { library: { suggest: true }, isStep: () => false },
  } as unknown as ArtifactServiceDeps
  const service = new ArtifactService(deps)
  services.push(service)
  await service.start()
  return service
}

describe("the service's instructions", () => {
  // Claude Code keeps only the first 4096 characters of a server's instructions.
  it('stay within 4096 characters with memory, the Marketplace and computer use on', async () => {
    const service = await everythingOn()
    const { instructions } = await rpc<{ instructions?: string }>(service, 'initialize', INITIALIZE)
    expect(instructions).toBeTypeOf('string')
    expect(instructions!.length).toBeLessThanOrEqual(4096)
  })
})

describe('what an agent reads before it searches its tools', () => {
  // Claude Code and Codex put a server's prompt into their own instructions.
  it("is Kettu's guide and the plan paragraph in the server's prompt", async () => {
    const service = await everythingOn()
    const [server] = service.servers('s1', '/repo')
    expect(server?.type === 'http' && server.prompt).toBe(
      `${service.guidePrompt(true)}\n\n${PLAN_PROMPT}`,
    )
  })

  // Claude Code defers MCP tools behind a search, so an entry tool it does not list goes unused.
  it('lists the plan tool and the entries to artifacts, sessions, workflows and the browser from the start', async () => {
    const service = await everythingOn()
    const { tools } = await rpc<{ tools: Tool[] }>(service, 'tools/list', {})
    const loaded = tools
      .filter((tool) => tool._meta?.['anthropic/alwaysLoad'] === true)
      .map((tool) => tool.name)
    expect(loaded.sort()).toEqual(
      [
        'browser_navigate',
        'create_artifact',
        'list_workflows',
        'set_plan',
        'start_session',
        'suggest_workflow',
      ].sort(),
    )
  })
})

describe('the Marketplace tools', () => {
  // Publishing needs the host's Kettu account, so agents see the tools only while it is in use.
  it('are listed only while the host is signed in with Kettu’s services on', () => {
    const signedIn = { current: false }
    const market = {
      get on() {
        return signedIn.current
      },
    } as unknown as MarketTools
    const deps = { log: () => {}, plan: {}, sessions: {}, market } as unknown as ArtifactServiceDeps
    const service = new ArtifactService(deps)
    const listed = () =>
      service
        .toolSummaries()
        .map((tool) => tool.name)
        .filter((name) => name.startsWith('marketplace_'))
    expect(listed()).toEqual([])
    signedIn.current = true
    expect(listed()).toEqual([
      'marketplace_check',
      'marketplace_publish',
      'marketplace_mine',
      'marketplace_unlist',
    ])
  })
})

describe('the feature switches of Settings > Features', () => {
  /** A service whose session is a manager or a worker, with the secrets and theme tools. */
  async function switched(features: { current: Record<string, boolean> }, role: string) {
    const deps = {
      log: () => {},
      plan: {},
      sessions: {},
      manager: () => ({ roleOf: () => role }),
      secrets: { call: () => Promise.reject(new Error('not in this test')) },
      theme: { call: () => Promise.reject(new Error('not in this test')) },
      webReader: { read: () => Promise.reject(new Error('not in this test')) },
      features: () => features.current,
    } as unknown as ArtifactServiceDeps
    const service = new ArtifactService(deps)
    services.push(service)
    await service.start()
    return service
  }

  const listed = async (service: ArtifactService) =>
    (await rpc<{ tools: Tool[] }>(service, 'tools/list', {})).tools.map((tool) => tool.name)

  /** Every feature on, those that start off too. */
  const allOn = (): Record<string, boolean> =>
    Object.fromEntries(FEATURE_IDS.map((id) => [id, true]))

  /** Each feature's tools, as a session of its role lists them with everything on. */
  async function toolsOf(feature: FeatureDef, role: string): Promise<string[]> {
    const on = { current: allOn() }
    const all = await listed(await switched(on, role))
    const off = { current: { ...allOn(), [feature.id]: false } }
    const without = new Set(await listed(await switched(off, role)))
    return all.filter((name) => !without.has(name))
  }

  it('offer every tool the registry names while its feature is on', async () => {
    const all = new Set([
      ...(await listed(await switched({ current: allOn() }, 'manager'))),
      ...(await listed(await switched({ current: allOn() }, 'worker'))),
    ])
    for (const feature of FEATURES as readonly FeatureDef[]) {
      for (const name of feature.tools ?? []) expect(all, `${feature.id}: ${name}`).toContain(name)
    }
  })

  it("neither list nor answer a feature's tools while it is off, and offer them again once on", async () => {
    const expected: Record<string, string[]> = {
      board: ['set_board_status'],
      manager: [
        'list_workers',
        'start_worker',
        'get_worker',
        'stop_worker',
        'answer_worker_request',
      ],
      secrets: ['request_secrets'],
      agentTheme: ['read_theme', 'set_theme_colors'],
      webReader: ['read_web_page'],
    }
    for (const [id, names] of Object.entries(expected)) {
      const feature = (FEATURES as readonly FeatureDef[]).find((each) => each.id === id)!
      expect((await toolsOf(feature, 'manager')).sort(), id).toEqual([...names].sort())
    }
    const devices = (FEATURES as readonly FeatureDef[]).find((each) => each.id === 'devices')!
    const deviceTools = await toolsOf(devices, 'manager')
    expect(deviceTools.length).toBeGreaterThan(10)
    expect(deviceTools.every((name) => name.startsWith('device_'))).toBe(true)

    const features = { current: { manager: false, board: false } as Record<string, boolean> }
    const service = await switched(features, 'worker')
    const off = await listed(service)
    expect(off).not.toContain('report_work')
    expect(off).not.toContain('set_board_status')
    for (const name of ['report_work', 'set_board_status']) {
      const answer = await call(service, name, {})
      expect(answer.error?.message).toContain('turned its feature off')
    }
    features.current = {}
    const on = await listed(service)
    expect(on).toContain('report_work')
    expect(on).toContain('set_board_status')
  })

  // Huli: background web reading downloads a program, so it waits for the user's own yes.
  it('keep a feature that starts off unlisted and unanswered until the user turns it on', async () => {
    const features = { current: {} as Record<string, boolean> }
    const service = await switched(features, 'worker')
    expect(await listed(service)).not.toContain('read_web_page')
    const answer = await call(service, 'read_web_page', { url: 'https://example.com/' })
    expect(answer.error?.message).toContain('turned its feature off')
    const { instructions } = await rpc<{ instructions?: string }>(service, 'initialize', INITIALIZE)
    expect(instructions).not.toContain('read_web_page')
    features.current = { webReader: true }
    expect(await listed(service)).toContain('read_web_page')
  })

  it('keep start_session for a manager while manager mode is off', async () => {
    const service = await switched({ current: { manager: false } }, 'manager')
    expect(await listed(service)).toContain('start_session')
    expect(await listed(await switched({ current: {} }, 'manager'))).not.toContain('start_session')
  })

  it("tell agents nothing of a feature that is off in the service's instructions", async () => {
    const service = await switched({ current: { board: false, devices: false } }, 'manager')
    const { instructions } = await rpc<{ instructions?: string }>(service, 'initialize', INITIALIZE)
    expect(instructions).not.toContain('set_board_status')
    expect(instructions).not.toContain('device_')
    expect(service.guidePrompt(true)).not.toContain('kettu-devices')
  })
})

/** A tool call's whole answer, its error included. */
async function call(
  service: ArtifactService,
  name: string,
  args: unknown,
): Promise<{ result?: unknown; error?: { message: string } }> {
  const [server] = service.servers('s1', '/repo')
  if (!server || server.type !== 'http') throw new Error('No server')
  const response = await fetch(server.url, {
    method: 'POST',
    headers: {
      ...Object.fromEntries(server.headers.map((header) => [header.name, header.value])),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  return (await response.json()) as { result?: unknown; error?: { message: string } }
}

// agy drops the largest MCP tools past a budget of its own and cannot call a dropped one over ACP.
describe('an agent that drops tools past a budget of its own', () => {
  it('is listed the core tools and the gateway, within 16000 bytes, the gateway the smallest', async () => {
    const service = await everythingOn()
    const { result } = await answer<{ tools: Tool[] }>(service, 'tools/list', {}, true)
    const tools = result!.tools
    expect(tools.map((tool) => tool.name).sort()).toEqual([...CORE_TOOLS, GATEWAY_TOOL].sort())
    const size = (tool: Tool) => JSON.stringify(declared(tool)).length
    expect(tools.reduce((sum, tool) => sum + size(tool), 0)).toBeLessThanOrEqual(16000)
    const gateway = tools.find((tool) => tool.name === GATEWAY_TOOL)!
    for (const tool of tools) {
      if (tool !== gateway) expect(size(gateway)).toBeLessThan(size(tool))
    }
  })

  it("leaves every other agent's list as it is", async () => {
    const service = await everythingOn()
    const { tools } = await rpc<{ tools: Tool[] }>(service, 'tools/list', {})
    const names = tools.map((tool) => tool.name)
    expect(names).not.toContain(GATEWAY_TOOL)
    expect(names).toEqual(service.toolSummaries().map((tool) => tool.name))
  })

  it("runs only a tool of the session's full list", async () => {
    const service = await everythingOn()
    // A step's own tool, which a session outside a workflow step is not given.
    for (const tool of ['report_step', 'no_such_tool', GATEWAY_TOOL]) {
      const result = await viaGateway(service, { tool, arguments: {} })
      expect(result.isError).toBe(true)
      expect(texts(result)).toContain(`${tool} is not a Kettu tool this session can use`)
    }
    const odd = await viaGateway(service, { tool: 'list_agents', arguments: [] })
    expect(odd.isError).toBe(true)
  })

  it('describes a tool without running it when the call has no arguments', async () => {
    // Memory has no store here, so running a memory tool would fail.
    const service = await everythingOn()
    const result = await viaGateway(service, { tool: 'forget_memory' })
    expect(result.isError).toBeUndefined()
    expect(texts(result)).toContain('Arguments of forget_memory (JSON Schema): {')
  })

  it("runs a tool as a direct call does, and a topic lists its part's tools with their arguments", async () => {
    const service = await everythingOn()
    const result = await viaGateway(service, {
      tool: 'read_kettu_guide',
      arguments: { topic: 'devices' },
    })
    expect(result.isError).toBeUndefined()
    expect(texts(result)).toContain('### device_tap')
    expect(texts(result)).toContain('Arguments of device_tap (JSON Schema): {')
    // The harness may drop a core tool too, so the topic gives its arguments as well.
    const artifacts = await viaGateway(service, {
      tool: 'read_kettu_guide',
      arguments: { topic: 'artifacts' },
    })
    expect(texts(artifacts)).toContain('Arguments of create_artifact (JSON Schema): {')
    expect(texts(artifacts)).not.toContain(`### ${GATEWAY_TOOL}`)

    const direct = await rpc<CallToolResult>(service, 'tools/call', {
      name: 'read_kettu_guide',
      arguments: { topic: 'devices' },
    })
    expect(texts(direct)).not.toContain(GATEWAY_TOOL)
  })

  it('adds the arguments to a call that failed', async () => {
    const service = await everythingOn()
    const result = await viaGateway(service, {
      tool: 'read_kettu_guide',
      arguments: { topic: 'nope' },
    })
    expect(result.isError).toBe(true)
    expect(texts(result)).toContain('Arguments of read_kettu_guide (JSON Schema)')
  })

  it('is no tool for a session given the full list', async () => {
    const service = await everythingOn()
    const body = await answer(service, 'tools/call', {
      name: GATEWAY_TOOL,
      arguments: { tool: 'list_agents', arguments: {} },
    })
    expect(body.error?.message).toContain(`Unknown tool ${GATEWAY_TOOL}`)
  })
})
