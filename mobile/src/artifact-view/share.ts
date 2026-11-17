// Sharing an artifact from the phone. A document or a deck is converted on the computer
// (`artifacts.export`), to Word or Markdown, or PowerPoint; a deck's PDF is printed by the desktop
// app, so the phone does not offer it. A page is its HTML file, and anything of several files a
// zip. The file goes to the share sheet on iOS, and to an app that opens it on Android, where React
// Native shares text alone.

import { Platform, Share } from 'react-native'
import { Directory, File, Paths } from 'expo-file-system'
import { zipSync } from 'fflate'
import { artifactPathProblem, VERSION_FILES } from '@shared/artifact-files'
import {
  EXPORT_EXTENSIONS,
  EXPORT_FORMATS,
  EXPORT_TYPES,
  type ArtifactExportFormat,
  type ArtifactTypeName,
} from '@shared/artifact-types'
import type { HostLink } from '@shared/remote/link'
import type { LoadedVersion } from './content'

export const FORMAT_TEXT: Record<ArtifactExportFormat, string> = {
  docx: 'Word 文档（.docx）',
  md: 'Markdown（.md）',
  pptx: 'PowerPoint（.pptx）',
  pdf: 'PDF',
}

/** What the phone can share a typed version as: the type's formats but a deck's PDF. */
export function shareFormats(type: ArtifactTypeName): ArtifactExportFormat[] {
  return EXPORT_FORMATS[type].filter((format) => format !== 'pdf')
}

function fileName(title: string, extension: string): string {
  const base =
    title
      // eslint-disable-next-line no-control-regex
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
      .replace(/[. ]+$/, '') || 'Artifact'
  return `${base}.${extension}`
}

function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  return null
}

async function hand(name: string, type: string, bytes: Uint8Array): Promise<void> {
  const folder = new Directory(Paths.cache, 'huli-share')
  if (folder.exists) folder.delete()
  folder.create({ intermediates: true, idempotent: true })
  const file = new File(folder, name)
  file.create()
  await file.write(bytes)
  if (Platform.OS === 'ios') {
    await Share.share({ url: file.uri })
    return
  }
  await file.preview({ title: name, mimeType: type })
}

/** Shares a typed version in `format`, converted on the computer. */
export async function shareExport(
  link: HostLink,
  version: LoadedVersion,
  format: ArtifactExportFormat,
): Promise<void> {
  const result = (await link.request('artifacts.export', {
    id: version.id,
    version: version.version,
    format,
  })) as { title?: unknown; files?: unknown }
  const title = typeof result?.title === 'string' ? result.title : version.title
  const files = Array.isArray(result?.files) ? (result.files as unknown[]) : []
  const checked: { path: string; bytes: Uint8Array }[] = []
  for (const file of files.slice(0, VERSION_FILES)) {
    const path = (file as { path?: unknown } | null)?.path
    const bytes = bytesOf((file as { bytes?: unknown } | null)?.bytes)
    if (typeof path !== 'string' || artifactPathProblem(path) !== null || !bytes) {
      throw new Error('电脑发来的文件不完整。')
    }
    checked.push({ path, bytes })
  }
  if (checked.length === 0) throw new Error('电脑没有发来文件。')
  if (checked.length === 1) {
    await hand(fileName(title, EXPORT_EXTENSIONS[format]), EXPORT_TYPES[format], checked[0]!.bytes)
    return
  }
  // Markdown with its pictures: a folder, which travels as a zip.
  const zip = zipSync(Object.fromEntries(checked.map((f) => [f.path, f.bytes])))
  await hand(fileName(title, 'zip'), 'application/zip', zip)
}

/** Shares a page as its HTML file, or a version of several files as a zip of them. */
export async function shareFiles(version: LoadedVersion): Promise<void> {
  const files = [...version.files.values()]
  if (files.length === 1 && files[0]!.type.startsWith('text/html')) {
    await hand(fileName(version.title, 'html'), 'text/html', files[0]!.bytes)
    return
  }
  const zip = zipSync(Object.fromEntries(files.map((f) => [f.path, f.bytes])))
  await hand(fileName(version.title, 'zip'), 'application/zip', zip)
}
