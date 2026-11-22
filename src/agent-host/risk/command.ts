// The risk of a shell command: each step by the program it runs and the paths it names. Read-only
// programs and the project's own checks, run in the project, are low; changes in the project,
// installs and the network medium; whatever command-safety calls unsafe, writes elsewhere, keys,
// the system's files, programs this does not know and lines it cannot read high.

import type { Platform } from '@shared/platform'
import { commandName, stepCommand, unsafeWords } from '../command-safety'
import { absolutePath, placeOf, type PlaceContext } from './places'
import { shellSteps, type ShellKind, type Step, type Word } from './shell-words'
import {
  high,
  low,
  medium,
  readVerdict,
  worst,
  writeVerdict,
  type RiskReason,
  type Verdict,
} from './verdict'

export interface CommandContext {
  platform: Platform
  /** The folder the command starts in. */
  cwd: string
  roots: readonly string[]
}

/** A command longer than this is not read: high. */
const MAX_CHARS = 20_000
/** How deep a shell's script inside another's is read, as in `bash -lc '...'`. */
const MAX_DEPTH = 3

/**
 * The verdict for `command` run in each of `shells`, the highest of them: where the shell is not
 * known, the command is read as each one it may be would read it.
 */
export function commandVerdict(
  command: string,
  shells: readonly ShellKind[],
  ctx: CommandContext,
): Verdict {
  if (command.trim() === '' || command.length > MAX_CHARS || shells.length === 0) {
    return high('unparsed')
  }
  let out: Verdict | null = null
  for (const shell of shells) {
    const one = lineVerdict(command, { ...ctx, shell }, 0)
    out = out ? worst(out, one) : one
  }
  return out!
}

interface Here extends PlaceContext {
  depth: number
}

function lineVerdict(command: string, ctx: PlaceContext, depth: number): Verdict {
  const steps = shellSteps(command, ctx.shell)
  if (!steps) return high('unparsed')
  let here: Here = { ...ctx, depth }
  let out: Verdict | null = null
  for (const step of steps) {
    const result = stepVerdict(step, here)
    here = { ...here, cwd: result.cwd }
    out = out ? worst(out, result.verdict) : result.verdict
  }
  return out!
}

function stepVerdict(step: Step, here: Here): { verdict: Verdict; cwd: string | null } {
  const texts = step.words.map((word) => word.text)
  const redirected = (verdict: Verdict): Verdict => {
    let out = verdict
    for (const redirect of step.redirects) {
      const place = placeOf(redirect.target, here)
      out = worst(
        out,
        redirect.op === '<'
          ? readVerdict(place, redirect.target)
          : writeVerdict(place, redirect.target),
      )
    }
    return out
  }
  const script = here.depth < MAX_DEPTH ? shellScript(texts) : null
  if (script) {
    const inner = lineVerdict(script.script, { ...here, shell: script.shell }, here.depth + 1)
    return { verdict: redirected(inner), cwd: here.cwd }
  }
  if (unsafeWords(texts)) return { verdict: unsafeVerdict(texts), cwd: here.cwd }
  const run = stepCommand(texts)
  if (!run) return { verdict: high('unparsed'), cwd: here.cwd }
  const words = step.words.slice(texts.length - run.words.length)
  const cd = changeDirectory(words, here)
  if (cd) return { verdict: redirected(low('readCommand')), cwd: cd.cwd }
  let verdict = programVerdict(words, here)
  // xargs adds words from its input, which no text shows.
  if (run.input) verdict = worst(verdict, medium('unclearScope'))
  return { verdict: redirected(verdict), cwd: here.cwd }
}

const DELETERS = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'srm',
  'del',
  'erase',
  'rd',
  'remove-item',
  'ri',
  'rimraf',
  'trash',
  'clear-content',
  'clc',
  'truncate',
  'wipefs',
])

const GIT_DANGER = new Set([
  'push',
  'reset',
  'rebase',
  'clean',
  'restore',
  'checkout',
  'switch',
  'filter-branch',
  'filter-repo',
  'reflog',
  'update-ref',
  'gc',
  'prune',
  'branch',
  'tag',
  'stash',
  'worktree',
  'rm',
  'replace',
  'merge',
  'pull',
  'cherry-pick',
  'revert',
  'am',
  'apply',
])

/** The reason an unsafe step is high: it deletes, it changes Git's history, or it is unsafe. */
function unsafeVerdict(texts: readonly string[]): Verdict {
  const run = stepCommand(texts)
  const head = run ? commandName(run.words[0]!) : ''
  if (DELETERS.has(head)) return high('delete')
  if (head === 'git' && run) {
    const sub = run.words.slice(1).find((word) => !word.startsWith('-'))
    if (sub !== undefined && GIT_DANGER.has(sub)) return high('gitDanger', `git ${sub}`)
  }
  return high('unsafe')
}

const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash'])

/**
 * The script a shell is started with, as `bash -lc 'git status'`, `powershell -Command ...` or
 * `cmd /c ...`, to read in that shell; null for any other step.
 */
function shellScript(words: readonly string[]): { shell: ShellKind; script: string } | null {
  const name = commandName(words[0] ?? '')
  const rest = words.slice(1)
  if (POSIX_SHELLS.has(name)) {
    let i = 0
    while (['-l', '--login', '--noprofile', '--norc'].includes(rest[i] ?? '')) i++
    if (!/^-(?:c|lc|cl)$/.test(rest[i] ?? '')) return null
    // Words after the script become its $0 and arguments, which this does not follow.
    if (rest.length !== i + 2) return null
    return { shell: 'posix', script: rest[i + 1]! }
  }
  if (name === 'powershell' || name === 'pwsh') {
    let i = 0
    for (;;) {
      const word = rest[i]?.toLowerCase()
      if (word === '-noprofile' || word === '-nologo' || word === '-noninteractive') i++
      else if (word === '-nop') i++
      else if (word === '-executionpolicy' || word === '-ep') i += 2
      else break
    }
    const flag = rest[i]?.toLowerCase()
    if (flag !== '-command' && flag !== '-c') return null
    const script = rest.slice(i + 1)
    return script.length > 0 ? { shell: 'powershell', script: script.join(' ') } : null
  }
  if (name === 'cmd') {
    let i = 0
    while (/^\/[dqs]$/i.test(rest[i] ?? '')) i++
    if (!/^\/c$/i.test(rest[i] ?? '')) return null
    const script = rest.slice(i + 1)
    return script.length > 0 ? { shell: 'cmd', script: script.join(' ') } : null
  }
  return null
}

const CHANGE_DIRECTORY = new Set(['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location'])

/** Where a step that changes the folder moves to; null for a folder this does not know. */
function changeDirectory(words: readonly Word[], here: Here): { cwd: string | null } | null {
  if (!CHANGE_DIRECTORY.has(commandName(words[0]!.text))) return null
  const args = words.slice(1).filter((word) => {
    if (word.text === '--') return false
    if (here.shell === 'cmd' && /^\/d$/i.test(word.text)) return false
    if (here.shell === 'powershell' && /^-(?:path|literalpath)$/i.test(word.text)) return false
    return true
  })
  if (args.length !== 1 || args[0]!.glob || args[0]!.text === '-') return { cwd: null }
  return { cwd: absolutePath(args[0]!.text, here) }
}

// ---- Paths in a step's words

/**
 * What in a word may name a path: the word, the value after its `=` or a `rev:` prefix, and in an
 * option, its value however attached, as `--file=x`, `-Path:x` or `-I../x`.
 */
