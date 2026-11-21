// Huli: Export… in a session's menu, as main does it: the save dialog, the secrets masked as the
// logs mask them, and the files: Markdown with its pictures in a folder beside it, the same in a
// zip, or a PDF printed in a hidden window from a page that runs no script, which a worker writes.

import { randomBytes } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { app, BrowserWindow, dialog, session } from 'electron'
import JSZip from 'jszip'
import { safeName } from '@shared/file-name'
import type { ExportFormat, SessionExportRequest } from '@shared/session-export'
import { t } from '../i18n'
import { createLogger } from '../log'
import { maskSecrets } from './mask'
import type { PageReply, PageRequest } from './page-worker'
import { parseExportRequest, pointAssets } from './request'

const log = createLogger('session-export')

const EXTENSION: Record<ExportFormat, string> = { md: 'md', zip: 'zip', pdf: 'pdf' }
const LOAD_TIMEOUT_MS = 60_000
// An in-memory profile of its own, so the page shares nothing with the app's.
const PRINT_PARTITION = 'kite-session-export'

function withExtension(file: string, extension: string): string {
  return path.extname(file).toLowerCase() === `.${extension}` ? file : `${file}.${extension}`
}

/** `session:export`: asks where, then writes; false when the user cancelled. */
export async function exportSession(window: BrowserWindow | null, raw: unknown): Promise<boolean> {
  const request = parseExportRequest(raw)
  const extension = EXTENSION[request.format]
  const name = safeName(request.title, 'session')
  const options: Electron.SaveDialogOptions = {
    title: t('dialogs.exportSession'),
    defaultPath: path.join(app.getPath('downloads'), `${name}.${extension}`),
    filters: [{ name: t(`dialogs.exportFilter.${request.format}`), extensions: [extension] }],
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  }
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return false
  if (!path.isAbsolute(result.filePath)) throw new Error('The save dialog gave no full path')
  const file = withExtension(result.filePath, extension)
  const masked = { ...request, markdown: maskSecrets(request.markdown) }
  switch (request.format) {
    case 'md':
      await writeMarkdown(file, masked)
      break
    case 'zip':
      await writeZip(file, masked)
      break
    case 'pdf':
      await writePdf(file, masked)
      break
  }
  log.info(`Exported a session as ${request.format}, ${request.images.length} pictures`)
  return true
}

/** The Markdown, and its pictures in `<name>.assets/` beside it. */
async function writeMarkdown(file: string, request: SessionExportRequest): Promise<void> {
  const base = path.basename(file, path.extname(file))
  const folder = `${base}.assets`
  const names = request.images.map((image) => image.name)
  if (request.images.length > 0) {
    const dir = path.join(path.dirname(file), folder)
    await mkdir(dir, { recursive: true })
    for (const image of request.images) await writeFile(path.join(dir, image.name), image.data)
  }
  await writeFile(file, pointAssets(request.markdown, names, folder), 'utf8')
}

/** One zip: the Markdown at its top, its pictures under `assets/`. */
async function writeZip(file: string, request: SessionExportRequest): Promise<void> {
  const base = path.basename(file, path.extname(file))
  const zip = new JSZip()
  const names = request.images.map((image) => image.name)
  zip.file(`${base}.md`, pointAssets(request.markdown, names, 'assets'))
  for (const image of request.images) zip.file(`assets/${image.name}`, image.data)
  await writeFile(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}

/** The page printed by Chromium, the pictures beside it in a folder removed once printed. */
async function writePdf(file: string, request: SessionExportRequest): Promise<void> {
  const dir = path.join(tmpdir(), `kite-export-${randomBytes(6).toString('hex')}`)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  try {
    for (const image of request.images) await writeFile(path.join(dir, image.name), image.data)
    const names = request.images.map((image) => image.name)
    const page = path.join(dir, 'index.html')
    const markdown = pointAssets(request.markdown, names, '')
    await writeFile(page, await renderPage({ title: request.title, markdown }))
    await writeFile(file, await printPage(page))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** The page to print, written by a worker of its own, so main never parses nor draws maths. */
async function renderPage(request: PageRequest): Promise<string> {
  const { default: workerPath } = await import('./page-worker?modulePath')
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: request })
    worker.once('message', (reply: PageReply) => {
      if (reply.ok) resolve(reply.page)
      else reject(new Error(reply.error))
      void worker.terminate()
    })
    // Kept after the answer too: an error event nobody listens to would take main down.
    worker.on('error', reject)
    worker.once('exit', (code) => reject(new Error(`The page worker stopped with code ${code}`)))
  })
}

async function printPage(page: string): Promise<Buffer> {
  const window = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: {
      session: session.fromPartition(PRINT_PARTITION),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      disableDialogs: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  })
  try {
    const contents = window.webContents
    contents.setAudioMuted(true)
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      contents.loadFile(page),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('The page to print did not load')),
          LOAD_TIMEOUT_MS,
        )
      }),
    ]).finally(() => clearTimeout(timer))
    return await contents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate:
        '<div style="width:100%;font-size:7.5pt;color:#6e7781;text-align:center">' +
        '<span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    })
  } finally {
    if (!window.isDestroyed()) window.destroy()
  }
}
