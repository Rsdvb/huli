import type { HarnessId } from '@shared/thread'
import type { SelectOption } from './levels'

/**
 * Huli: the agents whose provider keeps a prompt cache per model, so a model changed mid-session
 * reads the whole conversation again at full price: Anthropic's for Claude Code and OpenAI's for
 * Codex. Others' providers say nothing Kite can go by, so they get no note.
 */
export const CACHE_PER_MODEL: ReadonlySet<HarnessId> = new Set(['claude-code', 'codex'])

/** Whether picking `value` runs another model than the one in use, not the same under an alias. */
export function modelCacheRestarts(model: SelectOption, value: string | boolean): boolean {
  const own = (choice: string) => {
    const found = model.choices.find((c) => c.value === choice)
    return found?.modelId ?? found?.shownAs ?? choice
  }
  return typeof value === 'string' && own(value) !== own(String(model.value))
}
