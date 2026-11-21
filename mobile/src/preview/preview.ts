// A computer's file opened in the system's viewer: its bytes downloaded a part at a time with
// `files.readBytes`, inside the encrypted link whichever way it runs (the network, Tailscale or the
// relay), into the preview cache, then shown by Quick Look on iOS or handed to an app that opens it
// on Android. A copy kept from before opens at once while the computer says the file is unchanged,
// and, said so, while the computer cannot be reached. PreviewSheet shows how a download goes.

import { useSyncExternalStore } from 'react'
import { Platform, Share } from 'react-native'
import { CryptoDigestAlgorithm, digest } from 'expo-crypto'
import { FileMode, type File } from 'expo-file-system'
import { router } from 'expo-router'
import { DownloadError, downloadFile } from '@shared/file-download'
import type { FileBytes, FileStamp } from '@shared/files'
import type { HostLink } from '@shared/remote/link'
import { HuliShare } from '../../modules/huli-system'
import { formatBytes } from '../attachments'
import { call, errorText, sessionFolder } from '../git'
import { getHost } from '../host'
import { showNotice } from '../ui/NoticeBar'
import { baseName } from '../ui/session/format'
import { downloadTarget, dropDownload, keep, kept, keyOf, opened, sweep, type Kept } from './cache'
import { mimeTypeOf } from './kinds'

/** A file of a session's folder, by its path relative to the folder, with `/`. */
export interface PreviewTarget {
  sessionId: string
  path: string
}

/** Shown in the viewer, or handed to the share sheet, where another app can open it. */
export type PreviewAction = 'view' | 'share'

export type PreviewPhase =
  | { kind: 'idle' }
  | { kind: 'downloading'; name: string; written: number; size: number | null }
  | { kind: 'failed'; name: string; text: string; retry: boolean }
  /** Downloaded, but no viewer on the phone shows it; the share sheet may find an app. */
  | { kind: 'unviewable'; name: string; text: string }

interface Job {
  id: number
  target: PreviewTarget
  action: PreviewAction
  controller: AbortController
  /** The copy downloaded or kept, once there is one. */
  copy: Kept | null
}

/** A download quicker than this never shows its sheet. */
const SHEET_AFTER = 350
/** How long the sheet takes to slide away before the viewer can be presented. */
const SHEET_GONE = Platform.OS === 'ios' ? 650 : 250
/** How long a kept copy waits for the computer to say whether the file changed. */
const STAMP_WAIT = 4000
/** Progress redraws at most this often. */
const PROGRESS_MS = 100

let phase: PreviewPhase = { kind: 'idle' }
let sheet = false
let job: Job | null = null
let jobs = 0
let swept = false
const listeners = new Set<() => void>()

interface Shown {
  phase: PreviewPhase
  /** Whether the sheet is up: a download shows it once it takes a while. */
  sheet: boolean
}
let shown: Shown = { phase, sheet }

function emit(): void {
  shown = { phase, sheet }
  for (const listener of listeners) listener()
}

function set(next: PreviewPhase, withSheet = next.kind !== 'idle'): void {
  phase = next
  sheet = withSheet
  emit()
}

/** What the sheet shows, for PreviewSheet. */
export function usePreview(): Shown {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => shown,
  )
}

/** Opens the file in the system's viewer, or with `share` offers it to other apps. */
export function previewFile(target: PreviewTarget, action: PreviewAction = 'view'): void {
  job?.controller.abort()
  const next: Job = { id: ++jobs, target, action, controller: new AbortController(), copy: null }
  job = next
  void run(next)
}

/** Gives up the download under way, or closes what the sheet says. */
export function closePreview(): void {
  job?.controller.abort()
  job = null
  set({ kind: 'idle' })
}

/** Tries the last file again, as the sheet's 重试 does. */
export function retryPreview(): void {
  if (job) previewFile(job.target, job.action)
}

/** Offers the file the viewer could not show to other apps, as the sheet's button does. */
export function shareUnviewable(): void {
  const current = job
  if (!current?.copy) return
  const copy = current.copy
  void hideSheet().then(() => {
    if (live(current)) return share(current, copy)
  })
}

function live(of: Job): boolean {
  return job === of && !of.controller.signal.aborted
}

