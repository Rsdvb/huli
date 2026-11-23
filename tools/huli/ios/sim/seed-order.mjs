// Huli: the daemon's data for the session order flow (87-session-order): a project whose three
// sessions keep the user's own order (shared/session-order.ts), C, A, B, which by latest activity
// would be A, B, C. Written only into a fresh data folder, before the daemon starts.
// usage: node seed-order.mjs <daemon data folder> <project folder>
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [data, project] = process.argv.slice(2)
const state = path.join(data, 'state')
if (existsSync(path.join(state, 'projects.json'))) process.exit(0)
mkdirSync(state, { recursive: true })
mkdirSync(project, { recursive: true })

const now = Date.now()
const session = (id, title, age) => ({
  id,
  agentId: 'fake-agent',
  acpSessionId: `fake-${id}`,
  projectPath: project,
  title,
  customTitle: title,
  createdAt: now - age - 1000,
  updatedAt: now - age,
  lastViewedAt: now - age,
  parentId: null,
  origin: 'user',
  description: null,
  branch: null,
})
const ids = [
  '00000000-0000-4000-8000-00000000000a',
  '00000000-0000-4000-8000-00000000000b',
  '00000000-0000-4000-8000-00000000000c',
]
const sessions = [
  session(ids[0], '排序 A', 60_000),
  session(ids[1], '排序 B', 120_000),
  session(ids[2], '排序 C', 180_000),
]
writeFileSync(
  path.join(state, 'projects.json'),
  JSON.stringify({
    version: 1,
    projects: [
      {
        path: project,
        name: '排序演示',
        addedAt: now - 3_600_000,
        lastOpenedAt: now - 60_000,
        sessionOrder: [ids[2], ids[0], ids[1]],
      },
    ],
  }),
)
writeFileSync(path.join(state, 'sessions.json'), JSON.stringify({ version: 1, sessions }))
