// Huli: the secrets of an exported session, masked as this process masks its log.

import { redactExportText } from '@shared/log/process-log'
import { REDACTED } from '@shared/log/redact'

/** What stands for a masked secret in an export. */
export const EXPORT_REDACTED = '‹redacted›'

/**
 * The secrets in the text masked as the logs mask them, code that names a token kept. The logs'
 * mark would read as an HTML tag, which a Markdown viewer hides, so it shows as `‹redacted›`.
 */
export function maskSecrets(markdown: string): string {
  return redactExportText(markdown).split(REDACTED).join(EXPORT_REDACTED)
}