export function pathCandidates(text: string, shell: ShellKind): string[] {
  if (text === '' || text === '-' || text === '--') return []
  // cmd.exe's switches, such as /s or /a:h.
  if (shell === 'cmd' && /^\/[A-Za-z?][\w:+-]*$/.test(text)) return []
  const out: string[] = []
  if (text.startsWith('-')) {
    const eq = text.indexOf('=')
    if (eq !== -1) out.push(text.slice(eq + 1))
    if (shell === 'powershell') {
      const colon = text.indexOf(':')
      if (colon !== -1) out.push(text.slice(colon + 1))
    }
    // A single-letter option's attached value, as -f/etc/passwd or -I../include.
    const short = /^-[A-Za-z](.+)$/.exec(text)
    if (short) out.push(short[1]!)
    const drive = text.search(/[A-Za-z]:[\\/]/)
    if (drive > 0) out.push(text.slice(drive))
  } else {
    out.push(text)
    const eq = text.indexOf('=')
    if (eq > 0) out.push(text.slice(eq + 1))
    // A Git revision's path, as `HEAD:.env`; a drive letter's colon is no such prefix.
    const colon = text.indexOf(':')
    if (colon > 1) out.push(text.slice(colon + 1))
  }
  return out.filter((one) => one !== '')
}

/**
 * Reading each path the words name. `contents` for a program that prints what files hold, for
 * which a wildcard that may match hidden files, such as `.env`, is medium; `names` for one that
 * only lists them or prints their counts.
 */
function readArgs(
  words: readonly Word[],
  here: Here,
  mode: 'contents' | 'names',
  base: Verdict,
): Verdict {
  let out = base
  for (const word of words) {
    for (const candidate of pathCandidates(word.text, here.shell)) {
      out = worst(out, readVerdict(placeOf(candidate, here), candidate))
    }
    if (mode === 'contents' && word.glob && !word.text.startsWith('-')) {
      out = worst(out, medium('globRead', word.text))
    }
  }
  return out
}

/** Writing each path the words name; a wildcard's files are not known, so it counts as elsewhere. */
function writeArgs(words: readonly Word[], here: Here, base: Verdict): Verdict {
  let out = base
  for (const word of words) {
    for (const candidate of pathCandidates(word.text, here.shell)) {
      out = worst(out, writeVerdict(placeOf(candidate, here), candidate))
    }
  }
  return out
}

function cwdInside(here: Here): boolean {
  if (here.cwd === null) return false
  const place = placeOf(here.cwd, here)
  return place === 'project'
}

/** The project's tests, checks or build: low in the project, medium elsewhere. */
function check(here: Here, args: readonly Word[]): Verdict {
  const base = cwdInside(here) ? low('projectCheck') : medium('outsideProject')
  return readArgs(args, here, 'names', base)
}

/** A change of the project by a tool, such as a formatter that writes: medium in the project. */
function edit(here: Here, args: readonly Word[]): Verdict {
  const base = cwdInside(here) ? medium('editProject') : high('outsideProject')
  return readArgs(args, here, 'names', base)
}

/** A program or script of the project, which may do anything the project's code does. */
function projectRun(here: Here, args: readonly Word[], reason: RiskReason = 'projectScript') {
  const base = cwdInside(here) ? medium(reason) : high('outsideProject')
  return readArgs(args, here, 'names', base)
}

const INSTALL_TARGETS = new Set([
  '--prefix',
  '--target',
  '-t',
  '--root',
  '--modules-folder',
  '--global-dir',
  '--install-dir',
  '--dest',
])

/** Packages installed into the project: medium; for the whole computer, or elsewhere, high. */
function install(here: Here, args: readonly Word[]): Verdict {
  const texts = args.map((word) => word.text)
  if (
    texts.some((text) =>
      /^(?:-g|--global|--location=global|--user|--system|--break-system-packages)$/.test(text),
    ) ||
    texts.some((text, i) => text === '--location' && texts[i + 1] === 'global')
  ) {
    return high('globalInstall')
  }
  let out = cwdInside(here) ? medium('install') : high('outsideProject')
  args.forEach((word, i) => {
    const eq = word.text.indexOf('=')
    const name = eq === -1 ? word.text : word.text.slice(0, eq)
    if (!INSTALL_TARGETS.has(name)) return
    const value = eq === -1 ? args[i + 1]?.text : word.text.slice(eq + 1)
    if (value !== undefined) out = worst(out, writeVerdict(placeOf(value, here), value))
  })
  return readArgs(args, here, 'names', out)
}

/** A script file run by an interpreter: one of the project's is medium, any other high. */
function scriptFile(target: Word | undefined, args: readonly Word[], here: Here): Verdict {
  if (!target || target.glob || target.text.startsWith('-')) return high('unparsed')
  const place = placeOf(target.text, here)
  if (place !== 'project') {
    return place === 'secret' || place === 'system'
      ? readVerdict(place, target.text)
      : high('unknownCommand', target.text)
  }
  return projectRun(here, args)
}

// ---- Programs

/** Programs that print what files hold. */
const CONTENT_READERS = new Set([
  'cat',
  'head',
  'tail',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'diff',
  'cmp',
  'cut',
  'nl',
  'od',
  'strings',
  'base64',
  'md5sum',
  'sha1sum',
  'sha224sum',
  'sha256sum',
  'sha384sum',
  'sha512sum',
  'shasum',
  'b2sum',
  'cksum',
  'column',
  'comm',
  'paste',
  'fold',
  'expand',
  'unexpand',
  'rev',
  'tac',
  'type',
  'findstr',
  'fc',
  'more',
  'get-content',
  'gc',
  'select-string',
  'sls',
  'get-filehash',
  'compare-object',
  'compare',
  'format-hex',
  'fhx',
])

/** Programs that list files, or print their names, sizes or counts, and not what they hold. */
const NAME_READERS = new Set([
  'ls',
  'dir',
  'vdir',
  'find',
  'stat',
  'file',
  'du',
  'df',
  'wc',
  'pwd',
  'realpath',
  'readlink',
  'basename',
  'dirname',
  'which',
  'where',
  'whereis',
  'test',
  'get-childitem',
  'gci',
  'get-item',
  'gi',
  'get-itemproperty',
  'gp',
  'resolve-path',
  'rvpa',
  'get-location',
  'gl',
  'test-path',
  'split-path',
  'join-path',
  'get-command',
  'gcm',
])

/** Programs that only print or shape their input and words, reading no file. */
const OUTPUT_ONLY = new Set([
  'echo',
  'printf',
  'write-output',
  'write-host',
  'true',
  'false',
  'exit',
  'get-date',
  'uname',
  'whoami',
  'id',
  'groups',
  'nproc',
  'sleep',
  'start-sleep',
  'clear',
  'cls',
  'ver',
  'seq',
  'out-null',
  'out-host',
  'oh',
  'out-string',
  'select-object',
  'select',
  'sort-object',
  'measure-object',
  'measure',
  'format-table',
  'ft',
  'format-list',
  'fl',
  'format-wide',
  'fw',
  'group-object',
  'group',
  'get-unique',
  'gu',
  'where-object',
  'convertto-json',
  'convertfrom-json',
  'convertto-csv',
  'convertfrom-csv',
  'get-host',
  'get-culture',
  'get-uptime',
  'uptime',
])

/** Programs that show the computer's processes or network, beyond the project. */
const SYSTEM_READERS = new Set([
  'ps',
  'get-process',
  'gps',
  'netstat',
  'lsof',
  'free',
  'ifconfig',
  'ipconfig',
  'systeminfo',
  'tasklist',
])

const NETWORK = new Set([
  'ping',
  'nslookup',
  'dig',
  'host',
  'traceroute',
  'tracert',
  'whois',
  'resolve-dnsname',
  'test-netconnection',
])

/** Programs that write the paths they name. */
const WRITERS = new Set([
  'cp',
  'mv',
  'mkdir',
  'md',
  'touch',
  'tee',
  'install',
  'copy',
  'move',
  'ren',
  'rename',
  'xcopy',
  'copy-item',
  'cpi',
  'move-item',
  'mi',
  'rename-item',
  'rni',
  'new-item',
  'ni',
  'set-content',
  'add-content',
  'ac',
  'out-file',
  'tee-object',
  'expand-archive',
  'compress-archive',
  'unzip',
  'zip',
  'patch',
  'dos2unix',
  'unix2dos',
])

const VERSION_ARGS = new Set(['--version', '-v', '-V', 'version', '-version', '--help', '-h'])

