// Huli: who a chat bot listens to. Only the accounts the user bound may drive the agents, and only
// in a one-to-one chat with the bot, where nobody else reads the answers or presses the buttons;
// everyone else gets no answer at all. An account is bound by sending the bot the one-time code
// Settings › 聊天软件 shows, which a few wrong guesses use up. See tools/huli/README.md (Chat apps).

import { timingSafeEqual } from 'node:crypto'
import {
  isBindingCode,
  MAX_CHAT_ACCOUNTS,
  type ChatAccount,
  type ChatBinding,
  type ChatPlatform,
  type ChatPlatformConfig,
} from '@shared/chat-bridge'

/** Wrong codes a binding takes, from anyone, before it takes no more. */
export const MAX_BINDING_MISSES = 5

/** Who wrote, as the platform names them, and where. */
export interface ChatSender {
  platform: ChatPlatform
  /** The platform's id for the user. */
  id: string
  /** A one-to-one chat between the user and the bot. */
  direct: boolean
}

export type Admission =
  /** A bound account: the message is theirs to act on. */
  | { kind: 'account'; account: ChatAccount }
  /** The code of the binding under way, from an account not yet bound. */
  | { kind: 'bind'; code: string }
  /** Nothing is said back. */
  | { kind: 'drop' }

/** The account the platform's id names among the bound ones, or null. */
export function boundAccount(
  config: ChatPlatformConfig | undefined,
  senderId: string,
): ChatAccount | null {
  if (!config || senderId === '') return null
  return config.accounts.find((account) => account.id === senderId) ?? null
}

/** A message's text as a code: its digits, with spaces and dashes between them dropped. */
function asCode(text: string): string | null {
  const bare = text
    .normalize('NFKC')
    .trim()
    .replace(/^\/(?:bind|start)\s*/i, '')
    .replace(/[\s-]/g, '')
  return isBindingCode(bare) ? bare : null
}

function sameCode(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Counts a binding's wrong codes, so guessing it runs out long before it could succeed. */
export class BindingGuard {
  private code: string | null = null
  private misses = 0

  /**
   * Whether `text`, from an account that is not bound, is the binding's code: `match`, `miss` for
   * another code, which counts, or `ignore` for no code, no binding under way or one used up.
   */
  check(
    binding: ChatBinding | null,
    platform: ChatPlatform,
    text: string,
    now: number,
  ): 'match' | 'miss' | 'ignore' {
    if (!binding || binding.platform !== platform || now >= binding.expiresAt) return 'ignore'
    if (binding.code !== this.code) {
      this.code = binding.code
      this.misses = 0
    }
    if (this.misses >= MAX_BINDING_MISSES) return 'ignore'
    const code = asCode(text)
    if (code === null) return 'ignore'
    if (sameCode(code, binding.code)) return 'match'
    this.misses++
    return 'miss'
  }
}

/** What becomes of a message or a button press: its bound account's, a binding, or nothing. */
export function admit(
  config: ChatPlatformConfig | undefined,
  binding: ChatBinding | null,
  guard: BindingGuard,
  sender: ChatSender,
  text: string,
  now: number,
): Admission {
  // Nobody but the user reads a one-to-one chat; a group's members would see every answer.
  if (!config?.enabled || !sender.direct || sender.id === '') return { kind: 'drop' }
  const account = boundAccount(config, sender.id)
  if (account) return { kind: 'account', account }
  if (config.accounts.length >= MAX_CHAT_ACCOUNTS) return { kind: 'drop' }
  const outcome = guard.check(binding, sender.platform, text, now)
  return outcome === 'match' ? { kind: 'bind', code: binding!.code } : { kind: 'drop' }
}
