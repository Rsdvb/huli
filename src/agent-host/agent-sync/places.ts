// Huli: where each agent keeps its user-level MCP servers, skills and instructions, by the rules
// its docs give (checked 2026-11), on top of the folders `configLocations` resolves. An agent whose
// docs name no such place has none here, so Agent sync never writes where the agent does not read.

import path from 'node:path'
import type { SyncFormat } from '@shared/agent-sync'
import type { Platform } from '@shared/platform'
import type { HarnessId } from '@shared/thread'
import { configLocations } from '../agent-details'

export interface AgentPlaces {
  /** The agent's own folder, whose existence tells that the agent was used here. */
  folder: string | null
  /** The MCP file's candidates, the first that exists taken, else the first. */
  mcp: { candidates: string[]; format: SyncFormat } | null
  /** The folder a skill copied for this agent goes to, and every folder it reads skills from. */
  skills: { own: string; reads: string[] } | null
  instructions: { candidates: string[]; fallback: string } | null
}

export function agentPlaces(
  harness: HarnessId,
  getEnv: (name: string) => string | undefined,
  home: string,
  platform: Platform,
  chosen: string | null,
): AgentPlaces {
  const p = platform === 'win32' ? path.win32 : path.posix
  const locations = configLocations(harness, getEnv, home, platform, chosen)
  const folder = locations.find((l) => l.id === 'folder')?.candidates[0] ?? null
  const settings = locations.find((l) => l.id === 'settings')?.candidates ?? []
  const found = locations.find((l) => l.id === 'instructions')
  const instructions =
    found && found.candidates.length > 0 && found.candidates.every((c) => /\.md$/i.test(c))
      ? { candidates: found.candidates, fallback: found.fallback ?? found.candidates[0]! }
      : null
  const shared = p.join(home, '.agents', 'skills')
  const claudeSkills = p.join(home, '.claude', 'skills')
  const variable = (name: string): string | null => {
    const value = getEnv(name)
    return value && value.trim() !== '' ? p.resolve(home, value) : null
  }
  const own = (name: string) => (folder ? p.join(folder, name) : null)
  const result = (mcp: AgentPlaces['mcp'], skills: string[] | null): AgentPlaces => ({
    folder,
    mcp,
    skills: skills && skills.length > 0 ? { own: skills[0]!, reads: skills } : null,
    instructions,
  })

  switch (harness) {
    case 'claude-code': {
      // User-scope servers sit at the top of .claude.json, beside the folder unless it moved.
      const dir = chosen ?? variable('CLAUDE_CONFIG_DIR') ?? home
      return result({ candidates: [p.join(dir, '.claude.json')], format: 'claude' }, [
        own('skills')!,
      ])
    }
    case 'codex':
      // Codex documents ~/.agents/skills and still reads its own folder's, now deprecated.
      return result({ candidates: settings, format: 'codex' }, [shared, own('skills')!])
    case 'gemini':
      return result({ candidates: settings, format: 'gemini' }, [own('skills')!, shared])
    case 'qwen':
      return result({ candidates: settings, format: 'qwen' }, [own('skills')!, shared])
    case 'opencode':
      return result({ candidates: settings, format: 'opencode' }, [
        own('skills')!,
        claudeSkills,
        shared,
      ])
    case 'kilo':
      return result(
        {
          candidates: [...settings, ...(folder ? [p.join(folder, 'config.json')] : [])],
          format: 'kilo',
        },
        [p.join(home, '.kilo', 'skills'), shared],
      )
    case 'copilot':
      return result({ candidates: [own('mcp-config.json')!], format: 'copilot' }, [
        own('skills')!,
        shared,
      ])
    case 'cursor':
      return result({ candidates: [own('mcp.json')!], format: 'cursor' }, [
        own('skills')!,
        shared,
        claudeSkills,
        p.join(home, '.codex', 'skills'),
      ])
    case 'droid':
      return result({ candidates: [own('mcp.json')!], format: 'droid' }, [own('skills')!, shared])
    case 'amp':
      return result({ candidates: settings, format: 'amp' }, [
        own('skills')!,
        p.join(home, '.config', 'agents', 'skills'),
        shared,
        claudeSkills,
      ])
    case 'pi':
      return result({ candidates: [own('mcp.json')!], format: 'pi' }, [own('skills')!, shared])
    case 'qoder':
      return result({ candidates: settings, format: 'qoder' }, [own('skills')!])
    case 'codebuddy':
      // Its MCP file is documented only on a page Kite could not confirm as Tencent's own.
      return result(null, [own('skills')!])
    default:
      return result(null, null)
  }
}
