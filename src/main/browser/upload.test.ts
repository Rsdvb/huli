import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES, type UploadAnswer } from '@shared/browser'
import { SurfaceControls } from '@shared/control'

// cdp.ts reaches policy.ts, which takes Electron's app for the downloads folder only.
vi.mock('electron', () => ({ app: {} }))

const { BrowserCdp } = await import('./cdp')
const { RemoteBrowser } = await import('./remote')
const { UploadRefused, uploadFiles, uploadPathProblem } = await import('./upload')

let dir = ''
let report = ''
let notes = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kite-upload-'))
  report = join(dir, 'report.har')
  notes = join(dir, 'notes.txt')
  await writeFile(report, '{"log":{}}')
  await writeFile(notes, 'notes')
  await mkdir(join(dir, 'folder'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('upload paths', () => {
  it.each([
    ['C:\\Users\\me\\report.har', 'win32', null],
    ['c:/Users/me/report.har', 'win32', null],
    ['report.har', 'win32', /absolute/],
    ['..\\report.har', 'win32', /absolute/],
    ['C:report.har', 'win32', /absolute/],
    ['\\Users\\me\\report.har', 'win32', /absolute/],
    ['\\\\server\\share\\report.har', 'win32', /absolute/],
    ['\\\\?\\C:\\report.har', 'win32', /absolute/],
    ['//server/share/report.har', 'win32', /absolute/],
    ['/home/me/report.har', 'linux', null],
    ['home/me/report.har', 'linux', /absolute/],
    ['./report.har', 'darwin', /absolute/],
    ['', 'linux', /not a path/],
    ['/home/me/a\0b', 'linux', /not a path/],
  ] as const)('%j on %s', (path, platform, problem) => {
    const found = uploadPathProblem(path, platform)
    if (problem === null) expect(found).toBeNull()
    else expect(found).toMatch(problem)
  })
})

describe('upload files', () => {
  it('takes existing files by their real path and name', async () => {
    const files = await uploadFiles([report, notes])
    expect(files.map((file) => file.name)).toEqual(['report.har', 'notes.txt'])
    expect(files[0]!.size).toBe(10)
  })

  it('takes a file named twice once', async () => {
    expect(await uploadFiles([report, report])).toHaveLength(1)
  })

  it.each([
    ['nothing', [], /at least one/],
    ['no list', report, /at least one/],
    ['a number', [42], /must be text/],
    ['too many', Array.from({ length: MAX_UPLOAD_FILES + 1 }, () => 'x'), /At most/],
  ])('refuses %s', async (_, paths, message) => {
    await expect(uploadFiles(paths)).rejects.toThrow(message)
  })

  it('refuses a relative path, even to a file that exists', async () => {
    // The tests run in the repository, whose package.json resolves from there.
    await expect(uploadFiles(['package.json'])).rejects.toThrow(/absolute/)
    await expect(uploadFiles([relative(dir, report)])).rejects.toThrow(/absolute/)
  })

  it('refuses a folder', async () => {
    await expect(uploadFiles([join(dir, 'folder')])).rejects.toThrow(/is not a file/)
  })

  it('refuses a file that does not exist', async () => {
    await expect(uploadFiles([join(dir, 'missing.har')])).rejects.toThrow(/does not exist/)
  })

  it('refuses files larger than the limit together', async () => {
    const big = join(dir, 'big.bin')
    await writeFile(big, '')
    await truncate(big, MAX_UPLOAD_BYTES - 5)
    await expect(uploadFiles([big])).resolves.toHaveLength(1)
    await expect(uploadFiles([big, report])).rejects.toThrow(/more than/)
    await rm(big)
  })

  it('refuses with UploadRefused, which the call reports as invalid', async () => {
    await expect(uploadFiles(['nope'])).rejects.toBeInstanceOf(UploadRefused)
  })
})

/** A page over a fake debugger, which records what is sent to it. */
function fakePage(url: string) {
  const listeners: ((event: unknown, method: string, params: unknown) => void)[] = []
  const sent: { method: string; params: Record<string, unknown> }[] = []
  let current = url
  const contents = {
    getURL: () => current,
    getTitle: () => 'Feedback',
    isDestroyed: () => false,
    isCrashed: () => false,
    debugger: {
      isAttached: () => true,
      on: (_name: string, listener: (event: unknown, method: string, params: unknown) => void) => {
        listeners.push(listener)
      },
      sendCommand: async (method: string, params: Record<string, unknown> = {}) => {
        sent.push({ method, params })
        if (method === 'Accessibility.getFullAXTree') return { nodes: [] }
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } }
        return {}
      },
    },
  }
  return {
    contents,
    sent,
    emit: (method: string, params: Record<string, unknown>) => {
      for (const listener of listeners) listener({}, method, params)
    },
    go: (to: string) => {
      current = to
    },
  }
}

