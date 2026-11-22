// Huli: the daemon's settings for the simulator run: a manager-mode roster of the fake agent, so
// the manager flow (95-manager) has workers to dispatch to. Written only into a fresh data folder.
import { writeFileSync } from 'node:fs'

const worker = (id, name, role, model, persona) => ({
  id,
  name,
  role,
  agentId: 'fake-agent',
  model,
  effort: null,
  profileId: null,
  mode: null,
  worktree: false,
  persona,
})

const settings = {
  version: 1,
  manager: {
    workers: [
      worker('w-00000001', '写手', 'implement', 'balanced', '你写代码干净利落，改动尽量小。'),
      worker('w-00000002', '杂活', 'other', 'swift', '你做简单明确的活。'),
      worker('w-00000003', '规划', 'plan', 'deep', '你负责调研，不改文件。'),
      worker('w-00000004', '审阅', 'review', 'deep', '你是严格但务实的审阅者。'),
    ],
    reviewerId: 'w-00000004',
    suggestion: { agentId: 'fake-agent', model: 'swift', profileId: null },
    autoReview: true,
    approvals: 'user',
    limits: { concurrent: 3, turnsPerTask: 30, reviewRounds: 3, tokenBudget: null },
    afterRestart: 'resume',
  },
}

writeFileSync(process.argv[2], JSON.stringify(settings, null, 2))
