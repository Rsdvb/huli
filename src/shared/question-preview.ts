// Huli: an agent question's option previews, as the cards beside or under the options show them.
// Claude Code asks for markdown and shows it in a monospace box, so a preview that holds no fenced
// block, such as an ASCII mockup whose spaces and line breaks are its layout, is fenced whole.

import type { PendingQuestion } from './thread'

const FENCED = /^ {0,3}(?:`{3,}|~{3,})/m

/** A preview as markdown to render. */
export function previewMarkdown(preview: string): string {
  if (FENCED.test(preview)) return preview
  let fence = '```'
  for (const [run] of preview.matchAll(/`{3,}/g)) {
    while (run.length >= fence.length) fence += '`'
  }
  return `${fence}\n${preview.replace(/\n+$/, '')}\n${fence}`
}

/** Whether a question shows previews: one of its options has one, and its answer is no secret. */
export function hasPreviews(question: PendingQuestion): boolean {
  return !question.secret && question.options.some((option) => !!option.preview)
}

/**
 * The option whose preview shows: the one pointed at or focused, else the last one picked, else
 * the first with a preview. Null when that option has none.
 */
export function shownPreview(
  question: PendingQuestion,
  pointed: number | null,
  picked: readonly number[],
): number | null {
  const at = pointed ?? picked.at(-1) ?? question.options.findIndex((option) => !!option.preview)
  return at >= 0 && question.options[at]?.preview ? at : null
}
