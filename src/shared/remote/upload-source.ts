// A file a request uploads as it is read, in place of its bytes: the link reads it a part at a
// time, so a file of gigabytes never sits in memory, and tells how far it got.

/** Reads a file from its start, a part at a time. */
export interface UploadReader {
  /** The next bytes, at most `length`; none once the file ends. */
  read(length: number): Promise<Uint8Array>
  close(): void
}

export class UploadSource {
  constructor(
    readonly size: number,
    /** Opens a reader at the file's start, each time the upload starts. */
    readonly open: () => UploadReader | Promise<UploadReader>,
    /** Hears the bytes sent so far, from 0 each time the upload starts. */
    readonly progress: ((sent: number) => void) | null = null,
  ) {}

  /** A source over bytes already in memory, for a picture or a text prepared there. */
  static of(bytes: Uint8Array, progress: ((sent: number) => void) | null = null): UploadSource {
    return new UploadSource(
      bytes.length,
      () => {
        let at = 0
        return {
          read: async (length) => {
            const part = bytes.subarray(at, at + length)
            at += part.length
            return part
          },
          close: () => {},
        }
      },
      progress,
    )
  }
}
