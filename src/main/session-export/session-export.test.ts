import { describe, expect, it } from 'vitest'
import { createRedactor, looksSecret } from '@shared/log/redact'
import {
  EXPORT_ASSET,
  fenced,
  plainText,
  relativePath,
  sessionMarkdown,
  unifiedDiff,
  type ExportOptions,
  type ExportSession,
  type ExportText,
} from '@shared/session-export'
import type { ThreadEntry, ToolEntry } from '@shared/thread'
import { exportPage, markdownHtml } from './html'
import { EXPORT_REDACTED, maskSecrets } from './mask'
import { encodeLinkPath, MAX_IMAGE_BYTES, parseExportRequest, pointAssets } from './request'

const png = new Uint8Array([137, 80, 78, 71])

describe('the request from the page', () => {
  const request = {
    format: 'md',
    title: 'Fix the build',
    markdown: '# Fix the build\n',
    images: [{ name: 'image-001.png', data: png }],
  }

  it('takes a format, a title, the Markdown and named pictures', () => {
    expect(parseExportRequest(request)).toEqual(request)
    for (const format of ['zip', 'pdf']) {
      expect(parseExportRequest({ ...request, format }).format).toBe(format)
    }
  })

  it('refuses another format, a path for a name, and keys it does not know', () => {
    expect(() => parseExportRequest({ ...request, format: 'html' })).toThrow('format')
    expect(() => parseExportRequest({ ...request, path: 'C:/Windows/x.md' })).toThrow('"path"')
    for (const name of ['../image-001.png', 'C:\\x.png', 'image-1.png', 'image-001.exe', 'a.png']) {
      expect(() => parseExportRequest({ ...request, images: [{ name, data: png }] })).toThrow(
        'name of its own',
      )
    }
    expect(() =>
      parseExportRequest({
        ...request,
        images: [
          { name: 'image-001.png', data: png },
          { name: 'image-001.png', data: png },
        ],
      }),
    ).toThrow('name of its own')
    expect(() =>
      parseExportRequest({ ...request, images: [{ name: 'image-001.png', data: 'iVBOR' }] }),
    ).toThrow('bytes')
    expect(() =>
      parseExportRequest({
        ...request,
        images: [{ name: 'image-001.png', data: new Uint8Array(MAX_IMAGE_BYTES + 1) }],
      }),
    ).toThrow('bytes')
    expect(() => parseExportRequest({ ...request, title: 'a\0b' })).toThrow('title')
    expect(() => parseExportRequest({ ...request, markdown: 7 })).toThrow('Markdown')
    expect(() => parseExportRequest(null)).toThrow('object')
  })

  it('points each picture into the folder it lands in, a missing one at its text', () => {
    const markdown = `![Picture](${EXPORT_ASSET}image-001.png)\n![Picture](${EXPORT_ASSET}image-002.png)`
    expect(pointAssets(markdown, ['image-001.png'], 'Fix the build (1).assets')).toBe(
      '![Picture](Fix%20the%20build%20%281%29.assets/image-001.png)\n*(Picture)*',
    )
    expect(pointAssets(markdown, ['image-001.png', 'image-002.png'], '')).toBe(
      '![Picture](image-001.png)\n![Picture](image-002.png)',
    )
    expect(encodeLinkPath('a b%(c)<d>')).toBe('a%20b%25%28c%29%3Cd%3E')
  })
})