/** Closes the sheet when it is up and waits until it is gone, so the system can present. */
async function hideSheet(): Promise<void> {
  const up = sheet
  set({ kind: 'idle' })
  if (up) await new Promise((resolve) => setTimeout(resolve, SHEET_GONE))
}

function fail(of: Job, text: string, retry = true): void {
  if (live(of)) set({ kind: 'failed', name: baseName(of.target.path), text, retry })
}

async function run(of: Job): Promise<void> {
  const name = baseName(of.target.path)
  const host = getHost()
  const summary = host.sessions.get(of.target.sessionId)
  if (!summary) return fail(of, '找不到这个会话。', false)
  const folder = sessionFolder(summary)
  const key = await keyOf(host.ready?.host.id ?? '', folder, of.target.path)
  const before = kept(key)
  const link = host.ready?.link ?? null
  const connected = host.state.kind === 'connected'
  if (!swept) {
    swept = true
    sweep(before?.key ?? null)
  }
  // A slow download shows the sheet; a quick one, or a kept copy, opens without it.
  const timer = setTimeout(() => {
    if (!live(of)) return
    if (phase.kind === 'idle') set({ kind: 'downloading', name, written: 0, size: null })
    else if (phase.kind === 'downloading') set(phase, true)
  }, SHEET_AFTER)
  // Once there is a copy to show, the sheet no longer comes up for the download.
  const reveal = (copy: Kept) => {
    clearTimeout(timer)
    return show(of, copy)
  }
  try {
    if (!link || (!connected && before)) {
      if (!before) return fail(of, '电脑没有连上，连上后再试。')
      showNotice({ text: '电脑没有连上，打开的是上次下载的版本。', tone: 'warning' })
      return await reveal(before)
    }
    let stamp: FileBytes | 'late'
    try {
      stamp = await readStamp(link, folder, of, before !== null)
    } catch (error) {
      if (!live(of)) return
      if (before && isUnreachable(error)) stamp = 'late'
      else return fail(of, readFailure(error))
    }
    if (!live(of)) return
    if (stamp === 'late') {
      showNotice({ text: '电脑没有及时回应，打开的是上次下载的版本。', tone: 'warning' })
      return await reveal(before!)
    }
    if (stamp.kind === 'too-large') return fail(of, tooLarge(stamp.size, stamp.limit), false)
    if (before && stamp.kind === 'part' && same(before, stamp)) return await reveal(before)
    const copy = await download(link, folder, of, key)
    if (!copy || !live(of)) return
    sweep(key)
    await reveal(copy)
  } catch (error) {
    if (live(of)) fail(of, readFailure(error))
  } finally {
    clearTimeout(timer)
  }
}

const same = (copy: FileStamp, stamp: FileStamp) =>
  copy.size === stamp.size && copy.mtimeMs === stamp.mtimeMs

/**
 * The file's size and time on the computer, read with no bytes; `late` when a copy is kept and
 * the computer took longer than STAMP_WAIT to say.
 */
async function readStamp(
  link: HostLink,
  folder: string,
  of: Job,
  hasCopy: boolean,
): Promise<FileBytes | 'late'> {
  const asked = new AbortController()
  const giveUp = () => asked.abort()
  of.controller.signal.addEventListener('abort', giveUp, { once: true })
  let late = false
  const timer = hasCopy
    ? setTimeout(() => {
        late = true
        asked.abort()
      }, STAMP_WAIT)
    : null
  try {
    return await call(
      link,
      'files.readBytes',
      { projectPath: folder, path: of.target.path, offset: 0, length: 0 },
      asked.signal,
    )
  } catch (error) {
    if (late) return 'late'
    throw error
  } finally {
    if (timer) clearTimeout(timer)
    of.controller.signal.removeEventListener('abort', giveUp)
  }
}

