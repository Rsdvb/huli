// An MCP tool's name as a person reads it: `mcp__kettu__read_artifact_type`, as Claude Code names a
// call, or `kettu: read_artifact_type`, as Codex does, reads 「纸鸢 · 读取 Artifact 类型」; another
// server's tool reads as its server and tool humanized, as 「GitHub Tools · Create issue」. The
// names are the desktop's own, in src/shared/tool-names.ts, in Chinese as the app is.

import { toolTitle as sharedToolTitle } from '@shared/tool-names'

/**
 * A call's title as it reads: an MCP tool's server and name made readable, a bare Claude Code tool
 * name in words, any other as it is.
 */
export function toolTitle(title: string): string {
  return sharedToolTitle(title, 'zh-CN')
}