const CHECK_SCRIPT =
  /^(?:test|tests|spec|specs|lint|typecheck|type-check|types|tsc|check|checks|verify|validate|build|compile|e2e|format:check|fmt:check|prettier:check)(?:[:._-][\w:.-]*)?$/i
const PUBLISH_SCRIPT = /^(?:publish|release|deploy|ship|upload|push)(?:[:._-][\w:.-]*)?$/i

/** A script of the project's package file, by its name. */
function scriptVerdict(script: string, args: readonly Word[], here: Here): Verdict {
  if (PUBLISH_SCRIPT.test(script)) return high('publish', script)
  if (CHECK_SCRIPT.test(script)) return check(here, args)
  return projectRun(here, args)
}

/** Where a local program a project keeps is run by its path: its packages' and its build's. */
const LOCAL_BIN =
  /(?:^|[\\/])(?:node_modules[\\/]\.bin|vendor[\\/]bin|\.?venv[\\/](?:bin|Scripts))[\\/][^\\/]+$/i
const LOCAL_TOOLS = new Set(['gradlew', 'mvnw'])

function programVerdict(words: readonly Word[], here: Here): Verdict {
  const head = words[0]!
  if (head.glob) return high('unparsed')
  const name = commandName(head.text)
  const args = words.slice(1)
  if (/[\\/]/.test(head.text)) {
    const place = placeOf(head.text, here)
    if (place === 'project') {
      if (!LOCAL_BIN.test(head.text) && !LOCAL_TOOLS.has(name)) return projectRun(here, args)
    } else if (place !== 'system') {
      return place === 'secret' ? high('sensitive', head.text) : high('unknownCommand', head.text)
    }
  }
  return named(name, args, here)
}

function named(name: string, args: readonly Word[], here: Here): Verdict {
  const texts = args.map((word) => word.text)
  const known = knownProgram(name, args, here)
  if (known) return known
  if (texts.length > 0 && texts.every((text) => VERSION_ARGS.has(text)) && isProgram(name)) {
    return low('readCommand')
  }
  return high('unknownCommand', name)
}

/** Whether `name` is a program this knows, so asking its version is low. */
function isProgram(name: string): boolean {
  return TOOL_NAMES.has(name) || /^(?:python|pypy)[\d.]*$/.test(name)
}

const TOOL_NAMES = new Set([
  'node',
  'nodejs',
  'deno',
  'bun',
  'npm',
  'pnpm',
  'yarn',
  'npx',
  'go',
  'cargo',
  'rustc',
  'rustup',
  'java',
  'javac',
  'dotnet',
  'swift',
  'ruby',
  'gem',
  'php',
  'perl',
  'git',
  'gh',
  'make',
  'cmake',
  'pip',
  'pip3',
  'uv',
  'poetry',
  'tsc',
  'gcc',
  'clang',
  'kotlin',
  'gradle',
  'mvn',
])

/** The verdict of a program this knows, or null for one it does not. */
function knownProgram(name: string, args: readonly Word[], here: Here): Verdict | null {
  const texts = args.map((word) => word.text)
  // A reader with no path reads the folder it runs in, or its input.
  const folder: Word = { text: '.', glob: false }
  if (CONTENT_READERS.has(name)) {
    if (name === 'rg' && texts.some((text) => /^--pre(?:=|$)/.test(text))) return high('unsafe')
    return readArgs([...args, folder], here, 'contents', low('readCommand'))
  }
  if (NAME_READERS.has(name)) return readArgs([...args, folder], here, 'names', low('readCommand'))
  if (OUTPUT_ONLY.has(name)) return low('readCommand')
  if (SYSTEM_READERS.has(name)) return medium('readOutside', name)
  if (NETWORK.has(name)) return medium('network', name)
  if (name === 'printenv' || name === 'history') return high('sensitive', name)
  if (WRITERS.has(name)) {
    if (texts.some((text) => /^(?:symboliclink|junction|hardlink)$/i.test(text))) {
      return high('unsafe')
    }
    return writeArgs(args, here, cwdInside(here) ? medium('editProject') : high('outsideProject'))
  }
  switch (name) {
    case 'ln':
    case 'mklink':
      return high('unsafe')
    case 'tree':
      return outputOption(args, here, ['-o'], 'names')
    case 'sort':
      if (texts.some((text) => /^--(?:compress-program|random-source)/.test(text))) {
        return high('unsafe')
      }
      return outputOption(args, here, ['-o', '--output', '-T', '--temporary-directory'], 'contents')
    case 'uniq': {
      const files = args.filter((word) => !word.text.startsWith('-'))
      const read = readArgs(args, here, 'contents', low('readCommand'))
      return files[1] ? worst(read, writeArgs([files[1]], here, medium('editProject'))) : read
    }
    case 'date':
      return texts.some((text) => /^(?:-s|--set)/.test(text)) ? high('unsafe') : low('readCommand')
    case 'hostname':
      return texts.every((text) => /^-[fsiIdA]$|^--(?:fqdn|short|ip-address)$/.test(text))
        ? low('readCommand')
        : high('unsafe')
    case 'sed':
      return sedVerdict(args, here)
    case 'awk':
    case 'gawk':
    case 'mawk':
    case 'nawk':
      return awkVerdict(args, here)
    case 'jq':
      return jqVerdict(args, here)
    case 'git':
      return gitVerdict(args, here)
    case 'gh':
      return ghVerdict(args)
    case 'curl':
      return here.shell === 'powershell'
        ? worst(curlVerdict(args, here), webRequestVerdict(args, here))
        : curlVerdict(args, here)
    case 'wget':
      return here.shell === 'powershell'
        ? worst(wgetVerdict(args, here), webRequestVerdict(args, here))
        : wgetVerdict(args, here)
    case 'invoke-webrequest':
    case 'iwr':
    case 'invoke-restmethod':
    case 'irm':
      return webRequestVerdict(args, here)
    case 'pip':
    case 'pip3':
      return pipVerdict(args, here)
    case 'npm':
      return npmVerdict(args, here)
    case 'pnpm':
      return pnpmVerdict(args, here)
    case 'yarn':
      return yarnVerdict(args, here)
    case 'bun':
      return bunVerdict(args, here)
    case 'npx':
    case 'pnpx':
    case 'bunx':
      return runnerVerdict(args, here, true)
    case 'uvx':
      return runnerVerdict(args, here, true)
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'dash':
    case 'powershell':
    case 'pwsh':
    case 'node':
    case 'nodejs':
    case 'ruby':
    case 'perl':
    case 'php':
    case 'lua':
    case 'rscript':
    case 'tsx':
    case 'ts-node':
    case 'vite-node':
    case 'esno':
      if (texts.length === 1 && VERSION_ARGS.has(texts[0]!)) return low('readCommand')
      return scriptFile(args[0], args.slice(1), here)
    case 'run-s':
    case 'run-p':
    case 'npm-run-all': {
      const scripts = args.filter((word) => !word.text.startsWith('-'))
      if (scripts.length === 0 || scripts.some((word) => word.glob)) return projectRun(here, [])
      return scripts.reduce<Verdict>(
        (out, word) => worst(out, scriptVerdict(word.text, [], here)),
        low('projectCheck'),
      )
    }
  }
  if (/^(?:python|pypy)[\d.]*$/.test(name) || name === 'py') return pythonVerdict(args, here)
  return toolVerdict(name, args, here)
}

/** A program that reads, but writes the file one of its options names. */
function outputOption(
  args: readonly Word[],
  here: Here,
  options: readonly string[],
  mode: 'contents' | 'names',
): Verdict {
  let out = readArgs(args, here, mode, low('readCommand'))
  args.forEach((word, i) => {
    for (const option of options) {
      let value: string | undefined
      if (word.text === option) value = args[i + 1]?.text
      else if (option.startsWith('--') && word.text.startsWith(`${option}=`)) {
        value = word.text.slice(option.length + 1)
      } else if (!option.startsWith('--') && word.text.startsWith(option)) {
        value = word.text.slice(option.length)
      }
      if (value) out = worst(out, writeVerdict(placeOf(value, here), value))
    }
  })
  return out
}

