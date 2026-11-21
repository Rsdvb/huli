import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentId } from '@shared/agents'
import { AgentHistory } from './agent-history'
import {
  claudeDesktopFolders,
  DESKTOP_DATA_VARIABLE,
  DESKTOP_SESSIONS_FOLDER,
  desktopTime,
  isDesktopScratch,
  locateTranscript,
  parseArchivedIndex,
  parseDesktopSession,
  readDesktopIndex,
  type DesktopSession,
} from './claude-desktop'
import { claudeProjectFolder } from './prompt-cache'

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const CLI = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`
const ACCOUNT = '2d22612c-0000-4000-8000-000000000001'
const ORG = '9079e058-0000-4000-8000-000000000002'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kite-claude-desktop-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** An index file as the app writes it, with fields this never reads beside the ones it does. */
function entry(n: number, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: `local_${UUID(n)}`,
    cliSessionId: CLI(n),
    lastAssistantCliSessionId: CLI(n),
    title: `Session ${n}`,
    titleSource: 'auto',
    isArchived: false,
    createdAt: 1794315627728,
    lastActivityAt: 1794390325218,
    model: 'claude-opus-5-5',
    permissionMode: 'default',
    remoteMcpServersConfig: [{ url: 'https://mcp.example', headers: { Authorization: 'x' } }],
    ...fields,
  }
}

async function writeIndex(
  data: string,
  files: Record<string, unknown>,
  account = ACCOUNT,
  org = ORG,
): Promise<string> {
  const folder = path.join(data, DESKTOP_SESSIONS_FOLDER, account, org)
  await mkdir(folder, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(
      path.join(folder, name),
      typeof content === 'string' ? content : JSON.stringify(content),
    )
  }
  return folder
}

async function transcript(projects: string, cwd: string, id: string, mtime?: number) {
  const file = path.join(projects, claudeProjectFolder(cwd), `${id}.jsonl`)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ type: 'user', cwd, sessionId: id })}\n`)
  if (mtime !== undefined) await utimes(file, mtime / 1000, mtime / 1000)
  return file
}