describe('masking', () => {
  it('masks keys and tokens in the export as the logs do', () => {
    const redact = createRedactor({ platform: 'linux', home: '/home/ann' })
    const masked = redact(
      [
        'export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
        'Authorization: Bearer abcdefghijklmnop',
        'git clone https://ann:hunter2pass@github.com/x/y',
        'token: ghp_abcdefghijklmnopqrstuvwxyz0123',
        'Read /home/ann/project/src/a.ts',
      ].join('\n'),
    )
    expect(masked).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(masked).not.toContain('hunter2pass')
    expect(masked).not.toContain('ghp_')
    expect(masked).toContain('~/project/src/a.ts')
  })

  it('keeps code that names a token, where the logs mask whatever follows the name', () => {
    const code =
      'export function validate(token: Token): boolean {\n  const token = issueToken(user)'
    const logs = createRedactor({ platform: 'linux' })
    const exported = createRedactor({ platform: 'linux', namedValue: looksSecret })
    expect(logs(code)).toContain('<redacted>')
    expect(exported(code)).toBe(code)
    for (const secret of [
      'password=hunter2hunter2',
      'api_key: abcd1234efgh',
      'SECRET=Zx9fK2pQ8mN4',
    ]) {
      expect(exported(secret)).toContain('<redacted>')
    }
    expect(exported('sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBe('<redacted>')
  })

  it('marks a masked secret so a Markdown viewer shows it, rather than hide it as a tag', () => {
    const masked = maskSecrets('Here is my key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123')
    expect(masked).toBe(`Here is my key ${EXPORT_REDACTED}`)
    expect(markdownHtml(masked)).toContain('‹redacted›')
  })
})

describe('the page a PDF prints', () => {
  it('shows raw HTML as text, so nothing an agent wrote runs or loads', () => {
    const html = markdownHtml(
      [
        '<script>alert(1)</script>',
        '',
        'Text <img src=x onerror=alert(1)> and <b>bold</b><br>',
        '',
        '<iframe src="https://example.com"></iframe>',
      ].join('\n'),
    )
    expect(html).not.toMatch(/<script|<img src=x|<iframe/)
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('<b>bold</b><br>')
  })

  it('links to http(s) only, and shows only the export’s own pictures', () => {
    const html = markdownHtml(
      [
        '[site](https://example.com/a) [bad](javascript:alert(1)) [file](file:///etc/passwd)',
        '',
        '![shot](image-001.png) ![remote](https://example.com/x.png) ![up](../secret.png)',
      ].join('\n'),
    )
    expect(html).toContain('<a href="https://example.com/a">site</a>')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('file:')
    expect(html).toContain('<img src="image-001.png" alt="shot">')
    expect(html).not.toContain('https://example.com/x.png"')
    expect(html).not.toContain('secret.png"')
  })

  it('draws the export’s folds as boxes, their titles as text', () => {
    const html = markdownHtml(
      '<details>\n<summary>Input &amp; output <img src=x></summary>\n\n```\nnpm test\n```\n\n</details>\n',
    )
    expect(html).toContain('<div class="fold"><div class="fold-title">Input &amp; output </div>')
    expect(html).toContain('<pre><code>npm test</code></pre>')
    expect(html).not.toContain('<img')
    expect(html.match(/<div class="fold">/g)).toHaveLength(1)
    expect(html.trim().endsWith('</div>')).toBe(true)
  })

  it('renders headings, lists, tasks, tables, quotes and diffs', () => {
    const html = markdownHtml(
      [
        '# Title',
        '',
        '- **Agent:** Claude Code',
        '- [x] done',
        '',
        '> quoted `code`',
        '',
        '| a | b |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        '```diff',
        '--- a/x',
        '+++ b/x',
        '@@ -1,1 +1,1 @@',
        '-old',
        '+new',
        '```',
      ].join('\n'),
    )
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<strong>Agent:</strong> Claude Code')
    expect(html).toContain('☑')
    expect(html).toContain('<blockquote><p>quoted <code>code</code></p>')
    expect(html).toContain('<th>a</th>')
    expect(html).toContain('<td>2</td>')
    expect(html).toContain('<span class="d-del">-old</span>')
    expect(html).toContain('<span class="d-add">+new</span>')
  })

  it('keeps a code block’s lines as they are, inside a list or a quote too', () => {
    const html = markdownHtml(
      '- x\n\n  ```\n  y\n    z\n  ```\n\n> ```\n> q\n> r\n> ```\n\n    indented\n      more\n',
    )
    expect(html).toContain('<pre><code>y\n  z</code></pre>')
    expect(html).toContain('<blockquote><pre><code>q\nr</code></pre>')
    expect(html).toContain('<pre><code>indented\n  more</code></pre>')
  })

  it('draws maths as KaTeX does, whose source reaches no tag and no link', () => {
    const html = markdownHtml(
      [
        'Energy $$E = mc^2$$ costs $5 and $10.',
        '',
        '> $$',
        '> \\frac{1}{2}',
        '> $$',
        '',
        '$$\\text{<img src=x onerror=alert(1)>} \\href{https://example.com}{x}$$',
        '',
        '$$\\frac{1}{$$',
      ].join('\n'),
    )
    expect(html).toContain('<span class="katex">')
    expect(html).toContain('costs $5 and $10.')
    expect(html).toContain('<blockquote><p><span class="katex-display">')
    expect(html).not.toMatch(/<img|href=|<a /)
    // KaTeX sets the spaces of `\text` as no-break spaces.
    expect(html).toMatch(/&lt;img\ssrc=x\sonerror=alert\(1\)&gt;/)
    expect(html).toContain('<code>\\frac{1}{</code>')
  })

  it('adds KaTeX’s styles only to a page that draws a formula', () => {
    const style = () => '.katex{}'
    expect(exportPage('Plain', '# Hi\n', style)).not.toContain('.katex{}')
    expect(exportPage('Maths', '$$x$$\n', style)).toContain('<style>.katex{}</style>')
  })

  it('makes a whole page that allows no script and no network', () => {
    const page = exportPage('A <b>title</b>', '# Hi\n')
    expect(page).toContain("default-src 'none'")
    expect(page).toContain('<title>A &lt;b&gt;title&lt;/b&gt;</title>')
  })
})

const text: ExportText = {
  t: (key, values) => (values ? `${key} ${JSON.stringify(values)}` : key),
  time: (ms) => new Date(ms).toISOString(),
}

const all: ExportOptions = { thoughts: true, tools: true, subagents: true }
const none: ExportOptions = { thoughts: false, tools: false, subagents: false }

function tool(fields: Partial<ToolEntry>): ToolEntry {
  return {
    kind: 'tool',
    id: 't1',
    title: 'Bash',
    toolKind: 'execute',
    status: 'completed',
    content: [],
    locations: [],
    permission: null,
    permissionResult: null,
    ...fields,
  }
}

function session(entries: ThreadEntry[], sessionId = 's1'): ExportSession {
  return {
    sessionId,
    title: 'Fix the build',
    agent: 'Claude Code',
    model: 'Opus',
    project: '/home/ann/app',
    root: '/home/ann/app',
    createdAt: 0,
    updatedAt: 1000,
    entries,
  }
}

describe('the Markdown of a session', () => {
  const entries: ThreadEntry[] = [
    {
      kind: 'user',
      id: 'u1',
      content: [
        { type: 'text', text: 'Fix the tests' },
        { type: 'ref', ref: { kind: 'image', mimeType: 'image/png', blob: 'a'.repeat(64) } },
      ],
    },
    { kind: 'thought', id: 'th', markdown: 'Let me look', streaming: false },
    tool({
      rawInput: 'npm test',
      content: [{ type: 'markdown', markdown: 'FAIL src/a.test.ts' }],
      status: 'failed',
    }),
    tool({
      id: 't2',
      title: 'Edit src/a.ts',
      toolKind: 'edit',
      content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a\nb\nc\n', newText: 'a\nB\nc\n' }],
    }),
    tool({
      id: 't3',
      title: 'AskUserQuestion',
      question: 'Which one?',
      permissionResult: {
        optionId: 'x',
        kind: 'allow_once',
        questions: [{ question: 'Which one?', answered: true, answer: 'The first' }],
      },
    }),
    tool({
      id: 't4',
      title: 'ExitPlanMode',
      planVersion: 2,
      content: [{ type: 'markdown', markdown: '1. Fix\n2. Test' }],
      permissionResult: { optionId: 'y', kind: 'allow_once' },
    }),
    {
      kind: 'plan',
      id: 'p',
      items: [
        { content: 'Fix', priority: 'high', status: 'completed' },
        { content: 'Test', priority: 'high', status: 'pending' },
      ],
    },
    { kind: 'subagent', id: 'sa', sessionId: 'child' },
    { kind: 'agent', id: 'a1', markdown: 'Done.', attachments: [], streaming: false },
  ]
  const children = new Map([
    [
      'child',
      {
        ...session(
          [{ kind: 'agent', id: 'c1', markdown: 'Child work', attachments: [], streaming: false }],
          'child',
        ),
        title: 'Explore',
      },
    ],
  ])

  it('writes the facts, the messages, the tools with their diffs, and the answers', () => {
    const { markdown, images } = sessionMarkdown({
      session: session(entries),
      children,
      options: all,
      text,
      exportedAt: 2000,
    })
    expect(markdown).toContain('# Fix the build')
    expect(markdown).toContain('- **model:** Opus')
    expect(markdown).toContain('## you')
    expect(markdown).toContain('Fix the tests')
    expect(markdown).toContain(`![image](${EXPORT_ASSET}image-001.png)`)
    expect(images).toEqual([
      {
        name: 'image-001.png',
        mimeType: 'image/png',
        source: { kind: 'blob', sessionId: 's1', hash: 'a'.repeat(64) },
      },
    ])
    expect(markdown).toContain('## Claude Code')
    expect(markdown).toContain('<summary>thinking</summary>')
    expect(markdown).toContain('- **Bash** · *status.failed*')
    expect(markdown).toContain('FAIL src/a.test.ts')
    expect(markdown).toContain(
      '```diff\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n```',
    )
    expect(markdown).toContain('**question:** Which one?')
    expect(markdown).toContain('**answer:** The first')
    expect(markdown).toContain('**plan {"version":2}** · planApproved')
    expect(markdown).toContain('> 1. Fix')
    expect(markdown).toContain('- [x] Fix\n- [ ] Test')
    expect(markdown).toContain('**subagent {"title":"Explore"}**')
    expect(markdown).toContain('### Claude Code')
    expect(markdown).toContain('Child work')
    expect(markdown).toContain('Done.')
  })

  it('leaves out thinking, tool details and sub-agents unless asked', () => {
    const { markdown } = sessionMarkdown({
      session: session(entries),
      children,
      options: none,
      text,
      exportedAt: 2000,
    })
    expect(markdown).not.toContain('Let me look')
    expect(markdown).not.toContain('FAIL src/a.test.ts')
    expect(markdown).not.toContain('Child work')
    // The one-line summary and the diff stay.
    expect(markdown).toContain('- **Bash** · *status.failed*')
    expect(markdown).toContain('```diff')
  })

  it('keeps a fold’s title from closing it, and fences from closing early', () => {
    const { markdown } = sessionMarkdown({
      session: session([
        tool({
          title: '</summary></details><script>x</script>',
          rawInput: 'echo ```',
          content: [],
        }),
      ]),
      options: all,
      text,
      exportedAt: 0,
    })
    expect(markdown).not.toContain('<script>')
    expect(markdown).toContain('&lt;/summary&gt;&lt;/details&gt;&lt;script&gt;')
    expect(markdown).toContain('- **\\</summary\\>\\</details\\>\\<script\\>x\\</script\\>**')
    expect(fenced('a ``` b')).toBe('````\na ``` b\n````')
  })

  it('shows paths inside the folder relative to it, without terminal codes', () => {
    expect(relativePath('/home/ann/app/src/a.ts', '/home/ann/app')).toBe('src/a.ts')
    expect(relativePath('/etc/hosts', '/home/ann/app')).toBe('/etc/hosts')
    expect(relativePath('C:\\Work\\App\\src\\a.ts', 'c:\\work\\app')).toBe('src/a.ts')
    expect(plainText('\u001b[32m✓\u001b[39m ok \u001b]8;;http://x\u0007link')).toBe('✓ ok link')
    const { markdown } = sessionMarkdown({
      session: session([
        tool({
          content: [
            { type: 'diff', path: '/home/ann/app/src/a.ts', oldText: 'a\n', newText: 'b\n' },
            {
              type: 'markdown',
              markdown: `\`\`\`\n${Array.from({ length: 1500 }, (_, i) => `line ${i}`).join('\n')}\n\`\`\``,
            },
          ],
        }),
        {
          kind: 'agent',
          id: 'after',
          markdown: 'After the output',
          attachments: [],
          streaming: false,
        },
      ]),
      options: all,
      text,
      exportedAt: 0,
    })
    expect(markdown).toContain('`src/a.ts` (+1 −1)')
    // The cut output's code block is closed, so what follows reads as text again.
    expect(markdown).toMatch(/line 997\nline 998\n```\n\n\*… linesMore \{"count":502\}\*/)
    expect(markdown).toContain('</details>\n\nAfter the output')
  })

  it('diffs a new file as all added lines', () => {
    expect(unifiedDiff('n.txt', null, 'x\ny\n')).toEqual({
      text: '--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+x\n+y',
      added: 2,
      removed: 0,
    })
  })
})