function cdpWith(answer: (page: ReturnType<typeof fakePage>) => Promise<UploadAnswer>) {
  const page = fakePage('https://feedbackassistant.apple.com/draft/1')
  const askUpload = vi.fn(() => answer(page))
  const cdp = new BrowserCdp({
    tab: () => 't1',
    tabContents: () => page.contents as never,
    load: () => Promise.reject(new Error('unused')),
    back: () => Promise.reject(new Error('unused')),
    reload: () => Promise.reject(new Error('unused')),
    tabs: () => Promise.reject(new Error('unused')),
    controls: new SurfaceControls({ changed: () => {} }),
    log: () => {},
    uploadFiles: (paths) => uploadFiles(paths),
    askUpload,
  })
  cdp.watch('t1', page.contents as never)
  return { cdp, page, askUpload }
}

const upload = (cdp: InstanceType<typeof BrowserCdp>, args: Record<string, unknown>) =>
  cdp.call('s1', 'browser_upload_file', args, { deadline: Date.now() + 5_000 })

const setFiles = (page: ReturnType<typeof fakePage>) =>
  page.sent.filter((command) => command.method === 'DOM.setFileInputFiles')

describe('browser_upload_file', () => {
  it.each(['deny', 'timeout'] as const)('sets no file when the user answers %s', async (answer) => {
    const { cdp, page, askUpload } = cdpWith(async () => answer)
    page.emit('Page.fileChooserOpened', { backendNodeId: 42, mode: 'selectSingle' })
    await expect(upload(cdp, { paths: [report] })).rejects.toMatchObject({ code: 'not_allowed' })
    expect(askUpload).toHaveBeenCalledOnce()
    expect(setFiles(page)).toEqual([])
  })

  it('asks with the page’s site and the files’ names, then sets them once allowed', async () => {
    const { cdp, page, askUpload } = cdpWith(async () => 'allow')
    page.emit('Page.fileChooserOpened', { backendNodeId: 42, mode: 'selectMultiple' })
    const result = await upload(cdp, { paths: [report, notes] })
    expect(askUpload.mock.calls[0]).toEqual([
      's1',
      {
        site: 'feedbackassistant.apple.com',
        files: [
          { name: 'report.har', size: 10 },
          { name: 'notes.txt', size: 5 },
        ],
      },
      expect.objectContaining({ deadline: expect.any(Number) }),
    ])
    expect(setFiles(page)).toEqual([
      {
        method: 'DOM.setFileInputFiles',
        params: {
          backendNodeId: 42,
          files: [expect.stringMatching(/report\.har$/), expect.any(String)],
        },
      },
    ])
    expect(result.text).toMatch(/Uploaded "report.har", "notes.txt"/)
  })

  it('sets no file when the page moves on while the user is asked', async () => {
    const { cdp, page } = cdpWith(async (asked) => {
      asked.go('https://elsewhere.example/')
      asked.emit('Page.frameNavigated', { frame: { id: 'main' } })
      return 'allow'
    })
    page.emit('Page.fileChooserOpened', { backendNodeId: 42, mode: 'selectSingle' })
    await expect(upload(cdp, { paths: [report] })).rejects.toMatchObject({ code: 'not_allowed' })
    expect(setFiles(page)).toEqual([])
  })

  it('asks nothing when no chooser is open or the files are refused', async () => {
    const { cdp, page, askUpload } = cdpWith(async () => 'allow')
    await expect(upload(cdp, { paths: [report] })).rejects.toThrow(/No file chooser is open/)
    page.emit('Page.fileChooserOpened', { backendNodeId: 42, mode: 'selectSingle' })
    await expect(upload(cdp, { paths: [join(dir, 'folder')] })).rejects.toThrow(/is not a file/)
    await expect(upload(cdp, { paths: [report, notes] })).rejects.toThrow(/takes one file/)
    expect(askUpload).not.toHaveBeenCalled()
    expect(setFiles(page)).toEqual([])
  })
})

describe('browser_upload_file from another host', () => {
  it('is refused before it reaches the page', async () => {
    const run = vi.fn()
    const request = vi.fn<(hostId: string, method: string, params: unknown) => boolean>(() => true)
    const remote = new RemoteBrowser({
      run,
      forward: async () => null,
      closeForwards: () => {},
      answerOrigin: () => {},
      request,
      turnEnded: () => {},
      askAnswered: () => {},
      log: () => {},
    })
    await remote.call('a'.repeat(32), {
      callId: 1,
      sessionId: 's1',
      tool: 'browser_upload_file',
      args: { paths: ['/home/me/.ssh/id_ed25519'] },
      projectPath: '',
    })
    expect(run).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith('a'.repeat(32), 'browser.answer', {
      callId: 1,
      answer: { error: expect.objectContaining({ code: 'unavailable' }) },
    })
  })
})