describe('the Claude desktop app’s index', () => {
  it('reads the fields it needs from a session’s file', () => {
    const scratch =
      'C:\\Users\\me\\AppData\\Local\\Claude-Data\\claude_abc\\scratch-workspaces\\a\\o\\scratch-2026-11-10-df326f'
    expect(
      parseDesktopSession(
        entry(1, {
          cwd: scratch,
          originCwd: scratch,
          folderPlace: { cwd: scratch, realPath: scratch },
          lastAssistantCliSessionId: CLI(2).toUpperCase(),
          title: '  竞赛项目\n代码审查  ',
          titleSource: 'user',
          isArchived: true,
        }),
        UUID(1),
      ),
    ).toEqual({
      id: `local_${UUID(1)}`,
      cliSessionId: CLI(1),
      lastAssistantCliSessionId: CLI(2),
      cwd: scratch,
      origins: [],
      title: '竞赛项目 代码审查',
      userTitle: true,
      createdAt: 1794315627728,
      updatedAt: 1794390325218,
      archived: true,
      scratch: true,
    } satisfies DesktopSession)
  })

  it('takes a project folder, and where a moved one started', () => {
    const session = parseDesktopSession(
      entry(2, {
        cwd: '/Users/me/work/app',
        originCwd: '/Users/me/work',
        folderPlace: { cwd: '/Users/me/work/app' },
      }),
      UUID(2),
    )
    expect(session).toMatchObject({ cwd: '/Users/me/work/app', scratch: false })
    expect(session?.origins).toEqual(['/Users/me/work'])
  })

  it('reads times as numbers, strings of digits, seconds and dates', () => {
    expect(desktopTime(1794390325218)).toBe(1794390325218)
    expect(desktopTime('1794390325218')).toBe(1794390325218)
    expect(desktopTime(1794390325)).toBe(1794390325000)
    expect(desktopTime('2026-11-10T08:00:00.000Z')).toBe(Date.parse('2026-11-10T08:00:00.000Z'))
    for (const bad of [null, undefined, '', 'soon', -5, Number.NaN, {}]) {
      expect(desktopTime(bad)).toBeNull()
    }
    const session = parseDesktopSession(
      entry(3, { cwd: '/w', createdAt: '1794315627728', lastActivityAt: undefined }),
      UUID(3),
    )
    expect(session).toMatchObject({ createdAt: 1794315627728, updatedAt: 1794315627728 })
  })

  it('leaves out a file of a shape it does not know', () => {
    expect(parseDesktopSession(null, UUID(1))).toBeNull()
    expect(parseDesktopSession([entry(1, { cwd: '/w' })], UUID(1))).toBeNull()
    expect(parseDesktopSession(entry(1, { cwd: '/w' }), UUID(2))).toBeNull()
    expect(parseDesktopSession(entry(1, { cwd: 'relative/folder' }), UUID(1))).toBeNull()
    expect(parseDesktopSession(entry(1, { cwd: undefined }), UUID(1))).toBeNull()
    // A Claude Code session id that is not one is no session to import.
    expect(
      parseDesktopSession(entry(1, { cwd: '/w', cliSessionId: '../x' }), UUID(1)),
    ).toMatchObject({ cliSessionId: null })
  })

  it('reads the archive list of the version it knows only', () => {
    expect(parseArchivedIndex(JSON.stringify({ v: 1, archived: [`local_${UUID(1)}`] }))).toEqual(
      new Set([`local_${UUID(1)}`]),
    )
    expect(parseArchivedIndex(JSON.stringify({ v: 2, archived: [`local_${UUID(1)}`] }))).toBeNull()
    expect(parseArchivedIndex('{"v":1}')).toBeNull()
    expect(parseArchivedIndex('not json')).toBeNull()
  })

  it('tells the app’s scratch folders from projects', () => {
    expect(
      isDesktopScratch(
        '/Users/me/Library/Application Support/Claude/scratch-workspaces/a/o/scratch-2026-11-10-abc',
      ),
    ).toBe(true)
    expect(isDesktopScratch('C:\\x\\Scratch-Workspaces\\a\\o\\scratch-1\\sub')).toBe(true)
    expect(isDesktopScratch('/x/scratch-workspaces/a/o')).toBe(false)
    expect(isDesktopScratch('/x/scratch-workspaces/a/o/project')).toBe(false)
    expect(isDesktopScratch('/work/scratch-2026-11-10-abc')).toBe(false)
  })

  it('lists every account’s sessions, archived ones marked and deleted ones left out', async () => {
    const data = path.join(dir, 'Claude-Data', 'claude_q7')
    await writeIndex(data, {
      [`local_${UUID(1)}.json`]: entry(1, { cwd: '/w/one' }),
      [`local_${UUID(2)}.json`]: entry(2, { cwd: '/w/two' }),
      [`local_${UUID(3)}.json`]: entry(3, { cwd: '/w/three', isArchived: true }),
      [`local_${UUID(4)}.json`]: entry(4, { cwd: '/w/four' }),
      [`deleted_${UUID(4)}`]: '1794329165522',
      [`deleted_${UUID(9)}`]: '1794329165522',
      [`local_${UUID(5)}.json`]: '{ not json',
      'archived-sessions.idx': { v: 1, archived: [`local_${UUID(2)}`] },
      'scheduled-tasks.json': { scheduledTasks: [] },
    })
    await mkdir(path.join(data, DESKTOP_SESSIONS_FOLDER, ACCOUNT, ORG, 'waiting-input'))
    await writeIndex(data, { [`local_${UUID(6)}.json`]: entry(6, { cwd: '/w/six' }) }, UUID(7))
    // A newer app's archive list is left alone; the files' own mark still counts.
    await writeIndex(
      data,
      {
        [`local_${UUID(8)}.json`]: entry(8, { cwd: '/w/eight' }),
        'archived-sessions.idx': { v: 2, archived: [`local_${UUID(8)}`] },
      },
      ACCOUNT,
      UUID(10),
    )
    const index = await readDesktopIndex([data, path.join(dir, 'none')])
    expect(index.folders).toEqual([data])
    expect(index.unreadable).toBe(1)
    expect(Object.fromEntries(index.sessions.map((s) => [s.cwd, s.archived]))).toEqual({
      '/w/one': false,
      '/w/two': true,
      '/w/three': true,
      '/w/six': false,
      '/w/eight': false,
    })
  })
})

