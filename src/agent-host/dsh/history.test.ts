// What Kettu reads of DeepSeek Harness's own session logs for an import: the list, with titles,
// times and kinds, and the history a replay maps, against logs dsh wrote itself.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import {
  DshFormatError,
  encodeSegment,
  findLog,
  listSessions,
  logIn,
  projectKey,
  readHistory,
} from './history'
import type { WireMessage } from './protocol'
import { fixture, testHome, type TestHome } from './testing'

const PLATFORM = process.platform as Platform
const TOOLS = '3f2a9c1e-5b7d-4e8a-9c0b-1d2e3f4a5b6c'
const PARENT = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
const CHILD = '4bc9ed73-787d-40e6-83cb-71a91ee4c8a1'
const TITLED = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b'
const BLANK = 'a79b301c-c384-4dc4-ae20-fc48dded7474'
const KITE = 'kettu-0123456789abcdef0123456789abcdef'
const OLDER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'

let home: TestHome

beforeEach(async () => {
  home = await testHome()
})

afterEach(async () => {
  await home.remove()
})

describe('dsh session folders', () => {
  it('names a working directory and a session id as dsh does', () => {
    expect(projectKey('C:\\work\\demo-project')).toBe('--C-work-demo-project--')
    expect(projectKey('/home/me/my app')).toBe('--home-me-my~0020app--')
    expect(projectKey('/')).toBe('--root--')
    expect(encodeSegment(KITE)).toBe(KITE)
    expect(encodeSegment('a/b~c')).toBe('a~002Fb~007Ec')
    expect(encodeSegment('..')).toBe('~002E~002E')
  })

  it('reads the newest generation, as dsh does, plain or compressed', async () => {
    const dir = path.dirname(await home.place(fixture('tools.v4')))
    await writeFile(path.join(dir, 'session.v3.jsonl.zstd'), 'an older generation')
    await writeFile(path.join(dir, 'session.v4.jsonl.tmp-1'), 'a temporary file')
    expect(await logIn(dir)).toEqual({
      file: path.join(dir, 'session.v4.jsonl.zstd'),
      version: 4,
      compressed: true,
    })
  })
})

describe('dsh session list', () => {
  it("lists a folder's sessions newest first, with dsh's titles and times", async () => {
    for (const name of ['tools.v4', 'titled.v4', 'blank.v4', 'subagent-parent.v4'] as const) {
      await home.place(fixture(name))
    }
    await home.place(fixture('subagent-child.v4'), { plain: true })
    const listed = await listSessions(home.root, PLATFORM, home.cwd)
    expect(listed.map((item) => item.sessionId)).toEqual([BLANK, TITLED, TOOLS, PARENT, CHILD])
    const byId = new Map(listed.map((item) => [item.sessionId, item]))
    // The model's title replaced the one dsh made of the first words.
    expect(byId.get(TITLED)).toMatchObject({ title: 'Demo notes review', prompted: true })
    expect(byId.get(TOOLS)).toMatchObject({
      title: 'Hello there, just say hi',
      cwd: home.cwd,
      createdAt: 1795200735180,
      subagent: false,
      prompted: true,
    })
    // The resumed turn's message is its latest.
    expect(byId.get(TOOLS)!.updatedAt).toBe(1795200768766)
    expect(byId.get(CHILD)).toMatchObject({ subagent: true })
    expect(byId.get(BLANK)).toMatchObject({ title: null, prompted: false })
  })

  it('lists only the sessions of the folder asked for, and every folder without one', async () => {
    const other = path.join(path.dirname(home.cwd), 'other-project')
    await home.place(fixture('tools.v4'))
    await home.place(fixture('kite.v4'), { cwd: other })
    expect((await listSessions(home.root, PLATFORM, home.cwd)).map((s) => s.sessionId)).toEqual([
      TOOLS,
    ])
    expect((await listSessions(home.root, PLATFORM, other)).map((s) => s.sessionId)).toEqual([KITE])
    expect((await listSessions(home.root, PLATFORM)).map((s) => s.sessionId).sort()).toEqual(
      [KITE, TOOLS].sort(),
    )
  })

  it('titles a session Kettu made by its words, not the guide Kettu sent ahead of them', async () => {
    await home.place(fixture('kite.v4'))
    const [listed] = await listSessions(home.root, PLATFORM, home.cwd)
    expect(listed!.title).toBe('Summarize the attached notes')
  })

  it('compares folders as the file system does', async () => {
    await home.place(fixture('tools.v4'))
    const listed = await listSessions(
      home.root,
      PLATFORM,
      PLATFORM === 'win32' ? home.cwd.toUpperCase() : `${home.cwd}/`,
    )
    expect(listed.map((item) => item.sessionId)).toEqual([TOOLS])
  })

  it('leaves out a session a newer dsh rewrote, and one in a format it does not read', async () => {
    await home.place(fixture('tools.v4'))
    const newer = fixture('tools.v4').replace('"version":4', '"version":5')
    await home.place(newer, { version: 5 })
    await home.place(fixture('titled.v4').replace('"version":4', '"version":2'), { version: 2 })
    await home.place(fixture('blank.v4').replace('"version":4', '"version":0'), { version: 0 })
    expect(await listSessions(home.root, PLATFORM, home.cwd)).toEqual([])
  })

  it('lists a session of format 3 that an older dsh wrote', async () => {
    await home.place(fixture('tools.v3'))
    const [listed] = await listSessions(home.root, PLATFORM, home.cwd)
    expect(listed).toMatchObject({ sessionId: OLDER, title: 'Hello from an older harness' })
  })

  it('passes over a damaged log, and one whose header is not a session', async () => {
    const dir = path.join(home.root, projectKey(home.cwd))
    await mkdir(path.join(dir, 'broken'), { recursive: true })
    await writeFile(path.join(dir, 'broken', 'session.v4.jsonl.zstd'), 'not zstd at all')
    await mkdir(path.join(dir, 'headless'), { recursive: true })
    await writeFile(path.join(dir, 'headless', 'session.v4.jsonl'), '{"type":"turn/start"}\n')
    await mkdir(path.join(dir, 'mislabelled'), { recursive: true })
    await writeFile(
      path.join(dir, 'mislabelled', 'session.v4.jsonl'),
      fixture('tools.v3').split('__CWD__').join(JSON.stringify(home.cwd).slice(1, -1)),
    )
    await writeFile(path.join(dir, 'stray.txt'), 'not a session')
    await home.place(fixture('titled.v4'))
    expect((await listSessions(home.root, PLATFORM, home.cwd)).map((s) => s.sessionId)).toEqual([
      TITLED,
    ])
  })

  it('reads a log again only once it changed', async () => {
    const file = await home.place(fixture('tools.v4'), { plain: true })
    expect((await listSessions(home.root, PLATFORM, home.cwd))[0]!.title).toBe(
      'Hello there, just say hi',
    )
    const renamed = `${fixture('tools.v4')}{"type":"session/title","seq":73,"time":1795200769000,"data":{"title":"Renamed in dsh","messageSeqs":[],"source":{"kind":"user"}}}\n`
    await writeFile(file, renamed.split('__CWD__').join(JSON.stringify(home.cwd).slice(1, -1)))
    expect((await listSessions(home.root, PLATFORM, home.cwd))[0]!.title).toBe('Renamed in dsh')
  })
})

