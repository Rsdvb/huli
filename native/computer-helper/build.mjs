// @ts-check
// Builds kite-computer-helper, what computer use needs from the system beyond Cua Driver, into the
// directory given as the first argument (resources/cua-driver, beside the driver): on Windows with
// the C# compiler of the .NET Framework that Windows ships, on macOS with swiftc. Elsewhere it builds
// nothing. No dependencies. See README.md.
//
// Usage: node native/computer-helper/build.mjs <destination directory>

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import console from 'node:console'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const NAME = 'kite-computer-helper'
const here = dirname(fileURLToPath(import.meta.url))

/** @param {string} dir @param {string} extension */
function sources(dir, extension) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(extension))
    .sort()
    .map((name) => join(dir, name))
}

/**
 * The C# the build writes for the helper: the SHA-256 of the Cua Driver beside it, which the
 * elevated helper checks before it copies or starts the driver, and whether it is a test build,
 * which installs anywhere, starts with no administrator prompt and answers its own questions.
 * @param {string} driver @param {boolean} test
 */
function buildConstants(driver, test) {
  const sha = createHash('sha256').update(readFileSync(driver)).digest('hex')
  return [
    '// Written by native/computer-helper/build.mjs for one build; not in the repository.',
    'namespace Kite.ComputerHelper',
    '{',
    '    static class Build',
    '    {',
    `        public const string DriverSha256 = "${sha}";`,
    `        public const bool Test = ${test ? 'true' : 'false'};`,
    '    }',
    '}',
    '',
  ].join('\n')
}

/** @param {string} destination @param {{ test?: boolean, driver?: string }} options */
function buildWindows(destination, options) {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const framework = join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319')
  const csc = join(framework, 'csc.exe')
  if (!existsSync(csc)) {
    console.error(`${NAME}: the .NET Framework C# compiler is missing (${csc})`)
    return 1
  }
  const metadata = join(root, 'System32', 'WinMetadata')
  const driver = options.driver ?? join(resolve(destination), 'cua-driver.exe')
  if (!existsSync(driver)) {
    console.error(`${NAME}: no cua-driver.exe at ${driver} to build its hash in`)
    return 1
  }
  const references = [
    'System.Web.Extensions.dll',
    'System.Windows.Forms.dll',
    'System.Drawing.dll',
    join(framework, 'System.Runtime.dll'),
    join(framework, 'System.Runtime.InteropServices.WindowsRuntime.dll'),
    join(framework, 'System.Runtime.WindowsRuntime.dll'),
    ...['Foundation', 'Globalization', 'Graphics', 'Media', 'Storage'].map((part) =>
      join(metadata, `Windows.${part}.winmd`),
    ),
  ]
  const work = mkdtempSync(join(tmpdir(), `${NAME}-`))
  try {
    const output = join(work, `${NAME}.exe`)
    const constants = join(work, 'Build.cs')
    writeFileSync(constants, buildConstants(driver, options.test === true))
    const result = spawnSync(
      csc,
      [
        '-nologo',
        '-optimize+',
        '-codepage:65001',
        // A windowed program, so no console window opens for it.
        '-target:winexe',
        '-platform:anycpu',
        // Build.Test is a constant, so one build's branches are unreachable by design.
        '-nowarn:0162,0429',
        `-out:${output}`,
        ...references.map((reference) => `-r:${reference}`),
        ...sources(join(here, 'windows'), '.cs'),
        constants,
      ],
      { stdio: 'inherit' },
    )
    if (result.error) throw result.error
    if (result.status !== 0) {
      console.error(`${NAME}: csc failed`)
      return result.status ?? 1
    }
    const target = join(resolve(destination), `${NAME}.exe`)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(output, target)
    console.log(`${NAME}: built ${target}`)
    return 0
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// Electron 44's own minimum.
const MINIMUM_MACOS = '13.0'
const ARCHITECTURES = { arm64: 'arm64', x64: 'x86_64' }

/** @param {string} destination @param {string} arch */
function buildMac(destination, arch) {
  const swiftArch = ARCHITECTURES[/** @type {keyof typeof ARCHITECTURES} */ (arch)]
  if (!swiftArch) {
    console.error(`${NAME}: no build for the ${arch} architecture`)
    return 1
  }
  const work = mkdtempSync(join(tmpdir(), `${NAME}-`))
  try {
    const output = join(work, NAME)
    const result = spawnSync(
      'xcrun',
      [
        '--sdk',
        'macosx',
        'swiftc',
        '-O',
        '-swift-version',
        '5',
        '-target',
        `${swiftArch}-apple-macos${MINIMUM_MACOS}`,
        '-o',
        output,
        ...sources(join(here, 'macos'), '.swift'),
      ],
      { stdio: 'inherit' },
    )
    if (result.error) throw result.error
    if (result.status !== 0) {
      console.error(`${NAME}: swiftc failed`)
      return result.status ?? 1
    }
    const target = join(resolve(destination), NAME)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(output, target)
    chmodSync(target, 0o755)
    console.log(`${NAME}: built ${target} (${swiftArch})`)
    return 0
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * Builds the helper for `platform` and `arch` into `destination`; 0 when built or when the target
 * has none, else the failing step's code.
 * @param {string} destination @param {string} platform @param {string} arch
 * @param {{ test?: boolean, driver?: string }} [options] a test build, and the driver to hash
 */
export function buildComputerHelper(
  destination,
  platform = process.platform,
  arch = process.arch,
  options = {},
) {
  if (platform === 'win32' && process.platform === 'win32')
    return buildWindows(destination, options)
  if (platform === 'darwin' && process.platform === 'darwin') return buildMac(destination, arch)
  if (platform === 'win32' || platform === 'darwin') {
    console.error(`${NAME}: a ${platform} build is made on ${platform} only`)
    return 1
  }
  console.log(`${NAME}: none for ${platform}`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [destination, ...rest] = process.argv.slice(2)
  const test = rest.includes('--test')
  const at = rest.indexOf('--driver')
  const driver = at >= 0 ? rest[at + 1] : undefined
  if (!destination) {
    console.error(
      'usage: node build.mjs <destination directory> [--test] [--driver <cua-driver.exe>]',
    )
    process.exitCode = 2
  } else {
    process.exitCode = buildComputerHelper(destination, process.platform, process.arch, {
      test,
      ...(driver ? { driver } : {}),
    })
  }
}