// ---- sed, awk and jq: programs whose own language can write files or run commands

const SED_PRINT = /^(?:\d+|\$)(?:,(?:\d+|\$))?[pd]$|^\/[^/]*\/(?:,\/[^/]*\/)?[pd]$|^\d+q$|^[pd]$/
const SED_SUBSTITUTE = /^s(.)(?:(?!\1)[^\\]|\\.)*\1(?:(?!\1)[^\\]|\\.)*\1[gpiI\d]*$/

/** Whether a sed script only prints or substitutes, with no command that writes, reads or runs. */
function safeSedScript(script: string): boolean {
  return script
    .split(/\s*;\s*/)
    .filter((part) => part !== '')
    .every((part) => SED_PRINT.test(part) || SED_SUBSTITUTE.test(part))
}

function sedVerdict(args: readonly Word[], here: Here): Verdict {
  const scripts: string[] = []
  const files: Word[] = []
  let inPlace = false
  for (let i = 0; i < args.length; i++) {
    const text = args[i]!.text
    if (text === '-e' || text === '--expression') {
      const script = args[++i]?.text
      if (script === undefined) return high('unparsed')
      scripts.push(script)
    } else if (text.startsWith('--expression=')) {
      scripts.push(text.slice('--expression='.length))
    } else if (text === '-f' || text.startsWith('--file')) {
      return high('unparsed', 'sed -f')
    } else if (
      /^-[nErsuz]+$/.test(text) ||
      /^--(?:quiet|silent|regexp-extended|posix)$/.test(text)
    ) {
      continue
    } else if (/^-[nErsuz]*i/.test(text) || text.startsWith('--in-place')) {
      inPlace = true
    } else if (text.startsWith('-') && text !== '-') {
      return high('unparsed', 'sed')
    } else {
      files.push(args[i]!)
    }
  }
  if (scripts.length === 0) {
    const script = files.shift()
    if (!script) return high('unparsed', 'sed')
    scripts.push(script.text)
  }
  if (!scripts.every(safeSedScript)) return high('unparsed', 'sed')
  return inPlace
    ? writeArgs(files, here, cwdInside(here) ? medium('editProject') : high('outsideProject'))
    : readArgs(files, here, 'contents', low('readCommand'))
}

function awkVerdict(args: readonly Word[], here: Here): Verdict {
  let program: string | null = null
  const files: Word[] = []
  for (let i = 0; i < args.length; i++) {
    const text = args[i]!.text
    if (program === null && (text === '-F' || text === '-v')) {
      i++
    } else if (program === null && /^-[Fv]./.test(text)) {
      continue
    } else if (program === null && text === '--') {
      continue
    } else if (program === null && text.startsWith('-')) {
      // -f takes the program from a file, gawk's -i, -l and -e load or add code.
      return high('unparsed', 'awk')
    } else if (program === null) {
      program = text
    } else {
      files.push(args[i]!)
    }
  }
  if (program === null) return high('unparsed', 'awk')
  if (/ENVIRON|PROCINFO/.test(program)) return high('sensitive', 'ENVIRON')
  return readArgs(files, here, 'contents', low('readCommand'))
}

const JQ_FLAGS =
  /^(?:-[rcnsejaSCMR]+|--(?:tab|raw-output|compact-output|null-input|slurp|exit-status|join-output|sort-keys|raw-input|seq|stream|ascii-output|color-output|monochrome-output|raw-output0))$/

function jqVerdict(args: readonly Word[], here: Here): Verdict {
  let program: string | null = null
  const files: Word[] = []
  for (let i = 0; i < args.length; i++) {
    const text = args[i]!.text
    if (JQ_FLAGS.test(text)) continue
    if (text === '--arg' || text === '--argjson') {
      i += 2
    } else if (text === '--slurpfile' || text === '--rawfile') {
      const file = args[i + 2]
      if (file) files.push(file)
      i += 2
    } else if (text === '--indent') {
      i++
    } else if (text.startsWith('-')) {
      // -f takes the program from a file, -L adds a folder of modules.
      return high('unparsed', 'jq')
    } else if (program === null) {
      program = text
    } else {
      files.push(args[i]!)
    }
  }
  if (program !== null && /\$ENV|\benv\b|\$__prog_args/.test(program)) {
    return high('sensitive', 'env')
  }
  return readArgs(files, here, 'contents', low('readCommand'))
}

// ---- Git

const GIT_READS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'annotate',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'rev-list',
  'describe',
  'shortlog',
  'cat-file',
  'show-ref',
  'merge-base',
  'name-rev',
  'for-each-ref',
  'check-ignore',
  'check-attr',
  'whatchanged',
  'range-diff',
  'cherry',
  'show-branch',
  'count-objects',
  'diff-tree',
  'diff-files',
  'diff-index',
  'version',
  'help',
  'grep',
  // command-safety lets these through only listing.
  'branch',
  'tag',
  'remote',
  'stash',
  'worktree',
])

/** Git past command-safety: a read is low, adding and committing medium, fetching the network. */
function gitVerdict(args: readonly Word[], here: Here): Verdict {
  const places: Word[] = []
  let i = 0
  for (; i < args.length && args[i]!.text.startsWith('-'); i++) {
    const text = args[i]!.text
    if (['-C', '--git-dir', '--work-tree', '--namespace'].includes(text)) {
      const value = args[i + 1]
      if (value && text !== '--namespace') places.push(value)
      i++
    } else if (/^--(?:git-dir|work-tree)=/.test(text)) {
      places.push({ text: text.slice(text.indexOf('=') + 1), glob: false })
    }
  }
  const sub = args[i]?.text
  const rest = args.slice(i + 1)
  if (sub === undefined) return low('readCommand')
  if (GIT_READS.has(sub)) return readArgs([...places, ...rest], here, 'names', low('readCommand'))
  if (sub === 'fetch' || sub === 'ls-remote') {
    return readArgs(places, here, 'names', medium('network', `git ${sub}`))
  }
  if (sub === 'add' || sub === 'commit') {
    let out = readArgs(rest, here, 'names', medium('gitWrite', `git ${sub}`))
    for (const place of places) {
      out = worst(out, writeVerdict(placeOf(place.text, here), place.text))
    }
    return out
  }
  return high('gitDanger', `git ${sub}`)
}

const GH_READS: Record<string, readonly string[]> = {
  pr: ['view', 'list', 'status', 'diff', 'checks'],
  issue: ['view', 'list', 'status'],
  repo: ['view', 'list'],
  run: ['view', 'list', 'watch'],
  workflow: ['view', 'list'],
  release: ['view', 'list'],
  label: ['list'],
  gist: ['view', 'list'],
  cache: ['list'],
  auth: ['status'],
  search: ['repos', 'issues', 'prs', 'code', 'commits'],
}

/** GitHub's CLI: what only reads GitHub is medium; anything that changes or sends there high. */
function ghVerdict(args: readonly Word[]): Verdict {
  const [group, action] = args.map((word) => word.text)
  if (group === undefined || VERSION_ARGS.has(group)) return low('readCommand')
  if (group === 'auth' && action === 'token') return high('sensitive', 'gh auth token')
  if (group === 'api') {
    const texts = args.map((word) => word.text)
    const sends = texts.some((text, i) => {
      if (/^(?:-f|-F|--field|--raw-field|--input)(?:=|$)/.test(text)) return true
      if (/^(?:-X|--method)$/.test(text)) return !/^(?:GET|HEAD)$/i.test(texts[i + 1] ?? '')
      if (/^(?:-X|--method=)/.test(text)) return !/(?:GET|HEAD)$/i.test(text)
      return false
    })
    return sends ? high('upload', 'gh api') : medium('network', 'gh api')
  }
  if (action !== undefined && GH_READS[group]?.includes(action)) {
    return medium('network', `gh ${group} ${action}`)
  }
  return high('publish', `gh ${group}${action ? ` ${action}` : ''}`)
}

