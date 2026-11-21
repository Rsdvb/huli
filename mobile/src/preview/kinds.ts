// Which of a computer's files the phone hands the system's viewer, Quick Look on iOS or an app that
// opens them on Android, rather than its own text viewer: documents, pictures, audio, video and
// archives, by their extension. Text and code stay in the app's viewer.

import { extensionOf } from '../ui/session/format'

/** Each extension the viewer takes, with the type Android looks for an app by. */
const VIEWED: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  dot: 'application/msword',
  dotx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pps: 'application/vnd.ms-powerpoint',
  ppsx: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  key: 'application/vnd.apple.keynote',
  pages: 'application/vnd.apple.pages',
  numbers: 'application/vnd.apple.numbers',
  rtf: 'application/rtf',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  epub: 'application/epub+zip',
  usdz: 'model/vnd.usdz+zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  zip: 'application/zip',
}

/** Whether tapping the file opens it in the system's viewer instead of the app's text viewer. */
export function opensInViewer(path: string): boolean {
  return Object.hasOwn(VIEWED, extensionOf(path))
}

/** The file's type by its extension, for the app Android picks; any type when it has none known. */
export function mimeTypeOf(path: string): string {
  const ext = extensionOf(path)
  return Object.hasOwn(VIEWED, ext) ? VIEWED[ext]! : 'application/octet-stream'
}
