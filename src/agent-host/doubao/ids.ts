// Doubao names a conversation only once its first turn runs, while Kettu needs a session's id when
// it creates the session. A session Kettu creates gets an id of Kettu's, and the conversation's id
// is kept beside it in a file of Kettu's own, so the session resumes after a restart and a listing
// shows it under Kettu's id, which marks it as imported already.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isConversationId } from './args'

const PREFIX = 'doubao-'
const FILE = 'conversations.json'

/** A new session's id, which no conversation id can be. */
export function newSessionId(): string {
  return `${PREFIX}${randomUUID().replace(/-/g, '')}`
}

export function isKettuId(id: string): boolean {
  return id.startsWith(PREFIX)
}

export class ConversationIds {
  private readonly byId = new Map<string, string>()
  private loaded: Promise<void> | null = null
  private writing: Promise<void> = Promise.resolve()

  /** `folder` holds the file; without one, as in a test, nothing is kept past the process. */
  constructor(private readonly folder: string | null) {}

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.folder) return
      try {
        const kept = JSON.parse(await readFile(path.join(this.folder, FILE), 'utf8')) as unknown
        if (typeof kept !== 'object' || kept === null) return
        for (const [id, conversation] of Object.entries(kept as Record<string, unknown>)) {
          if (isKettuId(id) && typeof conversation === 'string' && isConversationId(conversation))
            this.byId.set(id, conversation)
        }
      } catch {
        // None kept yet, or a file that does not parse, which the next write replaces.
      }
    })()
    return this.loaded
  }

  /** The conversation a session runs: its own id for an imported one; null before its first turn. */
  async conversationOf(sessionId: string): Promise<string | null> {
    if (!isKettuId(sessionId)) return isConversationId(sessionId) ? sessionId : null
    await this.load()
    return this.byId.get(sessionId) ?? null
  }

  /** Kettu's id for a conversation, for one a session of Kettu's started. */
  async sessionOf(conversation: string): Promise<string> {
    await this.load()
    for (const [id, kept] of this.byId) if (kept === conversation) return id
    return conversation
  }

  /** Settles once what was remembered is written. */
  async flushed(): Promise<void> {
    await this.writing.catch(() => {})
  }

  /** Keeps the conversation a session of Kettu's runs; `flushed` waits for it from now on. */
  remember(sessionId: string, conversation: string): Promise<void> {
    if (!isKettuId(sessionId) || !isConversationId(conversation)) return Promise.resolve()
    this.writing = this.writing
      .catch(() => {})
      .then(async () => {
        await this.load()
        if (this.byId.get(sessionId) === conversation) return
        this.byId.set(sessionId, conversation)
        const folder = this.folder
        if (!folder) return
        const text = `${JSON.stringify(Object.fromEntries(this.byId), null, 2)}\n`
        await mkdir(folder, { recursive: true })
        const file = path.join(folder, FILE)
        const temp = `${file}.${process.pid}.tmp`
        await writeFile(temp, text, { mode: 0o600 })
        await rename(temp, file)
      })
    return this.flushed()
  }
}
