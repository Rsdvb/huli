// Huli: how much of a turn's work the thread shows (简洁视图): everything, the tool calls without
// the ones that went well, or only the user's messages and the agent's final replies, with the
// steps between them folded into one line. Requests and questions always show.

export const TOOL_CALL_VIEWS = ['all', 'hideSuccessful', 'conclusions'] as const
export type ToolCallView = (typeof TOOL_CALL_VIEWS)[number]

export function isToolCallView(value: unknown): value is ToolCallView {
  return (TOOL_CALL_VIEWS as readonly unknown[]).includes(value)
}
