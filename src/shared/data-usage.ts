// What a host's data folder holds, as the Storage row of Settings shows it and clears it.

/** Bytes on disk by what keeps them. */
export interface StorageUsage {
  /** The thread database with its WAL and the search index beside it. */
  threads: number
  /** The images, sounds and clips the threads keep as files of their own. */
  media: number
  /** The files attached to messages. */
  attachments: number
  /** The artifacts' files and thumbnails. */
  artifacts: number
  /** The app's and the hosts' logs and reports. */
  logs: number
  /** The usage database. */
  usage: number
}

/** Whose pictures a clear takes: the archived sessions', or those of sessions idle for long. */
export type ImageClearScope = 'archived' | 'older'

/** The days a clear of the sessions idle for long may name. */
export const IMAGE_CLEAR_DAYS = [7, 30, 90] as const

/** What a clear of pictures takes, or would: from how many sessions, how many, and the bytes. */
export interface ImageClear {
  sessions: number
  images: number
  bytes: number
}
