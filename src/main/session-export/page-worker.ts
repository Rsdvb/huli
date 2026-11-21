// Huli: entry of the export's page worker, a worker_threads thread of main that writes the page a
// PDF prints off main's event loop: the Markdown walked and its formulas drawn by KaTeX, whose
// styles and fonts it inlines. Main builds it with `?modulePath` and starts one for each PDF.

import { parentPort, workerData } from 'node:worker_threads'
import { exportPage } from './html'
import { mathStyle } from './math-style'

export interface PageRequest {
  title: string
  markdown: string
}

export type PageReply = { ok: true; page: string } | { ok: false; error: string }

const { title, markdown } = workerData as PageRequest
let reply: PageReply
try {
  reply = { ok: true, page: exportPage(title, markdown, mathStyle) }
} catch (error) {
  reply = { ok: false, error: error instanceof Error ? error.message : String(error) }
}
parentPort!.postMessage(reply)