// ---- The network's programs

/** A URL's scheme other than the web's, through which curl reads files or speaks other protocols. */
function oddScheme(text: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)?.[1]
  return scheme !== undefined && !/^https?$/i.test(scheme)
}

interface OptionSpec {
  /** Options that take a value, by name, and what the value is. */
  values: Record<string, 'write' | 'read' | 'send' | 'method' | 'config' | 'other'>
  /** Options without a value that write a file named by the URL into the folder. */
  cwdWrites?: readonly string[]
}

/**
 * Walks a program's options, single-letter ones grouped as `-sSLo file` included, and judges each
 * value by what the option does with it.
 */
function optionsVerdict(args: readonly Word[], here: Here, spec: OptionSpec, base: Verdict) {
  let out = base
  const take = (kind: string, value: string | undefined, option: string): void => {
    if (value === undefined) {
      out = worst(out, high('unparsed', option))
      return
    }
    if (kind === 'write') out = worst(out, writeVerdict(placeOf(value, here), value))
    else if (kind === 'read') out = worst(out, readVerdict(placeOf(value, here), value))
    else if (kind === 'send') out = worst(out, high('upload', option))
    else if (kind === 'config') out = worst(out, high('unsafe'))
    else if (kind === 'method' && !/^(?:GET|HEAD|OPTIONS)$/i.test(value)) {
      out = worst(out, high('upload', `${option} ${value}`))
    }
  }
  const cwdWrite = (): void => {
    out = worst(
      out,
      here.cwd === null
        ? high('writeOutside', '.')
        : writeArgs([{ text: '.', glob: false }], here, out),
    )
  }
  for (let i = 0; i < args.length; i++) {
    const text = args[i]!.text
    if (text.startsWith('--')) {
      const eq = text.indexOf('=')
      const name = eq === -1 ? text : text.slice(0, eq)
      const kind = spec.values[name]
      if (kind) take(kind, eq === -1 ? args[++i]?.text : text.slice(eq + 1), name)
      else if (spec.cwdWrites?.includes(name)) cwdWrite()
      continue
    }
    if (text.startsWith('-') && text.length > 1) {
      for (let j = 1; j < text.length; j++) {
        const name = `-${text[j]}`
        const kind = spec.values[name]
        if (kind) {
          const attached = text.slice(j + 1)
          take(kind, attached !== '' ? attached : args[++i]?.text, name)
          break
        }
        if (spec.cwdWrites?.includes(name)) cwdWrite()
      }
      continue
    }
    if (oddScheme(text)) out = worst(out, high('unparsed', text))
  }
  return out
}

const CURL: OptionSpec = {
  values: {
    '-o': 'write',
    '--output': 'write',
    '-D': 'write',
    '--dump-header': 'write',
    '-c': 'write',
    '--cookie-jar': 'write',
    '--trace': 'write',
    '--trace-ascii': 'write',
    '--stderr': 'write',
    '--libcurl': 'write',
    '--output-dir': 'write',
    '--etag-save': 'write',
    '-T': 'send',
    '--upload-file': 'send',
    '-F': 'send',
    '--form': 'send',
    '--form-string': 'send',
    '-d': 'send',
    '--data': 'send',
    '--data-binary': 'send',
    '--data-raw': 'send',
    '--data-ascii': 'send',
    '--data-urlencode': 'send',
    '--json': 'send',
    '-K': 'config',
    '--config': 'config',
    '-X': 'method',
    '--request': 'method',
    '-b': 'read',
    '--cookie': 'other',
    '-H': 'other',
    '--header': 'other',
    '-u': 'other',
    '--user': 'other',
    '-A': 'other',
    '--user-agent': 'other',
    '-e': 'other',
    '--referer': 'other',
    '-m': 'other',
    '--max-time': 'other',
    '--connect-timeout': 'other',
    '-x': 'other',
    '--proxy': 'other',
    '-w': 'other',
    '--write-out': 'other',
    '-r': 'other',
    '--range': 'other',
    '--retry': 'other',
    '-E': 'read',
    '--cert': 'read',
    '--key': 'read',
    '--cacert': 'read',
    '--url': 'other',
  },
  cwdWrites: ['-O', '--remote-name', '--remote-name-all', '-J', '--remote-header-name'],
}

function curlVerdict(args: readonly Word[], here: Here): Verdict {
  return optionsVerdict(args, here, CURL, medium('network', 'curl'))
}

const WGET: OptionSpec = {
  values: {
    '-O': 'write',
    '--output-document': 'write',
    '-o': 'write',
    '--output-file': 'write',
    '-a': 'write',
    '--append-output': 'write',
    '-P': 'write',
    '--directory-prefix': 'write',
    '--save-cookies': 'write',
    '--warc-file': 'write',
    '-i': 'read',
    '--input-file': 'read',
    '--load-cookies': 'read',
    '--post-data': 'send',
    '--post-file': 'send',
    '--body-data': 'send',
    '--body-file': 'send',
    '--method': 'method',
    '-e': 'config',
    '--execute': 'config',
    '--config': 'config',
    '--use-askpass': 'config',
    '-U': 'other',
    '--user-agent': 'other',
    '--header': 'other',
    '-t': 'other',
    '--tries': 'other',
    '-T': 'other',
    '--timeout': 'other',
  },
}

function wgetVerdict(args: readonly Word[], here: Here): Verdict {
  const texts = args.map((word) => word.text)
  const chosen = texts.some((text) =>
    /^(?:-O|--output-document|-P|--directory-prefix|--spider)(?:=|$)|^-[^-]*O/.test(text),
  )
  const base = medium('network', 'wget')
  // Without -O, wget saves into the folder it runs in.
  const saved = chosen
    ? base
    : here.cwd === null
      ? high('writeOutside', '.')
      : writeArgs([{ text: '.', glob: false }], here, base)
  return optionsVerdict(args, here, WGET, saved)
}

/** PowerShell's Invoke-WebRequest and Invoke-RestMethod, with their parameters' names in any case. */
function webRequestVerdict(args: readonly Word[], here: Here): Verdict {
  let out = medium('network', 'Invoke-WebRequest')
  for (let i = 0; i < args.length; i++) {
    const text = args[i]!.text
    const match = /^-([A-Za-z]+)(?::(.*))?$/.exec(text)
    if (!match) {
      if (oddScheme(text)) out = worst(out, high('unparsed', text))
      continue
    }
    const name = match[1]!.toLowerCase()
    const value = (): string | undefined => match[2] ?? args[++i]?.text
    if (name.startsWith('outf')) {
      const file = value()
      out = worst(out, file ? writeVerdict(placeOf(file, here), file) : high('unparsed'))
    } else if (name.startsWith('inf') || name === 'body' || name === 'form') {
      return high('upload', `-${match[1]}`)
    } else if (name === 'method') {
      const method = value() ?? ''
      if (!/^(?:get|head|options)$/i.test(method)) return high('upload', `-Method ${method}`)
    } else if (name === 'uri') {
      const uri = value()
      if (uri !== undefined && oddScheme(uri)) out = worst(out, high('unparsed', uri))
    }
  }
  return out
}

// ---- Package managers

const NPM_INSTALL = new Set([
  'install',
  'i',
  'in',
  'ins',
  'inst',
  'insta',
  'instal',
  'isnt',
  'isnta',
  'isntal',
  'isntall',
  'add',
  'ci',
  'clean-install',
  'ic',
  'install-clean',
  'update',
  'up',
  'upgrade',
  'udpate',
  'uninstall',
  'un',
  'remove',
  'rm',
  'r',
  'dedupe',
  'ddp',
  'prune',
  'install-test',
  'it',
  'install-ci-test',
  'cit',
])
const NPM_READS = new Set([
  'ls',
  'list',
  'll',
  'la',
  'why',
  'explain',
  'root',
  'prefix',
  'bin',
  'help',
])
const NPM_NETWORK = new Set([
  'view',
  'v',
  'info',
  'show',
  'outdated',
  'search',
  's',
  'se',
  'find',
  'doctor',
  'ping',
  'fund',
])
const NPM_PUBLISH = new Set([
  'publish',
  'unpublish',
  'deprecate',
  'dist-tag',
  'owner',
  'access',
  'team',
  'org',
  'login',
  'logout',
  'adduser',
  'add-user',
  'token',
  'hook',
  'star',
  'unstar',
  'trust',
])