describe('dsh session history', () => {
  it('finds a session by its id, in its own folder or another one', async () => {
    const moved = await home.place(fixture('tools.v4'), { project: '--somewhere-else--' })
    const log = await findLog(home.root, TOOLS, [home.cwd], PLATFORM)
    expect(log?.file).toBe(moved)
    expect(await findLog(home.root, 'kettu-never-prompted', [home.cwd], PLATFORM)).toBeNull()
  })

  it('reads every event of every frame, without the streams and requests', async () => {
    await home.place(fixture('tools.v4'))
    const history = await readHistory((await findLog(home.root, TOOLS, [home.cwd], PLATFORM))!)
    expect(history!.header).toMatchObject({ id: TOOLS, version: 4, cwd: home.cwd })
    const types = history!.events.map((event) => event.type)
    expect(types.filter((type) => type === 'turn/start')).toHaveLength(5)
    expect(types).not.toContain('system/message')
    expect(types).not.toContain('request/header')
    const message = history!.events.find((event) => event.type === 'assistant/message')!
    expect(message.data).not.toHaveProperty('stream')
    expect(history!.route).toEqual({ provider: 'fake', model: 'fake-model', effort: null })
    // A resume's own marker is no fork's.
    expect(history!.inherited).toBe(0)
  })

  it("lifts format 3's tool results into format 4's", async () => {
    await home.place(fixture('tools.v3'))
    const history = await readHistory((await findLog(home.root, OLDER, [home.cwd], PLATFORM))!)
    const results = history!.events.filter((event) => event.type === 'tool/result')
    expect(results).toHaveLength(5)
    const failed = results.at(-1)!.data as { message: WireMessage }
    expect(failed.message).toMatchObject({ role: 'tool', toolCallId: 'call_17_0', isError: true })
    expect(failed.message.content).toEqual([
      expect.objectContaining({ type: 'text', text: expect.stringContaining('not found') }),
    ])
  })

  it('keeps the rows before a torn end and passes over one that does not parse', async () => {
    const rows = fixture('tools.v4').split('\n')
    const cut = rows.findIndex((row) => row.includes('"type":"tool/call"'))
    const torn = [
      ...rows.slice(0, 20),
      '{"type":"broken',
      ...rows.slice(20, cut + 1),
      rows[cut + 1]!.slice(0, 40),
    ]
    await home.place(torn.join('\n'), { plain: true })
    const history = await readHistory((await findLog(home.root, TOOLS, [home.cwd], PLATFORM))!)
    expect(history!.events.at(-1)!.type).toBe('tool/call')
  })

  it('refuses a format it does not read, which a replay would show wrong', async () => {
    await home.place(fixture('tools.v4').replace('"version":4', '"version":5'), { version: 5 })
    const log = (await findLog(home.root, TOOLS, [home.cwd], PLATFORM))!
    await expect(readHistory(log)).rejects.toBeInstanceOf(DshFormatError)
  })
})
