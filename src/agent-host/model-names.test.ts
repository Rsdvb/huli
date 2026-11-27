import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { configValueFor, type ConfigOption } from '@shared/thread'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'
import { tempFolder } from './testing/temp'

// A model the fake agent lists under the alias `fable`, or under its full id while a session runs
// that id or was resumed on it, as Claude Code lists Fable 5.2.
const FABLE = { value: 'fable', id: 'fake-fable-5-2', name: 'Fake Fable 5.2' }

const hosts: TestHost[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
})

const projectFile = (host: TestHost, file: Record<string, unknown>): Promise<void> =>
  writeFile(
    path.join(host.project, '.fake-agent.json'),
    JSON.stringify({ aliases: [FABLE], ...file }),
  )

const modelOption = (window: TestPort, id: string): ConfigOption | undefined =>
  window.thread(id).session.config.find((o) => o.category === 'model')

/** The name the menus show for the session's model: its own choice's, or the one it shows as. */
function modelName(window: TestPort, id: string): string | undefined {
  const option = modelOption(window, id)
  const own = option?.choices?.find((c) => c.value === option.value)
  return option?.choices?.find((c) => c.value === (own?.shownAs ?? own?.value))?.name
}

async function newSession(window: TestPort, host: TestHost): Promise<string> {
  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: host.project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  return id
}

async function prompt(window: TestPort, id: string): Promise<void> {
  const replies = window.entries(id).filter((e) => e.kind === 'agent').length
  await window.request('sessions.prompt', {
    sessionId: id,
    content: [{ type: 'text', text: 'hi' }],
  })
  await window.until(() => window.entries(id).filter((e) => e.kind === 'agent').length > replies)
  await window.untilStatus(id, 'ready')
}

async function setModel(window: TestPort, id: string, value: string): Promise<void> {
  await window.request('sessions.setConfigOption', { sessionId: id, optionId: 'model', value })
  await window.until(() => modelOption(window, id)?.value === value)
}

it('starts a new session on a model chosen under its full id that it now lists by its alias', async () => {
  const host = await startTestHost()
  hosts.push(host)
  const window = host.connect()
  await projectFile(host, {})
  const first = await newSession(window, host)
  await setModel(window, first, FABLE.value)
  await prompt(window, first)
  // Resumed, it lists the model under its full id alone, so that is the value chosen there.
  await window.request('sessions.close', { sessionId: first })
  await window.untilStatus(first, 'closed')
  await prompt(window, first)
  await setModel(window, first, 'deep')
  await setModel(window, first, FABLE.id)
  expect(
    (await window.request('agents.options', undefined)).find((o) => o.agentId === 'fake-agent')
      ?.remembered.model,
  ).toBe(FABLE.id)

  const second = await newSession(window, host)
  expect(modelOption(window, second)?.value).toBe(FABLE.value)
  expect(modelName(window, second)).toBe(FABLE.name)
})

it('keeps the model of a session revived and restarted on its full id', async () => {
  const dir = await tempFolder('kettu-model-names-')
  // Like codex-acp, it opens a session it resumes at its own default, so Kettu sets the model back.
  const agentEnv = { FAKE_AGENT_RESUME_CONFIG: 'reset' }
  const first = await startTestHost({ userDataPath: dir, agentEnv })
  hosts.push(first)
  const window = first.connect()
  await projectFile(first, {})
  const id = await newSession(window, first)
  await setModel(window, id, FABLE.value)
  await prompt(window, id)

  // Let go, the agent resumes it on the full id and lists the model under that alone.
  await window.request('sessions.close', { sessionId: id })
  await window.untilStatus(id, 'closed')
  await prompt(window, id)
  expect(modelName(window, id)).toBe(FABLE.name)
  expect(
    modelOption(window, id)
      ?.choices?.filter((c) => !c.shownAs)
      .map((c) => c.name),
  ).toEqual(['Fake Swift', 'Fake Balanced', 'Fake Deep', FABLE.name])

  // New session still finds the model remembered among the ones it keeps.
  const kept = (await window.request('agents.options', undefined)).find(
    (o) => o.agentId === 'fake-agent',
  )
  const keptModel = kept?.config.find((o) => o.category === 'model')
  const remembered = kept?.remembered.model
  expect(remembered).toBeDefined()
  expect(keptModel && configValueFor(keptModel, remembered!)).toBeTruthy()

  await first.stop()
  hosts.splice(0)
  const second = await startTestHost({ userDataPath: dir, agentEnv, projectDir: first.project })
  hosts.push(second)
  await projectFile(second, { resumedOn: FABLE.id })
  const again = second.connect()
  await again.open(id)
  await prompt(again, id)
  expect(modelName(again, id)).toBe(FABLE.name)
})
