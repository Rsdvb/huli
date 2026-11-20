// What Doubao CLI 2.37 prints with `--output-format stream-json` and `--json`, one JSON object per
// line, as its bundled business code (resources/js_app/entry-cli-chat) writes them. Only the
// fields Kettu reads are typed.

export interface InitEvent {
  type: 'system'
  subtype: 'init'
  /** The conversation's id, which `--resume` and `--export` take. */
  session_id: string
}

export interface TextDeltaEvent {
  type: 'stream_event'
  session_id: string
  message_id: string
  event: {
    type: 'content_block_delta'
    index: number
    delta: { type: 'text_delta'; text: string }
  }
}

/** Whether a tool call's input or result is there, or was left out for its size. */
export type ContentStatus = 'available' | 'unavailable' | 'truncated'

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input?: Record<string, unknown>
  input_status?: ContentStatus
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  is_error?: boolean
  content?: { type: string; text?: string }[]
  content_status?: ContentStatus
}

/**
 * A message as a whole: a reply's text, sent again whole when it is completed or replaced, or a
 * tool call, whose id is `<message id>:tool_use:<call id>`.
 */
export interface AssistantEvent {
  type: 'assistant'
  session_id: string
  /** Set for the calls of a thread the main agent started. */
  thread_id?: string
  message: { id: string; role: 'assistant'; content: (TextBlock | ToolUseBlock)[] }
}

/** A tool call's result, as the message `<message id>:tool_result:<call id>`. */
export interface UserEvent {
  type: 'user'
  session_id: string
  thread_id?: string
  message: { id: string; role: 'user'; content: ToolResultBlock[] }
}

/** A confirmation the CLI rejected by itself, since `-p` runs without anyone to answer it. */
export interface PermissionDenial {
  tool_name?: string
  tool_use_id?: string
  prompt?: string
}

export interface ResultEvent {
  type: 'result'
  subtype: 'success' | 'error_during_execution'
  is_error: boolean
  session_id?: string
  result?: Record<string, unknown>
  errors?: string[]
  error?: { code?: string }
  permission_denials?: PermissionDenial[]
  message_id?: string
}

export type StreamEvent = InitEvent | TextDeltaEvent | AssistantEvent | UserEvent | ResultEvent

/** One of `model list --json`'s models. */
export interface ListedModel {
  id: string
  name: string
  is_default?: boolean
  efforts?: string[]
  default_effort?: string
}

/** One of `--list --json`'s sessions; `cwd` only for one the CLI ran in a folder. */
export interface ListedConversation {
  session_id: string
  title?: string | null
  updated_at?: string
  cwd?: string
}

/** One turn of `--export`, which holds the user's words and the reply as text only. */
export interface ExportedTurn {
  query?: string
  response?: string
}
