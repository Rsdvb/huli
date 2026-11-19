// Seals a build job's files into one encrypted bundle before upload-artifact, and opens it again in
// the release job: the repository is public, so while a run goes on any signed-in GitHub user can
// download its artifacts, and a sealed one gives them nothing. Node alone, so it runs the same on
// the Linux, Windows and macOS runners.
//
//   node tools/huli/seal-artifacts.mjs seal <bundle> <pattern>...   files matching, by their names
//   node tools/huli/seal-artifacts.mjs open <bundle> <folder>       the files, into the folder
//
// The key is the HULI_ARTIFACT_KEY environment variable (the secret of the same name), never an
// argument and never printed. A bundle is MAGIC, a salt, a nonce, the files encrypted with
// AES-256-GCM under a key HKDF-SHA256 derives from the secret and the salt, and GCM's tag. Inside,
// each file is its name's length (u16), its name (UTF-8), its size (u64) and its bytes, all
// big-endian. Opening writes nothing into the folder unless the whole bundle authenticates.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream, globSync } from 'node:fs'
import { mkdir, mkdtemp, open, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

const MAGIC = Buffer.from('HULISEAL1\n')
const SALT = 16
const NONCE = 12
const TAG = 16
const INFO = Buffer.from('huli-artifact-v1')
const MIN_KEY_LENGTH = 32
const NAME = /^[^/\\\0]{1,255}$/

function fail(message) {
  // `::error::` shows as an annotation on the run's page.
  console.error(`${process.env.GITHUB_ACTIONS ? '::error::' : ''}seal-artifacts: ${message}`)
  process.exit(1)
}

function key(salt) {
  const secret = process.env.HULI_ARTIFACT_KEY ?? ''
  if (!secret.trim()) {
    fail('HULI_ARTIFACT_KEY is not set; add the repository secret (see tools/huli/README.md)')
  }
  if (secret.trim().length < MIN_KEY_LENGTH) {
    fail(`HULI_ARTIFACT_KEY is shorter than ${MIN_KEY_LENGTH} characters; make a random one`)
  }
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret.trim(), 'utf8'), salt, INFO, 32))
}

function validName(name) {
  return NAME.test(name) && name !== '.' && name !== '..'
}

async function* entries(files) {
  for (const file of files) {
    const name = Buffer.from(path.basename(file), 'utf8')
    const { size } = await stat(file)
    const head = Buffer.alloc(2 + name.length + 8)
    head.writeUInt16BE(name.length, 0)
    name.copy(head, 2)
    head.writeBigUInt64BE(BigInt(size), 2 + name.length)
    yield head
    for await (const chunk of createReadStream(file)) yield chunk
  }
}

async function seal(bundle, patterns) {
  if (patterns.length === 0) fail('seal needs at least one file pattern')
  const files = [...new Set(patterns.flatMap((pattern) => globSync(pattern)))].sort()
  if (files.length === 0) fail(`no file matches ${patterns.join(' ')}`)
  const names = new Set()
  for (const file of files) {
    const name = path.basename(file)
    if (!validName(name)) fail(`${file} has a name a bundle cannot hold`)
    if (names.has(name)) fail(`two files are named ${name}`)
    names.add(name)
  }
  const salt = randomBytes(SALT)
  const nonce = randomBytes(NONCE)
  const cipher = createCipheriv('aes-256-gcm', key(salt), nonce)
  await mkdir(path.dirname(bundle), { recursive: true })
  const out = createWriteStream(bundle, { flags: 'wx' })
  out.write(Buffer.concat([MAGIC, salt, nonce]))
  await pipeline(entries(files), cipher, out, { end: false })
  await new Promise((resolve, reject) =>
    out.end(cipher.getAuthTag(), (error) => (error ? reject(error) : resolve())),
  )
  console.log(`Sealed ${files.length} files into ${bundle}: ${[...names].join(', ')}`)
}

/** Reads exactly `length` bytes at `position`, or fails: the bundle ends early. */
async function readExactly(handle, length, position) {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, position)
  if (bytesRead !== length) throw new Error('the bundle ends in the middle of a file')
  return buffer
}

async function openBundle(bundle, folder) {
  const { size } = await stat(bundle)
  const start = MAGIC.length + SALT + NONCE
  if (size < start + TAG) fail(`${bundle} is not a sealed bundle`)
  const sealed = await open(bundle, 'r')
  let head, tag
  try {
    head = await readExactly(sealed, start, 0)
    tag = await readExactly(sealed, TAG, size - TAG)
  } finally {
    await sealed.close()
  }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) fail(`${bundle} is not a sealed bundle`)
  const salt = head.subarray(MAGIC.length, MAGIC.length + SALT)
  const nonce = head.subarray(MAGIC.length + SALT)
  const decipher = createDecipheriv('aes-256-gcm', key(salt), nonce)
  decipher.setAuthTag(tag)

  // Decrypted beside, not into, the folder: GCM authenticates only at the end.
  const work = await mkdtemp(path.join(process.env.RUNNER_TEMP || tmpdir(), 'huli-open-'))
  const plain = path.join(work, 'plain')
  try {
    try {
      await pipeline(
        size - TAG > start
          ? createReadStream(bundle, { start, end: size - TAG - 1 })
          : (async function* () {})(),
        decipher,
        createWriteStream(plain),
      )
    } catch {
      fail(`${bundle} does not open with HULI_ARTIFACT_KEY: a wrong key, or a damaged bundle`)
    }
    await mkdir(folder, { recursive: true })
    const input = await open(plain, 'r')
    const names = []
    try {
      const { size: total } = await input.stat()
      let at = 0
      while (at < total) {
        const length = (await readExactly(input, 2, at)).readUInt16BE(0)
        const name = (await readExactly(input, length, at + 2)).toString('utf8')
        const bytes = Number((await readExactly(input, 8, at + 2 + length)).readBigUInt64BE(0))
        at += 2 + length + 8
        if (!validName(name) || names.includes(name)) throw new Error(`a bad name: ${name}`)
        if (at + bytes > total) throw new Error('the bundle ends in the middle of a file')
        await pipeline(
          bytes > 0 ? createReadStream(plain, { start: at, end: at + bytes - 1 }) : [],
          createWriteStream(path.join(folder, name), { flags: 'wx' }),
        )
        names.push(name)
        at += bytes
      }
    } finally {
      await input.close()
    }
    console.log(`Opened ${bundle} into ${folder}: ${names.join(', ')}`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

const [command, bundle, ...rest] = process.argv.slice(2)
if (command === 'seal' && bundle) {
  await seal(bundle, rest)
} else if (command === 'open' && bundle && rest.length === 1) {
  await openBundle(bundle, rest[0])
} else {
  fail('usage: seal <bundle> <pattern>... | open <bundle> <folder>')
}