async function download(
  link: HostLink,
  folder: string,
  of: Job,
  key: string,
): Promise<Kept | null> {
  const name = baseName(of.target.path)
  const target = downloadTarget(key, of.id)
  let handle = target.open(FileMode.WriteOnly)
  let drawn = 0
  try {
    const result = await downloadFile({
      read: (part, signal) =>
        call(
          link,
          'files.readBytes',
          { projectPath: folder, path: of.target.path, ...part },
          signal,
        ),
      sha256: async (bytes) => hex(await digest(CryptoDigestAlgorithm.SHA256, bytes)),
      write: (bytes) => handle.writeBytes(bytes),
      restart: async () => {
        handle.close()
        target.delete()
        target.create()
        handle = target.open(FileMode.WriteOnly)
      },
      progress: (written, size) => {
        const now = Date.now()
        if (written < size && now - drawn < PROGRESS_MS) return
        drawn = now
        if (live(of) && phase.kind !== 'failed') {
          set({ kind: 'downloading', name, written, size }, sheet)
        }
      },
      signal: of.controller.signal,
    })
    handle.close()
    if (result.kind === 'too-large') {
      dropDownload(target)
      fail(of, tooLarge(result.size, result.limit), false)
      return null
    }
    return keep(key, name, result, target)
  } catch (error) {
    try {
      handle.close()
    } catch {
      // Closed already.
    }
    dropDownload(target)
    throw error
  }
}

/** Shows the copy, or shares it, once the sheet is out of the way. */
async function show(of: Job, copy: Kept): Promise<void> {
  of.copy = copy
  opened(copy)
  await hideSheet()
  if (!live(of)) return
  if (of.action === 'share') return share(of, copy)
  const mimeType = mimeTypeOf(copy.name)
  const viewable = await copy.file.canPreview({ mimeType }).catch(() => false)
  if (!live(of)) return
  if (!viewable) return fallBack(of, copy, mimeType)
  try {
    await present(copy.file, copy.name, mimeType)
  } catch {
    if (live(of)) fallBack(of, copy, mimeType)
  }
}

/** Where Quick Look will not show a PDF, a web view of it; anything else, other apps. */
function fallBack(of: Job, copy: Kept, mimeType: string): void {
  if (Platform.OS !== 'ios' || mimeType !== 'application/pdf') return unviewable(of)
  router.push({
    pathname: '/pdf',
    params: { uri: copy.file.uri, name: copy.name, id: of.target.sessionId, path: of.target.path },
  })
}

async function present(file: File, title: string, mimeType: string): Promise<void> {
  try {
    await file.preview({ title, mimeType })
  } catch (error) {
    // iOS refuses to present while another screen is still coming or going; once more, later.
    if (Platform.OS !== 'ios') throw error
    await new Promise((resolve) => setTimeout(resolve, SHEET_GONE))
    await file.preview({ title, mimeType })
  }
}

function unviewable(of: Job): void {
  const text =
    Platform.OS === 'ios'
      ? 'iPhone 不能直接预览这种文件，可以用其他 App 打开。'
      : '手机上没有能打开这种文件的 App，可以分享给其他 App。'
  set({ kind: 'unviewable', name: baseName(of.target.path), text })
}

async function share(of: Job, copy: Kept): Promise<void> {
  try {
    if (Platform.OS === 'ios') {
      await Share.share({ url: copy.file.uri, title: copy.name })
      return
    }
    const mimeType = mimeTypeOf(copy.name)
    if (HuliShare) {
      await HuliShare.share(copy.file.contentUri, mimeType, copy.name)
      return
    }
    // A build without the share module opens it with an app instead.
    await copy.file.preview({ title: copy.name, mimeType })
  } catch {
    if (live(of)) set({ kind: 'failed', name: copy.name, text: '没能交给其他 App。', retry: false })
  }
}

function hex(buffer: ArrayBuffer): string {
  let out = ''
  for (const byte of new Uint8Array(buffer)) out += byte.toString(16).padStart(2, '0')
  return out
}

function tooLarge(size: number, limit: number): string {
  return `这个文件有 ${formatBytes(size)}，超过了手机上能预览的 ${formatBytes(limit)}，请在电脑上查看。`
}

const UNREACHABLE = new Set(['timeout', 'host_offline', 'host_restarted'])

function isUnreachable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && UNREACHABLE.has(code)
}

function readFailure(error: unknown): string {
  if (error instanceof DownloadError) {
    return error.code === 'changed'
      ? '文件在下载时一直在变，等它写完再试。'
      : '下载的内容和电脑上的对不上，请重试。'
  }
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'not_found') return '找不到这个文件，可能已在电脑上移走或删除。'
  if (code === 'invalid_params') return '这个文件不在会话的文件夹里，手机上打不开。'
  if (code === 'unknown_method') return '电脑上的纸鸢还不支持在手机上预览文件，请先更新它。'
  return errorText(error, '没能从电脑下载这个文件。')
}