describe('finding a desktop session’s transcript', () => {
  const projects = () => path.join(dir, 'claude', 'projects')
  const session = (fields: Partial<DesktopSession>): DesktopSession => ({
    id: `local_${UUID(1)}`,
    cliSessionId: CLI(1),
    lastAssistantCliSessionId: CLI(1),
    cwd: path.join(dir, 'work'),
    origins: [],
    title: 'One',
    userTitle: false,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    scratch: false,
    ...fields,
  })

  it('takes the transcript in the project folder of the folder it runs in', async () => {
    const cwd = path.join(dir, 'work')
    await transcript(projects(), cwd, CLI(1))
    expect(await locateTranscript(session({ cwd }), projects())).toEqual({
      acpSessionId: CLI(1),
      folder: cwd,
      found: true,
    })
  })

  it('takes the session that wrote the last reply when its transcript is newer', async () => {
    const cwd = path.join(dir, 'work')
    await transcript(projects(), cwd, CLI(1), Date.parse('2026-11-01T00:00:00Z'))
    await transcript(projects(), cwd, CLI(2), Date.parse('2026-11-02T00:00:00Z'))
    const newer = session({ cwd, lastAssistantCliSessionId: CLI(2) })
    expect((await locateTranscript(newer, projects()))?.acpSessionId).toBe(CLI(2))
    await transcript(projects(), cwd, CLI(1), Date.parse('2026-11-03T00:00:00Z'))
    expect((await locateTranscript(newer, projects()))?.acpSessionId).toBe(CLI(1))
  })

  it('marks one whose transcript is gone', async () => {
    const cwd = path.join(dir, 'work')
    await transcript(projects(), path.join(dir, 'elsewhere'), CLI(1))
    expect(await locateTranscript(session({ cwd }), projects())).toEqual({
      acpSessionId: CLI(1),
      folder: cwd,
      found: false,
    })
    expect(
      await locateTranscript(
        session({ cliSessionId: null, lastAssistantCliSessionId: null }),
        projects(),
      ),
    ).toBeNull()
  })

  it('finds a scratch session that went on in the project it started in', async () => {
    const scratch = path.join(dir, 'data', 'scratch-workspaces', 'a', 'o', 'scratch-2026-11-10-abc')
    const project = path.join(dir, 'project')
    await transcript(projects(), project, CLI(1))
    const moved = session({ cwd: scratch, origins: [project], scratch: true })
    expect(await locateTranscript(moved, projects())).toEqual({
      acpSessionId: CLI(1),
      folder: project,
      found: true,
    })
    await transcript(projects(), scratch, CLI(1))
    expect((await locateTranscript(moved, projects()))?.folder).toBe(scratch)
  })
})

describe('finding the Claude desktop app’s data folders', () => {
  async function sessionsIn(folder: string): Promise<string> {
    await mkdir(path.join(folder, DESKTOP_SESSIONS_FOLDER), { recursive: true })
    return folder
  }

  it('finds the Store app’s, the installer’s and an older Store app’s on Windows', async () => {
    const local = path.join(dir, 'Local')
    const roaming = path.join(dir, 'Roaming')
    const store = await sessionsIn(path.join(local, 'Claude-Data', 'claude_k3v9q2xw1m0ab'))
    await mkdir(path.join(local, 'Claude-Data', 'claude_other'), { recursive: true })
    const installer = await sessionsIn(path.join(roaming, 'Claude'))
    const packaged = await sessionsIn(
      path.join(local, 'Packages', 'Claude_k3v9q2xw1m0ab', 'LocalCache', 'Roaming', 'Claude'),
    )
    await sessionsIn(
      path.join(local, 'Packages', 'Other_k3v9q2xw1m0ab', 'LocalCache', 'Roaming', 'Claude'),
    )
    expect(
      await claudeDesktopFolders({
        platform: 'win32',
        env: { LOCALAPPDATA: local, APPDATA: roaming },
        home: dir,
      }),
    ).toEqual([store, installer, packaged])
  })

  it('finds the app’s folder on macOS and Linux', async () => {
    const mac = await sessionsIn(path.join(dir, 'Library', 'Application Support', 'Claude'))
    await mkdir(path.join(dir, 'Library', 'Application Support', 'Claude-3p'), { recursive: true })
    expect(await claudeDesktopFolders({ platform: 'darwin', env: {}, home: dir })).toEqual([mac])
    const linux = await sessionsIn(path.join(dir, 'xdg', 'Claude'))
    expect(
      await claudeDesktopFolders({
        platform: 'linux',
        env: { XDG_CONFIG_HOME: path.join(dir, 'xdg') },
        home: dir,
      }),
    ).toEqual([linux])
    expect(await claudeDesktopFolders({ platform: 'linux', env: {}, home: dir })).toEqual([])
  })

  it('reads only the folders the test variable names', async () => {
    await sessionsIn(path.join(dir, 'Library', 'Application Support', 'Claude'))
    const copy = await sessionsIn(path.join(dir, 'copy'))
    const separator = process.platform === 'win32' ? ';' : ':'
    expect(
      await claudeDesktopFolders({
        platform: process.platform,
        env: {
          [DESKTOP_DATA_VARIABLE]: [copy, 'relative', path.join(dir, 'none')].join(separator),
        },
        home: dir,
      }),
    ).toEqual([copy])
  })
})

