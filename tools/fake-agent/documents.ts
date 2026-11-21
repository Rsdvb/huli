// The `documents` scenario: a PDF, a Word document and a large PDF written into the session's
// folder, as an agent's script would make them, and a reply that names them, for checking a
// phone's preview of a computer's files. Both formats are written by hand, small but valid, so the
// fake agent needs no library.

import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { crc32 } from 'node:zlib'
import type { Scenario } from './turn.ts'

/** The files it writes, relative to the session's folder. */
export const DOCUMENTS = {
  pdf: 'report/kite-report.pdf',
  docx: 'report/kite-notes.docx',
  big: 'report/kite-large.pdf',
} as const

/** The large PDF's padding: big enough that a phone's download shows its progress. */
const BIG_BYTES = 24 * 1024 * 1024

/** A string of a PDF content stream, with its delimiters escaped. */
function pdfText(text: string): string {
  return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`
}

/**
 * A one-page PDF: a title band, a few lines of text and a bar chart; `padding` adds an object of
 * that many bytes no page uses, which readers skip.
 */
export function pdfBytes(title: string, lines: string[], padding = 0): Buffer {
  const bars = [0.42, 0.67, 0.55, 0.88, 0.73]
  const content = [
    '0.93 0.48 0.24 rg 48 742 499 56 re f',
    `BT /F1 24 Tf 1 1 1 rg 64 762 Td ${pdfText(title)} Tj ET`,
    `BT /F2 13 Tf 0.12 0.12 0.14 rg 56 700 Td 20 TL ${lines.map((l) => `${pdfText(l)} Tj T*`).join(' ')} ET`,
    ...bars.map((h, i) => `0.18 0.44 0.89 rg ${80 + i * 90} 260 56 ${Math.round(h * 300)} re f`),
    '0.6 0.6 0.65 RG 1 w 64 258 m 531 258 l S',
  ].join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')]
  const offsets: number[] = []
  let at = parts[0]!.length
  const push = (part: Buffer) => {
    parts.push(part)
    at += part.length
  }
  for (const [i, body] of objects.entries()) {
    offsets.push(at)
    push(Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1'))
  }
  if (padding > 0) {
    offsets.push(at)
    push(Buffer.from(`${objects.length + 1} 0 obj\n<< /Length ${padding} >>\nstream\n`, 'latin1'))
    push(randomBytes(padding))
    push(Buffer.from('\nendstream\nendobj\n', 'latin1'))
  }
  const count = offsets.length + 1
  const xref = [
    'xref',
    `0 ${count}`,
    '0000000000 65535 f ',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${count} /Root 1 0 R >>`,
    'startxref',
    String(at),
    '%%EOF',
    '',
  ].join('\n')
  push(Buffer.from(xref, 'latin1'))
  return Buffer.concat(parts)
}

/** A zip of the files as they are, unpacked, which is all a .docx needs. */
function zip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const crc = crc32(file.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(file.data.length, 18)
    local.writeUInt32LE(file.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(file.data.length, 20)
    central.writeUInt32LE(file.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, file.data)
    centrals.push(central, name)
    offset += local.length + name.length + file.data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A Word document of a bold title over plain paragraphs. */
export function docxBytes(title: string, paragraphs: string[]): Buffer {
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  const run = (text: string, props = '') =>
    `<w:p><w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
  const document =
    `${xml}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    run(title, '<w:b/><w:color w:val="E2611F"/><w:sz w:val="44"/>') +
    paragraphs.map((text) => run(text, '<w:sz w:val="24"/>')).join('') +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>' +
    '</w:body></w:document>'
  return zip([
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `${xml}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
          '</Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        `${xml}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
          '</Relationships>',
      ),
    },
    { name: 'word/document.xml', data: Buffer.from(document) },
  ])
}

async function put(cwd: string, relative: string, bytes: Buffer): Promise<string> {
  const path = join(cwd, relative)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  return path
}

export const documents: Scenario = async (turn) => {
  const messageId = turn.messageId()
  const say = (text: string) =>
    turn.send({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } })
  await say('我来生成报告，一份 PDF 和一份 Word 文档。\n\n')
  const toolCallId = `documents-${turn.id}`
  const command = 'python make_report.py --out report'
  await turn.send({
    sessionUpdate: 'tool_call',
    toolCallId,
    title: command,
    kind: 'execute',
    status: 'in_progress',
    rawInput: { command },
  })
  await turn.sleep(300)
  if (turn.signal.aborted) return 'cancelled'
  const { cwd } = turn.session
  const lines = [
    'Revenue grew 18% over the quarter.',
    'Active sessions: 12,480 (up 9%).',
    'Phones paired: 3,215.',
    'Generated by the fake agent for the phone preview check.',
  ]
  const written = await Promise.all([
    put(cwd, DOCUMENTS.pdf, pdfBytes('Kite quarterly report', lines)),
    put(
      cwd,
      DOCUMENTS.docx,
      docxBytes('纸鸢季度备忘', [
        '这份 Word 文档由假 Agent 生成，用来检查手机上的预览。',
        '收入环比增长 18%，活跃会话 12,480 个。',
        'Kite turns a computer’s agent work into something you can hold on your phone.',
      ]),
    ),
    put(
      cwd,
      DOCUMENTS.big,
      pdfBytes('Kite large file', ['A large PDF, for the download progress.'], BIG_BYTES),
    ),
  ])
  await turn.send({
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: 'completed',
    locations: written.map((path) => ({ path })),
    content: [
      {
        type: 'content',
        content: {
          type: 'text',
          text: `Wrote ${DOCUMENTS.pdf}\nWrote ${DOCUMENTS.docx}\nWrote ${DOCUMENTS.big}`,
        },
      },
    ],
  })
  await say(
    `报告做好了：\`${DOCUMENTS.pdf}\`，备忘在 [kite-notes.docx](${DOCUMENTS.docx})，` +
      `另有一份大文件 \`${DOCUMENTS.big}\`。\n`,
  )
  return 'end_turn'
}
