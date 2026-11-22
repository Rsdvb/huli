import { describe, expect, it } from 'vitest'
import { HOST_METHODS } from '../agent-host'
import { forbiddenToDevices } from './allow-list'

describe("Huli: manager mode's requests from a paired device", () => {
  it("keeps a project's roster and the manager switch to the computer's windows", () => {
    for (const method of ['projects.setManager', 'manager.set']) {
      expect(HOST_METHODS).toContain(method)
      expect(forbiddenToDevices(method, {})).toBe(true)
    }
  })

  it('lets a device stop, pause and hand over workers', () => {
    for (const method of [
      'manager.stopAll',
      'manager.pause',
      'manager.detach',
      'manager.moreTurns',
    ]) {
      expect(HOST_METHODS).toContain(method)
      expect(forbiddenToDevices(method, {})).toBe(false)
    }
  })

  it('starts no manager whose agent answers requests from a device', () => {
    const create = { agentId: 'codex', projectPath: '/repo' }
    expect(forbiddenToDevices('sessions.create', create)).toBe(false)
    expect(
      forbiddenToDevices('sessions.create', {
        ...create,
        manager: { autoReview: true, approvals: 'user' },
      }),
    ).toBe(false)
    for (const approvals of ['low', 'anything', undefined]) {
      expect(
        forbiddenToDevices('sessions.create', {
          ...create,
          manager: { autoReview: true, approvals },
        }),
      ).toBe(true)
    }
  })
})
