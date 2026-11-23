// Huli: reading web pages in the background (后台读网页) with Moli, a headless browser for agents
// (github.com/lexmount/moli, Apache-2.0 OR MIT), run as a separate program Kite downloads on demand
// into its data folder. See tools/huli/README.md (Background web reading).

/** The Moli release Kite pins, whose archives' SHA-256 the agent host checks. */
export const MOLI_VERSION = '1.1.27'

/** A download or removal of Moli, running or failed. */
export interface WebReaderTask {
  kind: 'install' | 'remove'
  state: 'running' | 'failed'
  phase: 'downloading' | 'verifying' | 'extracting' | 'removing'
  /** How much of the archive arrived, 0 to 1, while its size is known. */
  progress: number | null
  error: string | null
}

/** What Settings shows of Moli on this computer. */
export interface WebReaderStatus {
  /** The release pinned for this computer's system and processor; null when there is none. */
  download: { version: string; bytes: number } | null
  /** What is on disk, with the space it takes; null before the download. */
  installed: { version: string; bytes: number } | null
  task: WebReaderTask | null
}

/** How `read_web_page` returns a page. */
export const WEB_READ_FORMATS = ['markdown', 'text', 'semantic'] as const
export type WebReadFormat = (typeof WEB_READ_FORMATS)[number]

/** The characters a read returns unless the call asks for fewer or more, and its bounds. */
export const WEB_READ_CHARS = { default: 40_000, min: 1_000, max: 200_000 } as const

/** How long a read may wait for the page, in seconds. */
export const WEB_READ_SECONDS = { default: 25, min: 3, max: 60 } as const

/** Whole megabytes, rounded up, as the page shows sizes. */
export function megabytes(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / (1024 * 1024)))
}
