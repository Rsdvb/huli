import { afterEach, describe, expect, it } from 'vitest'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { MarketTools } from '../marketplace/publish-tools'
import { FEATURES, type FeatureDef } from '@shared/features'
import { PLAN_PROMPT } from '../plan-tool'
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
  it("allow without asking only Kettu's plan, report, memory, session, workflow and settings tools, its guide, reading the Marketplace, listing, reading and naming terminals and reading pages", async () => {
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

/** What the service answers a request of an agent's, as a session's token reaches it. */
async function rpc<T>(service: ArtifactService, method: string, params: unknown): Promise<T> {
  const [server] = service.servers('s1', '/repo')
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
  const body = (await response.json()) as { result: T }
  return body.result
}

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
  it('lists the plan tool and the entries to artifacts, sessions and workflows from the start', async () => {
    const service = await everythingOn()
    const { tools } = await rpc<{ tools: Tool[] }>(service, 'tools/list', {})
    const loaded = tools
      .filter((tool) => tool._meta?.['anthropic/alwaysLoad'] === true)
      .map((tool) => tool.name)
    expect(loaded.sort()).toEqual(
      ['create_artifact', 'set_plan', 'start_session', 'suggest_workflow'].sort(),
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
      features: () => features.current,
    } as unknown as ArtifactServiceDeps
    const service = new ArtifactService(deps)
    services.push(service)
    await service.start()
    return service
  }

  const listed = async (service: ArtifactService) =>
    (await rpc<{ tools: Tool[] }>(service, 'tools/list', {})).tools.map((tool) => tool.name)

  /** Each feature's tools, as a session of its role lists them with everything on. */
  async function toolsOf(feature: FeatureDef, role: string): Promise<string[]> {
    const on = { current: {} }
    const all = await listed(await switched(on, role))
    const off = { current: { [feature.id]: false } }
    const without = new Set(await listed(await switched(off, role)))
    return all.filter((name) => !without.has(name))
  }

  it('offer every tool the registry names while its feature is on', async () => {
    const all = new Set([
      ...(await listed(await switched({ current: {} }, 'manager'))),
      ...(await listed(await switched({ current: {} }, 'worker'))),
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