/** What npm, pnpm, yarn and bun share: installs, reads, publishing, audits. */
function packageCommon(sub: string, rest: readonly Word[], here: Here): Verdict | null {
  if (NPM_INSTALL.has(sub)) return install(here, rest)
  if (NPM_READS.has(sub)) return readArgs(rest, here, 'names', low('readCommand'))
  if (NPM_NETWORK.has(sub)) return medium('network', sub)
  if (NPM_PUBLISH.has(sub)) return high('publish', sub)
  if (sub === 'audit') {
    return rest.some((word) => word.text === 'fix' || word.text === '--fix')
      ? install(here, rest)
      : medium('network', 'audit')
  }
  if (sub === 'link' || sub === 'ln' || sub === 'unlink') return high('globalInstall', sub)
  if (sub === 'rebuild' || sub === 'rb') return projectRun(here, rest)
  if (sub === 'pack') return edit(here, rest)
  if (sub === 'cache' || sub === 'store') return high('writeOutside', sub)
  if (sub === 'config' || sub === 'c') {
    return ['get', 'list', 'ls'].includes(rest[0]?.text ?? '') ? low('readCommand') : high('unsafe')
  }
  if (sub === 'init' || sub === 'create' || sub === 'innit') {
    return rest.some((word) => !word.text.startsWith('-'))
      ? medium('download', `${sub} ${rest[0]?.text ?? ''}`.trim())
      : edit(here, rest)
  }
  return null
}

function npmVerdict(args: readonly Word[], here: Here): Verdict {
  const sub = args[0]?.text
  const rest = args.slice(1)
  if (sub === undefined || VERSION_ARGS.has(sub)) return low('readCommand')
  if (sub === 'test' || sub === 't' || sub === 'tst') return check(here, rest)
  if (sub === 'run' || sub === 'run-script' || sub === 'rum' || sub === 'urn') {
    const script = rest[0]
    return script ? scriptVerdict(script.text, rest.slice(1), here) : low('readCommand')
  }
  if (sub === 'start' || sub === 'stop' || sub === 'restart') return scriptVerdict(sub, rest, here)
  if (sub === 'exec' || sub === 'x') return runnerVerdict(rest, here, true)
  return packageCommon(sub, rest, here) ?? high('unknownCommand', `npm ${sub}`)
}

/** A subcommand pnpm, yarn and bun do not know runs the project's script, or a package's program. */
function scriptOrBin(sub: string, rest: readonly Word[], here: Here): Verdict {
  return toolVerdict(sub, rest, here) ?? scriptVerdict(sub, rest, here)
}

function pnpmVerdict(args: readonly Word[], here: Here): Verdict {
  const sub = args[0]?.text
  const rest = args.slice(1)
  if (sub === undefined || VERSION_ARGS.has(sub)) return low('readCommand')
  if (sub === 'test' || sub === 't' || sub === 'tst') return check(here, rest)
  if (sub === 'run') {
    const script = rest[0]
    return script ? scriptVerdict(script.text, rest.slice(1), here) : low('readCommand')
  }
  if (sub === 'exec') return runnerVerdict(rest, here, false)
  if (sub === 'dlx') return runnerVerdict(rest, here, true)
  if (['fetch', 'import', 'install-test'].includes(sub)) return install(here, rest)
  if (['patch', 'patch-commit', 'patch-remove'].includes(sub)) return edit(here, rest)
  if (sub === 'licenses') return low('readCommand')
  if (['env', 'setup', 'self-update', 'add-global'].includes(sub)) return high('globalInstall', sub)
  if (sub === 'deploy') return writeArgs(rest, here, medium('editProject'))
  return packageCommon(sub, rest, here) ?? scriptOrBin(sub, rest, here)
}

function yarnVerdict(args: readonly Word[], here: Here): Verdict {
  const sub = args[0]?.text
  const rest = args.slice(1)
  if (sub === undefined) return install(here, [])
  if (VERSION_ARGS.has(sub)) return low('readCommand')
  if (sub === 'test') return check(here, rest)
  if (sub === 'run') {
    const script = rest[0]
    return script ? scriptVerdict(script.text, rest.slice(1), here) : low('readCommand')
  }
  if (sub === 'global') return high('globalInstall', 'yarn global')
  if (sub === 'dlx') return runnerVerdict(rest, here, true)
  if (sub === 'exec') return runnerVerdict(rest, here, false)
  if (sub === 'npm') return high('publish', 'yarn npm')
  if (sub === 'workspace' || sub === 'workspaces') return high('unknownCommand', `yarn ${sub}`)
  return packageCommon(sub, rest, here) ?? scriptOrBin(sub, rest, here)
}

function bunVerdict(args: readonly Word[], here: Here): Verdict {
  const sub = args[0]?.text
  const rest = args.slice(1)
  if (sub === undefined || VERSION_ARGS.has(sub)) return low('readCommand')
  if (sub === 'test' || sub === 'build') return check(here, rest)
  if (sub === 'x') return runnerVerdict(rest, here, true)
  if (sub === 'a') return install(here, rest)
  if (sub === 'upgrade') return high('globalInstall', 'bun upgrade')
  if (sub === 'run') return bunRun(rest, here)
  return packageCommon(sub, rest, here) ?? bunRun(args, here)
}

const SCRIPT_FILE = /[\\/]|\.(?:[cm]?[jt]sx?)$/i

/** `bun <file>` runs it; `bun <name>` runs the project's script or a package's program. */
function bunRun(args: readonly Word[], here: Here): Verdict {
  const target = args[0]
  if (!target || target.text.startsWith('-')) return high('unparsed', 'bun')
  if (SCRIPT_FILE.test(target.text)) return scriptFile(target, args.slice(1), here)
  return scriptOrBin(target.text, args.slice(1), here)
}

/**
 * A package runner, such as npx: the program it runs, by the package's name. One that may fetch
 * the package first is medium at least.
 */
function runnerVerdict(args: readonly Word[], here: Here, download: boolean): Verdict {
  let i = 0
  while (['--', '-y', '--yes', '-q', '--quiet', '--silent'].includes(args[i]?.text ?? '')) i++
  const name = args[i]
  if (!name || name.text.startsWith('-') || name.glob) return high('unparsed')
  const program = commandName(name.text.replace(/(.)@[^/]*$/, '$1'))
  const inner = named(program, args.slice(i + 1), here)
  return download ? worst(inner, medium('download', program)) : inner
}

// ---- Python

const PYTHON_CHECKS = new Set([
  'pytest',
  'unittest',
  'doctest',
  'mypy',
  'pyright',
  'pylint',
  'flake8',
  'pyflakes',
  'pycodestyle',
  'pydocstyle',
  'bandit',
  'compileall',
  'py_compile',
  'tox',
  'nox',
  'build',
])

function pythonVerdict(args: readonly Word[], here: Here): Verdict {
  const texts = args.map((word) => word.text)
  if (texts.length === 1 && VERSION_ARGS.has(texts[0]!)) return low('readCommand')
  if (texts[0] !== '-m') return scriptFile(args[0], args.slice(1), here)
  if (texts[1] === 'pip') return pipVerdict(args.slice(2), here)
  const module = texts[1]
  const rest = args.slice(2)
  if (module === undefined) return high('unparsed')
  if (PYTHON_CHECKS.has(module)) return check(here, rest)
  const tool = toolVerdict(module, rest, here)
  if (tool) return tool
  if (module === 'venv' || module === 'virtualenv') {
    return writeArgs(rest, here, cwdInside(here) ? medium('editProject') : high('outsideProject'))
  }
  if (module === 'http.server') return medium('network', 'http.server')
  if (module === 'json.tool') return readArgs(rest, here, 'contents', low('readCommand'))
  if (module === 'twine') return high('publish', 'twine')
  return projectRun(here, rest)
}

