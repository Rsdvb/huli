// A project's files as the Files pane lists, reads and searches them through the agent host.

import type { MediaFile, MediaGrant } from './media'

/** Paths are relative to the project's root, with `/` between segments on every platform. */
export interface FileList {
  paths: string[]
  /** Folders with nothing in them on disk, which no path in `paths` names. */
  folders: string[]
  /** The project holds more files than FILE_LIST_LIMIT; the list stops there. */
  truncated: boolean
}

export type FileContent =
  // `version` is the SHA-256 of the bytes; `editable` is false when they are not valid UTF-8, or
  // the file is one an agent keeps for itself.
  | { kind: 'text'; path: string; size: number; text: string; version: string; editable: boolean }
  // Named as media and its first bytes say which kind: not read, but granted on the media scheme.
  | { kind: 'media'; path: string; grant: MediaGrant }
  | { kind: 'binary'; path: string; size: number }
  // Larger than `limit`, which is FILE_READ_LIMIT; not read.
  | { kind: 'too-large'; path: string; size: number; limit: number }

/**
 * `files.read` as a paired device gets it: a media file is described, not granted, since only
 * main serves the media scheme; the device reads its bytes with `media.read`.
 */
export type DeviceFileContent =
  | Exclude<FileContent, { kind: 'media' }>
  | { kind: 'media'; path: string; media: Omit<MediaFile, 'path'> }

/** A saved file's new version and size in bytes. */
export interface FileWritten {
  version: string
  size: number
}

export interface FileMatch {
  path: string
  line: number // 1-based
  text: string // the line, cut to FILE_MATCH_CHARS
}

export interface FileSearch {
  matches: FileMatch[]
  /** More lines match than FILE_SEARCH_LIMIT. */
  truncated: boolean
}

export const FILE_LIST_LIMIT = 50_000
export const FILE_READ_LIMIT = 1024 * 1024
export const FILE_SEARCH_LIMIT = 500
export const FILE_MATCH_CHARS = 300

/**
 * Huli: the largest file `files.readBytes` reads, as a phone's preview of a document downloads it,
 * a part at a time.
 */
export const FILE_BYTES_LIMIT = 100 * 1024 * 1024
/** Huli: the most bytes one `files.readBytes` returns. */
export const FILE_BYTES_PART = 4 * 1024 * 1024

/** A file as it was when read: its size and when it last changed, in ms since the epoch. */
export interface FileStamp {
  size: number
  mtimeMs: number
}

/**
 * Huli: what `files.readBytes` reads: a project's file by its path relative to the project, checked
 * as `files.read` checks one, or a file of the session's agent's own folder by its absolute path,
 * as `files.readAgentFile` takes it; `length` bytes from `offset`, at most FILE_BYTES_PART. With
 * `expect`, the stamp of the file's first part, a file that has changed since is not read.
 */
export type FileBytesParams = ({ projectPath: string } | { sessionId: string }) & {
  path: string
  offset: number
  length: number
  expect?: FileStamp
}

/**
 * Huli: a `files.readBytes`. `part`: the file's stamp and `bytes` from `offset`, fewer than asked
 * only where the file ends, with their SHA-256 in hex; a length of 0 reads the stamp alone.
 * `changed`: the file no longer has the stamp the request expected, or changed while being read.
 */
export type FileBytes =
  | ({ kind: 'part'; name: string; offset: number; sha256: string; bytes: ArrayBuffer } & FileStamp)
  | ({ kind: 'changed'; name: string } & FileStamp)
  | { kind: 'too-large'; name: string; size: number; limit: number }