describe('listing the Claude desktop app’s sessions for an import', () => {
  const CLAUDE = 'claude-code' as AgentId
  const OTHER = 'claude-code~work' as AgentId
  const T = 1794390325218

  it('lists them as Claude Code sessions to import, deduped against those here', async () => {
    const data = path.join(dir, 'Claude-Data', 'claude_q7')
    const projects = path.join(dir, 'claude', 'projects')
    const project = path.join(dir, 'project')
    const scratch = path.join(data, 'scratch-workspaces', 'a', 'o', 'scratch-2026-11-10-df326f')
    await mkdir(project, { recursive: true })
    await mkdir(scratch, { recursive: true })
    await transcript(projects, project, CLI(1))
    await transcript(projects, scratch, CLI(2))
    await transcript(projects, project, CLI(4))
    await transcript(projects, project, CLI(5))
    await writeIndex(data, {
      [`local_${UUID(1)}.json`]: entry(1, { cwd: project, lastActivityAt: T }),
      [`local_${UUID(2)}.json`]: entry(2, {
        cwd: scratch,
        originCwd: scratch,
        title: '临时',
        titleSource: 'user',
        lastActivityAt: String(T - 1000),
      }),
      [`local_${UUID(3)}.json`]: entry(3, { cwd: project, lastActivityAt: T - 2000 }),
      [`local_${UUID(4)}.json`]: entry(4, {
        cwd: project,
        isArchived: true,
        lastActivityAt: T - 3000,
      }),
      // Here already under the session that wrote its last reply, in an agent sharing its folder.
      [`local_${UUID(5)}.json`]: entry(5, {
        cwd: project,
        cliSessionId: CLI(6),
        lastAssistantCliSessionId: CLI(5),
        lastActivityAt: T - 4000,
      }),
      // An older entry of the same Claude Code session as the first.
      [`local_${UUID(7)}.json`]: entry(7, {
        cwd: project,
        cliSessionId: CLI(1),
        lastActivityAt: T - 10_000,
      }),
      // A newer one of it in a folder without its transcript gives way to the one with it.
      [`local_${UUID(8)}.json`]: entry(8, {
        cwd: path.join(dir, 'elsewhere'),
        cliSessionId: CLI(1),
        lastActivityAt: T + 10_000,
      }),
    })
    const history = new AgentHistory({
      platform: process.platform,
      agents: {
        has: (id) => id === CLAUDE || id === OTHER,
        assertEnabled: () => {},
        name: (id) => id,
        configFolder: (id) => (id === CLAUDE ? path.join(dir, 'claude') : null),
        ids: () => [CLAUDE, OTHER],
        ensureReady: async () => {
          throw new Error('not asked')
        },
      },
      // As Sessions gives them: of the agent, and of the agents that share its folder.
      sessions: {
        agentSessionIds: (id) => new Set(id === CLAUDE ? [CLI(5)] : []),
      },
      desktopFolders: async () => [data],
      log: () => {},
    })
    const page = await history.list(CLAUDE, null, null, 'claude-desktop')
    expect(page.source).toBe(data)
    expect(page.agentId).toBe(CLAUDE)
    expect(page.nextCursor).toBeNull()
    expect(
      page.sessions.map((s) => ({
        id: s.acpSessionId,
        title: s.title,
        cwd: s.cwd,
        imported: s.imported,
        missing: s.missing,
        archived: s.archived ?? false,
        scratch: s.scratch ?? false,
        unavailable: s.unavailable ?? false,
      })),
    ).toEqual([
      {
        id: CLI(1),
        title: 'Session 1',
        cwd: project,
        imported: false,
        missing: false,
        archived: false,
        scratch: false,
        unavailable: false,
      },
      {
        id: CLI(2),
        title: '临时',
        cwd: scratch,
        imported: false,
        missing: false,
        archived: false,
        scratch: true,
        unavailable: false,
      },
      {
        id: CLI(3),
        title: 'Session 3',
        cwd: project,
        imported: false,
        missing: false,
        archived: false,
        scratch: false,
        unavailable: true,
      },
      {
        id: CLI(4),
        title: 'Session 4',
        cwd: project,
        imported: false,
        missing: false,
        archived: true,
        scratch: false,
        unavailable: false,
      },
      {
        id: CLI(5),
        title: 'Session 5',
        cwd: project,
        imported: true,
        missing: false,
        archived: false,
        scratch: false,
        unavailable: false,
      },
    ])
    // Chosen in the Claude Code tab, the app's title, times and archive are not applied.
    expect(history.keptFor(CLAUDE, CLI(4))).toEqual({})
    expect(history.keptFor(CLAUDE, CLI(1), 'claude-desktop')).toEqual({
      title: 'Session 1',
      titleSource: 'agent',
      createdAt: 1794315627728,
      updatedAt: T,
    })
    expect(history.keptFor(CLAUDE, CLI(2), 'claude-desktop')).toEqual({
      customTitle: '临时',
      createdAt: 1794315627728,
      updatedAt: T - 1000,
    })
    expect(history.keptFor(CLAUDE, CLI(4), 'claude-desktop')).toMatchObject({
      archivedAt: T - 3000,
    })
    expect(history.keptFor(CLAUDE, CLI(3), 'claude-desktop')).toEqual({})
  })

  it('imports with the Claude Code agent whose folder holds the app’s transcripts', async () => {
    const data = path.join(dir, 'Claude-Data', 'claude_q7')
    const project = path.join(dir, 'project')
    await mkdir(project, { recursive: true })
    // The app runs Claude Code with the folder its own settings name: the second agent's.
    await transcript(path.join(dir, 'work', 'projects'), project, CLI(1))
    await transcript(path.join(dir, 'work', 'projects'), project, CLI(2))
    await transcript(path.join(dir, 'claude', 'projects'), project, CLI(2))
    await writeIndex(data, {
      [`local_${UUID(1)}.json`]: entry(1, { cwd: project, isArchived: true }),
      [`local_${UUID(2)}.json`]: entry(2, { cwd: project }),
    })
    const disabled = 'claude-code~off' as AgentId
    const history = new AgentHistory({
      platform: process.platform,
      agents: {
        has: () => true,
        assertEnabled: (id) => {
          if (id === disabled) throw new Error('disabled')
        },
        name: (id) => id,
        configFolder: (id) =>
          id === CLAUDE
            ? path.join(dir, 'claude')
            : id === OTHER || id === disabled
              ? path.join(dir, 'work')
              : null,
        ids: () => [disabled, CLAUDE, OTHER],
        ensureReady: async () => {
          throw new Error('not asked')
        },
      },
      sessions: { agentSessionIds: (id) => new Set(id === OTHER ? [CLI(2)] : []) },
      desktopFolders: async () => [data],
      log: () => {},
    })
    const page = await history.list(CLAUDE, null, null, 'claude-desktop')
    expect(page.agentId).toBe(OTHER)
    expect(page.sessions.map((s) => [s.acpSessionId, s.imported, s.unavailable ?? false])).toEqual([
      [CLI(1), false, false],
      [CLI(2), true, false],
    ])
    expect(history.keptFor(OTHER, CLI(1), 'claude-desktop')).toMatchObject({ archivedAt: T })
    expect(history.keptFor(CLAUDE, CLI(1), 'claude-desktop')).toEqual({})
  })

  it('is for a Claude Code agent with a folder only', async () => {
    const history = new AgentHistory({
      platform: process.platform,
      agents: {
        has: () => true,
        assertEnabled: () => {},
        name: (id) => id,
        configFolder: () => null,
        ensureReady: async () => {
          throw new Error('not asked')
        },
      },
      sessions: { agentSessionIds: () => new Set() },
      desktopFolders: async () => [],
      log: () => {},
    })
    await expect(history.list(CLAUDE, null, null, 'claude-desktop')).rejects.toMatchObject({
      code: 'agent_unavailable',
    })
  })
})