function pipVerdict(args: readonly Word[], here: Here): Verdict {
  const sub = args[0]?.text
  const rest = args.slice(1)
  if (sub === undefined || VERSION_ARGS.has(sub)) return low('readCommand')
  if (['install', 'uninstall', 'download', 'wheel'].includes(sub)) return install(here, rest)
  if (['list', 'show', 'freeze', 'check', 'help', 'inspect', 'debug'].includes(sub)) {
    return low('readCommand')
  }
  if (sub === 'config' || sub === 'cache') {
    return ['list', 'get', 'dir', 'info'].includes(rest[0]?.text ?? '')
      ? low('readCommand')
      : high('writeOutside', `pip ${sub}`)
  }
  return high('unknownCommand', `pip ${sub}`)
}

// ---- Build, test and lint tools

type Kind =
  'check' | 'read' | 'edit' | 'install' | 'run' | 'network' | 'global' | 'publish' | 'delete'

interface Tool {
  /** What the tool does with no subcommand, or when it has none. */
  bare?: Kind
  subs?: Record<string, Kind>
  /** Options that make a checking tool write the files it checks. */
  writes?: RegExp
  /** Options that make a writing tool only check. */
  checks?: RegExp
  /** Options that have the tool run another program, such as `go test -exec`. */
  runs?: RegExp
  /** The tool reads its words as tasks or targets of the project's own, as make does. */
  tasks?: boolean
}

function kindVerdict(kind: Kind, args: readonly Word[], here: Here, detail: string): Verdict {
  switch (kind) {
    case 'check':
      return check(here, args)
    case 'read':
      return readArgs(args, here, 'names', low('readCommand'))
    case 'edit':
      return edit(here, args)
    case 'install':
      return install(here, args)
    case 'run':
      return projectRun(here, args)
    case 'network':
      return medium('network', detail)
    case 'global':
      return high('globalInstall', detail)
    case 'publish':
      return high('publish', detail)
    case 'delete':
      return high('delete', detail)
  }
}

const FIXES = /^(?:--fix|--fix-type=.*)$/
const SNAPSHOTS = /^(?:-u|--update|--updateSnapshot|--update-snapshots)$/

const TOOLS: Record<string, Tool> = {
  tsc: { bare: 'check' },
  'vue-tsc': { bare: 'check' },
  'svelte-check': { bare: 'check' },
  eslint: { bare: 'check', writes: FIXES },
  oxlint: { bare: 'check', writes: FIXES },
  stylelint: { bare: 'check', writes: FIXES },
  markdownlint: { bare: 'check', writes: FIXES },
  'markdownlint-cli2': { bare: 'check', writes: FIXES },
  prettier: { bare: 'check', writes: /^(?:--write|-w)$/ },
  biome: {
    subs: { check: 'check', lint: 'check', format: 'check', ci: 'check', version: 'read' },
    writes: /^(?:--write|--apply|--apply-unsafe|--fix|--unsafe)$/,
  },
  vitest: { bare: 'check', writes: SNAPSHOTS },
  jest: { bare: 'check', writes: SNAPSHOTS },
  mocha: { bare: 'check' },
  ava: { bare: 'check', writes: SNAPSHOTS },
  playwright: { subs: { test: 'check', 'show-report': 'run', install: 'global' } },
  cypress: { subs: { run: 'check', verify: 'read', open: 'run', install: 'global' } },
  pytest: { bare: 'check', runs: /^-p$/ },
  'py.test': { bare: 'check', runs: /^-p$/ },
  tox: { bare: 'check' },
  nox: { bare: 'check' },
  mypy: { bare: 'check' },
  pyright: { bare: 'check' },
  pylint: { bare: 'check' },
  flake8: { bare: 'check' },
  bandit: { bare: 'check' },
  ruff: {
    subs: { check: 'check', format: 'edit', clean: 'delete', version: 'read' },
    writes: /^(?:--fix|--unsafe-fixes)$/,
    checks: /^(?:--check|--diff)$/,
  },
  black: { bare: 'edit', checks: /^(?:--check|--diff)$/ },
  isort: { bare: 'edit', checks: /^(?:--check|--check-only|-c|--diff)$/ },
  shellcheck: { bare: 'check' },
  hadolint: { bare: 'check' },
  yamllint: { bare: 'check' },
  actionlint: { bare: 'check' },
  'golangci-lint': { subs: { run: 'check', version: 'read' }, writes: FIXES },
  staticcheck: { bare: 'check' },
  gofmt: { bare: 'check', writes: /^-w$/ },
  rustfmt: { bare: 'edit', checks: /^--check$/ },
  'clang-format': { bare: 'check', writes: /^-i$/ },
  'clang-tidy': { bare: 'check', writes: /^(?:--fix|-fix)$/ },
  swiftlint: { bare: 'check', writes: /^(?:--fix|--autocorrect)$/ },
  swiftformat: { bare: 'edit', checks: /^--lint$/ },
  ktlint: { bare: 'check', writes: /^(?:-F|--format)$/ },
  rubocop: {
    bare: 'check',
    writes: /^(?:-a|-A|--autocorrect|--auto-correct|--autocorrect-all|--fix-layout)$/,
  },
  rspec: { bare: 'check' },
  phpunit: { bare: 'check' },
  phpstan: { bare: 'check' },
  psalm: { bare: 'check' },
  phpcs: { bare: 'check' },
  phpcbf: { bare: 'edit' },
  codespell: { bare: 'check', writes: /^(?:-w|--write-changes)$/ },
  typos: { bare: 'check', writes: /^(?:-w|--write-changes)$/ },
  knip: { bare: 'check', writes: FIXES },
  webpack: { bare: 'check', subs: { build: 'check', serve: 'run', watch: 'check' } },
  rollup: { bare: 'check' },
  esbuild: { bare: 'check' },
  tsup: { bare: 'check' },
  unbuild: { bare: 'check' },
  next: {
    subs: { build: 'check', lint: 'check', dev: 'run', start: 'run', info: 'read', export: 'edit' },
  },
  vite: { bare: 'run', subs: { build: 'check', dev: 'run', serve: 'run', preview: 'run' } },
  astro: {
    subs: {
      check: 'check',
      build: 'check',
      dev: 'run',
      preview: 'run',
      add: 'install',
      sync: 'edit',
    },
  },
  nuxi: {
    subs: { typecheck: 'check', build: 'check', generate: 'check', dev: 'run', prepare: 'edit' },
  },
  ng: {
    subs: {
      test: 'check',
      t: 'check',
      build: 'check',
      b: 'check',
      lint: 'check',
      e2e: 'check',
      serve: 'run',
      s: 'run',
      generate: 'edit',
      g: 'edit',
      add: 'install',
      update: 'install',
      version: 'read',
    },
  },
  turbo: { tasks: true, subs: { prune: 'edit', gen: 'edit', login: 'publish', link: 'publish' } },
  cargo: {
    bare: 'read',
    subs: {
      test: 'check',
      t: 'check',
      build: 'check',
      b: 'check',
      check: 'check',
      c: 'check',
      clippy: 'check',
      bench: 'check',
      doc: 'check',
      tree: 'read',
      metadata: 'read',
      version: 'read',
      fmt: 'edit',
      run: 'run',
      r: 'run',
      add: 'install',
      remove: 'install',
      rm: 'install',
      update: 'install',
      fetch: 'install',
      'generate-lockfile': 'install',
      vendor: 'install',
      new: 'edit',
      init: 'edit',
      search: 'network',
      install: 'global',
      uninstall: 'global',
      publish: 'publish',
      login: 'publish',
      logout: 'publish',
      owner: 'publish',
      yank: 'publish',
      clean: 'delete',
    },
    checks: /^--check$/,
    runs: /^(?:--config(?:=|$)|-Z|--target-runner)/,
  },
  go: {
    bare: 'read',
    subs: {
      test: 'check',
      build: 'check',
      vet: 'check',
      list: 'read',
      version: 'read',
      doc: 'read',
      help: 'read',
      fmt: 'edit',
      run: 'run',
      generate: 'run',
      tool: 'run',
      get: 'install',
      mod: 'install',
      work: 'install',
      install: 'global',
      clean: 'delete',
    },
    runs: /^-(?:exec|toolexec|overlay)(?:=|$)/,
  },
  dotnet: {
    subs: {
      build: 'check',
      test: 'check',
      restore: 'install',
      add: 'install',
      remove: 'install',
      run: 'run',
      watch: 'run',
      format: 'edit',
      pack: 'edit',
      publish: 'edit',
      new: 'edit',
      sln: 'edit',
      clean: 'delete',
      tool: 'global',
      nuget: 'publish',
      '--info': 'read',
      '--list-sdks': 'read',
    },
    checks: /^--verify-no-changes$/,
  },
  deno: {
    subs: {
      test: 'check',
      lint: 'check',
      check: 'check',
      bench: 'check',
      coverage: 'check',
      doc: 'read',
      info: 'read',
      types: 'read',
      fmt: 'edit',
      task: 'run',
      serve: 'run',
      compile: 'edit',
      add: 'install',
      remove: 'install',
      cache: 'install',
      install: 'global',
      uninstall: 'global',
      upgrade: 'global',
      publish: 'publish',
    },
    checks: /^--check$/,
  },
  swift: { subs: { build: 'check', test: 'check', run: 'run', package: 'install' } },
  make: { tasks: true },
  gmake: { tasks: true },
  'mingw32-make': { tasks: true },
  nmake: { tasks: true },
  just: { tasks: true },
  task: { tasks: true },
  ninja: { bare: 'check' },
  ctest: { bare: 'check' },
  meson: {
    subs: { test: 'check', compile: 'check', setup: 'edit', configure: 'edit', install: 'global' },
  },
  mvn: { tasks: true },
  mvnw: { tasks: true },
  gradle: { tasks: true },
  gradlew: { tasks: true },
  bazel: {
    subs: {
      build: 'check',
      test: 'check',
      query: 'read',
      cquery: 'read',
      info: 'read',
      version: 'read',
      run: 'run',
      clean: 'delete',
      fetch: 'install',
      sync: 'install',
    },
  },
  bazelisk: {
    subs: { build: 'check', test: 'check', query: 'read', run: 'run', clean: 'delete' },
  },
  mix: {
    subs: {
      test: 'check',
      compile: 'check',
      credo: 'check',
      dialyzer: 'check',
      format: 'edit',
      'deps.get': 'install',
      run: 'run',
    },
    checks: /^--check-formatted$/,
  },
  bundle: { subs: { install: 'install', update: 'install', check: 'read', list: 'read' } },
  composer: {
    subs: {
      install: 'install',
      update: 'install',
      require: 'install',
      remove: 'install',
      'dump-autoload': 'edit',
      validate: 'check',
      show: 'read',
      global: 'global',
    },
  },
  uv: {
    subs: {
      sync: 'install',
      add: 'install',
      remove: 'install',
      lock: 'install',
      venv: 'edit',
      pip: 'install',
      init: 'edit',
      build: 'check',
      tree: 'read',
      export: 'read',
      publish: 'publish',
      python: 'global',
      self: 'global',
      cache: 'global',
    },
  },
  poetry: {
    subs: {
      install: 'install',
      add: 'install',
      remove: 'install',
      update: 'install',
      lock: 'install',
      sync: 'install',
      build: 'check',
      check: 'check',
      show: 'read',
      publish: 'publish',
    },
  },
  pipx: { subs: { list: 'read' } },
  conda: { subs: { list: 'read', info: 'read' } },
  rustc: { bare: 'check' },
  javac: { bare: 'check' },
  gcc: { bare: 'check' },
  'g++': { bare: 'check' },
  clang: { bare: 'check' },
  'clang++': { bare: 'check' },
}

