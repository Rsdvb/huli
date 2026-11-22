import { describe, expect, it } from 'vitest'
import { suggestFolders, workspaceFolders } from './project-folders'

describe("a project's folder suggestions", () => {
  it('reads a .code-workspace file as VS Code does, comments and trailing commas included', () => {
    const source = `{
      // The services.
      "folders": [
        { "path": "." },
        { "path": "../api", "name": "API // v2" }, /* the backend */
        { "path": "" },
        { "name": "no path" },
        { "path": "../web", },
      ],
      "settings": { "a": "x,]" },
    }`
    expect(workspaceFolders(source)).toEqual([
      { path: '.', name: null },
      { path: '../api', name: 'API // v2' },
      { path: '../web', name: null },
    ])
    expect(() => workspaceFolders('{ folders: [')).toThrow()
    expect(workspaceFolders('{"folders": 3}')).toEqual([])
  })

  it('offers repositories one level down and workspace folders, never the project or one listed', async () => {
    const folders = new Set(['/w/app', '/w/app/api', '/w/app/docs', '/w/web', '/w/lib'])
    const repos = new Set(['/w/app/api', '/w/web', '/w/app/node_modules/x'])
    const found = await suggestFolders('/w/app', ['/w/lib'], {
      platform: 'linux',
      realpath: async (value) => {
        if (!folders.has(value)) throw new Error('missing')
        return value
      },
      isDirectory: async (value) => folders.has(value),
      hasGit: async (value) => repos.has(value),
      readDir: async () => [
        { name: 'api', directory: true, file: false },
        { name: 'docs', directory: true, file: false },
        { name: '.hidden', directory: true, file: false },
        { name: 'node_modules', directory: true, file: false },
        { name: 'app.code-workspace', directory: false, file: true },
      ],
      readText: async () =>
        JSON.stringify({
          folders: [
            { path: '.' },
            { path: 'api' },
            { path: '../web', name: 'Web' },
            { path: '../lib' },
            { path: '../gone' },
          ],
        }),
    })
    expect(found).toEqual([
      { path: '/w/app/api', name: 'api', source: 'repository', repo: true },
      { path: '/w/web', name: 'Web', source: 'workspace', repo: true },
    ])
  })

  it('offers nothing for a folder it cannot read', async () => {
    const found = await suggestFolders('/w/app', [], {
      platform: 'linux',
      readDir: async () => {
        throw new Error('EACCES')
      },
    })
    expect(found).toEqual([])
  })
})
