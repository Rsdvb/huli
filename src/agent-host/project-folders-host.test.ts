// Huli: a project's further folders through the host: what the windows may read in them, what an
// agent that takes no workspace roots is told of them, and the worktrees such a project refuses.

import { mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { startTestHost, type TestHost, type TestPort } from './testing/harness'
import { tempFolder } from './testing/temp'

let host: TestHost | null = null

afterEach(async () => {
  await host?.stop()
  host = null
})

/** Sends a prompt and gives the agent's reply once its turn is over. */
async function reply(port: TestPort, sessionId: string, text: string): Promise<string> {
  const replies = () =>
    port.entries(sessionId).flatMap((entry) => (entry.kind === 'agent' ? [entry] : []))
  const before = replies().length
  await port.request('sessions.prompt', { sessionId, content: [{ type: 'text', text }] })
  await port.until(
    () =>
      replies().length > before &&
      !replies().at(-1)!.streaming &&
      port.summary(sessionId)?.status === 'ready',
  )
  return replies().at(-1)!.markdown
}

it("opens a further folder's files to the windows and names it to the agent once", async () => {
  host = await startTestHost()
  const window = host.connect()
  const project = await realpath(host.project)
  // Beside Kite's data, which holds the test's project and which no further folder may be in.
  const beside = await realpath(await tempFolder('kite-folders-'))
  const api = path.join(beside, 'api')
  const other = path.join(beside, 'other')
  await mkdir(api, { recursive: true })
  await mkdir(other, { recursive: true })
  await writeFile(path.join(api, 'server.ts'), 'export {}\n')
  await window.request('projects.add', { path: project })

  // Not a folder of the project yet: neither its files nor its git may be read.
  await expect(window.request('files.list', { projectPath: api })).rejects.toThrow()
  const added = await window.request('projects.addFolder', { path: project, folder: api })
  expect(added.folders).toEqual([{ path: api, name: 'api', missing: false }])
  expect((await window.request('files.list', { projectPath: api })).paths).toContain('server.ts')
  await expect(window.request('files.list', { projectPath: other })).rejects.toThrow()
  await expect(
    window.request('projects.addFolder', { path: project, folder: project }),
  ).rejects.toMatchObject({ code: 'invalid_params' })

  const { id } = await window.request('sessions.create', {
    agentId: 'fake-agent',
    projectPath: project,
  })
  await window.open(id)
  await window.untilStatus(id, 'ready')
  await reply(window, id, 'hello')
  const recalled = await reply(window, id, '/recall')
  expect(recalled).toMatch(/^Your last message was: <kite-project-folders>\n/)
  expect(recalled).toContain(`- ${api}\n</kite-project-folders>`)
  expect(recalled.endsWith('hello')).toBe(true)
  await reply(window, id, 'again')
  expect(await reply(window, id, '/recall')).toBe('Your last message was: again')

  // A worktree would set the project's own folder apart alone, so none is made.
  await expect(
    window.request('sessions.create', {
      agentId: 'fake-agent',
      projectPath: project,
      worktree: { base: 'HEAD' },
    }),
  ).rejects.toMatchObject({ code: 'restricted' })

  await window.request('projects.removeFolder', { path: project, folder: api })
  await expect(window.request('files.list', { projectPath: api })).rejects.toThrow()
  const listed = await window.request('projects.list', undefined)
  expect(listed.find((p) => p.path === project)?.folders).toEqual([])
})