/** Tasks or targets that only check or build. */
const CHECK_TASK =
  /^(?::?[\w.-]+:)*(?:test\w*|tests|check\w*|lint\w*|build|assemble\w*|compile\w*|verify|validate|vet|typecheck|spec|all|ci|package|jar|javadoc|integration-test|spotlesscheck|ktlintcheck|detekt|fmt-check|format-check)$/i
const DELETE_TASK = /^(?:clean|distclean|mrproper|realclean|clobber)$/i
const GLOBAL_TASK = /^(?:install|uninstall)$/i
const PUBLISH_TASK = /^(?:deploy|release|publish\w*|upload\w*|push)(?::.*)?$/i

/** A tool run with tasks of the project's own, such as `make test` or `gradle build`. */
function tasksVerdict(name: string, args: readonly Word[], here: Here): Verdict {
  const tasks: string[] = []
  // Variables and properties set on the line may change the commands a task runs.
  let overrides = false
  for (let i = 0; i < args.length; i++) {
    const text = args[i]!.text
    if (/^-[Cf]$|^--(?:directory|file|makefile)$/.test(text)) {
      i++
      continue
    }
    if (/^-[DP]./.test(text) || text.includes('=')) {
      overrides = true
      continue
    }
    if (text.startsWith('-')) continue
    if (!(text === 'run' && name === 'turbo')) tasks.push(text)
  }
  if (args.some((word) => /^(?:-n|--dry-run|--just-print)$/.test(word.text))) {
    return readArgs(args, here, 'names', low('readCommand'))
  }
  let out: Verdict = check(here, args)
  if (overrides) out = worst(out, projectRun(here, args))
  for (const task of tasks) {
    if (DELETE_TASK.test(task)) out = worst(out, high('delete', `${name} ${task}`))
    else if (GLOBAL_TASK.test(task)) out = worst(out, high('globalInstall', `${name} ${task}`))
    else if (PUBLISH_TASK.test(task)) out = worst(out, high('publish', `${name} ${task}`))
    else if (!CHECK_TASK.test(task)) out = worst(out, projectRun(here, args))
  }
  return out
}

/**
 * A build, test or lint tool, or null for a program not listed. A tool with subcommands takes one
 * it lists, or none at all; any other is high, since options before it could hide which it is.
 */
function toolVerdict(name: string, args: readonly Word[], here: Here): Verdict | null {
  const tool = TOOLS[name]
  if (!tool) return null
  const texts = args.map((word) => word.text)
  if (tool.runs && texts.some((text) => tool.runs!.test(text))) return high('unsafe')
  if (tool.tasks) {
    const sub = texts[0]
    const kind = sub !== undefined ? tool.subs?.[sub] : undefined
    if (kind) return kindVerdict(kind, args.slice(1), here, `${name} ${sub}`)
    return tasksVerdict(name, args, here)
  }
  let kind: Kind | undefined
  let rest = args
  let detail = name
  if (tool.subs) {
    const sub = texts[0]
    if (sub !== undefined && tool.subs[sub]) {
      kind = tool.subs[sub]
      rest = args.slice(1)
      detail = `${name} ${sub}`
    } else if (texts.length === 1 && VERSION_ARGS.has(texts[0]!)) {
      return low('readCommand')
    } else if (texts.some((text) => !text.startsWith('-'))) {
      const shown = texts.find((text) => !text.startsWith('-'))
      return high('unknownCommand', `${name} ${shown}`)
    } else {
      kind = tool.bare
    }
  } else {
    kind = tool.bare
  }
  if (kind === undefined) return high('unknownCommand', name)
  const words = rest.map((word) => word.text)
  if (kind === 'check' && tool.writes && words.some((text) => tool.writes!.test(text))) {
    kind = 'edit'
  } else if (kind === 'edit' && tool.checks && words.some((text) => tool.checks!.test(text))) {
    kind = 'check'
  }
  return kindVerdict(kind, rest, here, detail)
}
