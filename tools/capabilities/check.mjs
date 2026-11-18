// What the installed Codex CLI and Claude Agent SDK offer, compared with the committed snapshot and
// with what Kite's source uses, so a new option, method, field or value is noticed on upgrade
// rather than by a user.
//
//   node tools/capabilities/check.mjs [--update] [--sdk <folder>]
//
// It prints a Markdown report: what is new since the snapshot first, then what is offered but
// unused. `--update` rewrites the snapshot from what is installed; a part whose harness is missing
// keeps its old snapshot. `--sdk` points at an installed @anthropic-ai/claude-agent-sdk folder
// instead of the newest one in Kite's harness folders. Kite's own TypeScript reads the SDK's
// declarations; nothing of the SDK is imported.

import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SNAPSHOT = path.join(ROOT, 'tools/capabilities/snapshot.json')
const require = createRequire(path.join(ROOT, 'package.json'))

const CODEX_SOURCES = ['src/agent-host/codex', 'src/agent-host/marketplace/codex-plugins.ts']
const CLAUDE_SOURCES = ['src/agent-host/claude']
const KITE_SDK_TYPES = 'src/agent-host/claude/sdk.ts'

const UNIONS = {
  clientRequests: 'ClientRequest',
  serverNotifications: 'ServerNotification',
  serverRequests: 'ServerRequest',
}
const UNION_LABELS = {
  clientRequests: 'client request',
  serverNotifications: 'server notification',
  serverRequests: 'server request',
}

/** The shapes whose fields and values are tracked, by name: the file and the definition. */
const SHAPES = {
  Model: ['v2/ModelListResponse.json', 'Model'],
  GetAccountRateLimitsResponse: ['v2/GetAccountRateLimitsResponse.json', null],
  RateLimitSnapshot: ['v2/GetAccountRateLimitsResponse.json', 'RateLimitSnapshot'],
  ThreadStartParams: ['v2/ThreadStartParams.json', null],
  TurnStartParams: ['v2/TurnStartParams.json', null],
}
/** How many references deep a shape's fields are followed. */
const SHAPE_DEPTH = 3
const TAG_ORDER = ['type', 'method', 'mode', 'kind']

// --- Codex ------------------------------------------------------------------------------------

function runCodex(args) {
  const options = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }
  // npm installs codex as a .cmd shim on Windows, which only a shell runs.
  if (process.platform === 'win32') {
    return execSync(['codex', ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '), options)
  }
  return execFileSync('codex', args, options)
}

async function readCodex() {
  let version
  try {
    version = runCodex(['--version']).trim().split(/\s+/).pop()
  } catch {
    return { missing: 'the `codex` command was not found' }
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kite-capabilities-'))
  try {
    // Kite's client asks for the experimental API, so its methods and fields count too.
    runCodex(['app-server', 'generate-json-schema', '--experimental', '--out', dir])
    const load = async (file) => JSON.parse(await readFile(path.join(dir, file), 'utf8'))
    const methods = {}
    for (const [key, union] of Object.entries(UNIONS)) {
      const schema = await load(`${union}.json`)
      methods[key] = schema.oneOf
        .map((variant) => variant.properties?.method?.enum?.[0])
        .filter((method) => typeof method === 'string')
        .sort()
    }
    const shapes = {}
    for (const [name, [file, definition]] of Object.entries(SHAPES)) {
      if (!existsSync(path.join(dir, file))) continue
      shapes[name] = walkShape(await load(file), definition)
    }
    return { version, methods, shapes }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function refName(ref) {
  return ref.startsWith('#/definitions/') ? ref.slice('#/definitions/'.length) : ref
}

/** The values of a closed set of strings: an enum, a const, or a union of either. */
function enumValues(node, definitions) {
  if (!node || typeof node !== 'object') return null
  if (node.$ref) return enumValues(definitions[refName(node.$ref)], definitions)
  if (Array.isArray(node.enum)) return node.enum
  if (node.const !== undefined) return [node.const]
  const members = node.oneOf ?? node.anyOf
  if (!Array.isArray(members) || members.length === 0) return null
  const values = []
  for (const member of members) {
    if (member.type === 'null') continue
    const own = Array.isArray(member.enum)
      ? member.enum
      : member.const !== undefined
        ? [member.const]
        : null
    if (!own) return null
    values.push(...own)
  }
  return values.length > 0 ? values : null
}

/** A member's tag, such as `type=text`: a field that takes one value only. */
function tagOf(node, definitions) {
  const target = node?.$ref ? definitions[refName(node.$ref)] : node
  const properties = target?.properties
  if (!properties) return null
  const names = Object.keys(properties).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  for (const name of names) {
    const values = enumValues(properties[name], {})
    if (values?.length === 1) return `${name}=${values[0]}`
  }
  return null
}

function rank(name) {
  const at = TAG_ORDER.indexOf(name)
  return at < 0 ? TAG_ORDER.length : at
}

function typeName(node, definitions) {
  if (!node || typeof node !== 'object') return 'any'
  if (node.$ref) return refName(node.$ref)
  const values = enumValues(node, definitions)
  if (values) return values.length === 1 ? JSON.stringify(values[0]) : 'enum'
  const members = node.oneOf ?? node.anyOf
  if (Array.isArray(members)) return members.map((m) => typeName(m, definitions)).join(' | ')
  if (Array.isArray(node.allOf) && node.allOf.length === 1) {
    return typeName(node.allOf[0], definitions)
  }
  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : []
  if (types.length === 0) return 'any'
  return types
    .map((type) => (type === 'array' ? `${typeName(node.items, definitions)}[]` : type))
    .join(' | ')
}

/**
 * A shape's fields by path, such as `serviceTiers[].id` or `sandboxPolicy<type=workspaceWrite>.x`,
 * with their types, and the values of its enums: a referenced enum by its name, an inline one by
 * its path. Other tracked shapes it refers to stay names.
 */
function walkShape(schema, definition) {
  const definitions = schema.definitions ?? {}
  const root = definition ? definitions[definition] : schema
  const fields = {}
  const enums = {}
  const expand = (node, at, stack) => {
    if (!node || typeof node !== 'object') return
    if (node.$ref) {
      const name = refName(node.$ref)
      const target = definitions[name]
      const values = enumValues(target, definitions)
      if (values && values.length > 1) {
        enums[name] = [...new Set(values)].sort()
        return
      }
      if (name in SHAPES || stack.includes(name) || stack.length > SHAPE_DEPTH) return
      expand(target, at, [...stack, name])
      return
    }
    const values = enumValues(node, definitions)
    if (values) {
      if (values.length > 1) enums[at || '(root)'] = [...new Set(values)].sort()
      return
    }
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      for (const member of node[key] ?? []) {
        const tag = key === 'allOf' ? null : tagOf(member, definitions)
        expand(member, tag ? `${at}<${tag}>` : at, stack)
      }
    }
    if (node.items) expand(node.items, `${at}[]`, stack)
    if (typeof node.additionalProperties === 'object') {
      expand(node.additionalProperties, `${at}{}`, stack)
    }
    for (const [name, property] of Object.entries(node.properties ?? {})) {
      const field = at ? `${at}.${name}` : name
      fields[field] = typeName(property, definitions)
      expand(property, field, stack)
    }
  }
  expand(root, '', definition ? [definition] : [])
  return { fields: sortKeys(fields), enums: sortKeys(enums) }
}

// --- Claude Agent SDK -------------------------------------------------------------------------

/** Kite's harness folders and the data folders the task names, newest SDK first. */
function sdkCandidates() {
  const home = os.homedir()
  const data =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? path.join(home, 'AppData/Roaming'))
      : process.platform === 'darwin'
        ? path.join(home, 'Library/Application Support')
        : (process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'))
  const roots = [
    ...['.huli', '.kite', '.kettu'].map((name) => path.join(home, name)),
    ...['Kite', 'Huli', 'Kettu', 'Kettu Dev'].map((name) => path.join(data, name)),
  ]
  const found = []
  const sdkIn = (dir) => path.join(dir, 'node_modules/@anthropic-ai/claude-agent-sdk')
  for (const root of roots) {
    if (existsSync(sdkIn(root))) found.push(sdkIn(root))
    const versions = path.join(root, 'harnesses/claude-code')
    if (!existsSync(versions)) continue
    for (const version of readdirSync(versions)) {
      if (existsSync(sdkIn(path.join(versions, version)))) {
        found.push(sdkIn(path.join(versions, version)))
      }
    }
  }
  return found
}

function compareVersions(a, b) {
  const parts = (v) => v.split(/[.-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p))
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue
    if (x[i] === undefined) return -1
    if (y[i] === undefined) return 1
    return typeof x[i] === 'number' && typeof y[i] === 'number'
      ? x[i] - y[i]
      : String(x[i]).localeCompare(String(y[i]))
  }
  return 0
}

async function findSdk(chosen) {
  const dirs = chosen ? [path.resolve(chosen)] : sdkCandidates()
  let best = null
  for (const dir of dirs) {
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'))
      if (!best || compareVersions(pkg.version, best.version) > 0) {
        best = { dir, version: pkg.version, types: path.join(dir, pkg.types ?? 'sdk.d.ts') }
      }
    } catch {
      // Not an SDK folder, or a half-finished install.
    }
  }
  return best
}

async function readClaude(chosen) {
  const sdk = await findSdk(chosen)
  if (!sdk) {
    return {
      missing: chosen
        ? `no Claude Agent SDK at ${chosen}`
        : 'no installed Claude Agent SDK in the Kite, Huli or Kettu data folders (pass --sdk)',
    }
  }
  const ts = require('typescript')
  const program = ts.createProgram([sdk.types], {
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
  })
  const checker = program.getTypeChecker()
  const file = program.getSourceFile(sdk.types)
  const exports = checker.getExportsOfModule(checker.getSymbolAtLocation(file))
  const exported = (name) => {
    const symbol = exports.find((s) => s.name === name)
    if (!symbol) throw new Error(`The SDK's declarations export no ${name}`)
    return checker.getDeclaredTypeOfSymbol(symbol)
  }
  const keys = (type) => {
    const out = {}
    for (const property of checker.getPropertiesOfType(type)) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0]
      const own = declaration ? checker.getTypeOfSymbolAtLocation(property, declaration) : null
      out[property.name] = own ? literalValues(ts, checker.getNonNullableType(own)) : []
    }
    return sortKeys(out)
  }
  const init = checker
    .getPropertiesOfType(exported('SDKSystemMessage'))
    .some((p) => p.name === 'subtype')
    ? exported('SDKSystemMessage')
    : null
  if (!init) throw new Error("The SDK's SDKSystemMessage is no longer the init message")
  return {
    version: sdk.version,
    dir: sdk.dir,
    options: keys(exported('Options')),
    init: keys(init),
  }
}

/** A field's string values when its type is a closed set of strings, otherwise none. */
function literalValues(ts, type) {
  const parts = type.isUnion() ? type.types : [type]
  if (parts.some((part) => !part.isStringLiteral())) return []
  return parts.map((part) => part.value).sort()
}

/** The members of Kite's own `QueryOptions`, in src/agent-host/claude/sdk.ts. */
async function kiteQueryOptions() {
  const ts = require('typescript')
  const file = path.join(ROOT, KITE_SDK_TYPES)
  const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest)
  const declaration = source.statements.find(
    (s) => ts.isInterfaceDeclaration(s) && s.name.text === 'QueryOptions',
  )
  if (!declaration) throw new Error(`${KITE_SDK_TYPES} declares no QueryOptions`)
  return new Set(declaration.members.map((m) => m.name?.getText(source)).filter(Boolean))
}

// --- Kite's source ----------------------------------------------------------------------------

/** The identifiers and string literals in a part of Kite's source, its tests left out. */
async function sourceNames(entries) {
  const ts = require('typescript')
  const names = new Set()
  const files = []
  for (const entry of entries) {
    const full = path.join(ROOT, entry)
    if (full.endsWith('.ts')) files.push(full)
    else {
      for (const name of await readdir(full)) {
        if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(path.join(full, name))
      }
    }
  }
  for (const file of files) {
    const source = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest)
    const visit = (node) => {
      if (
        ts.isIdentifier(node) ||
        ts.isStringLiteralLike(node) ||
        ts.isTemplateLiteralToken(node)
      ) {
        names.add(node.text)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return names
}

// --- Comparison and report --------------------------------------------------------------------

function sortKeys(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

function added(now = [], then = []) {
  const before = new Set(then)
  return now.filter((item) => !before.has(item))
}

const code = (value) => `\`${value}\``
const list = (items) => items.map(code).join(', ')

function codexChanges(now, then) {
  const fresh = []
  const gone = []
  if (!then) return { fresh, gone, first: true }
  for (const key of Object.keys(UNIONS)) {
    for (const m of added(now.methods[key], then.methods?.[key])) {
      fresh.push(`${UNION_LABELS[key]} ${code(m)}`)
    }
    for (const m of added(then.methods?.[key], now.methods[key])) {
      gone.push(`${UNION_LABELS[key]} ${code(m)}`)
    }
  }
  for (const name of Object.keys(SHAPES)) {
    const a = now.shapes[name]
    const b = then.shapes?.[name]
    if (!a && !b) continue
    if (!a) {
      gone.push(`shape ${code(name)}`)
      continue
    }
    if (!b) {
      fresh.push(`shape ${code(name)}`)
      continue
    }
    for (const field of added(Object.keys(a.fields), Object.keys(b.fields))) {
      fresh.push(`${name}: field ${code(field)} (${a.fields[field]})`)
    }
    for (const field of added(Object.keys(b.fields), Object.keys(a.fields))) {
      gone.push(`${name}: field ${code(field)}`)
    }
    for (const [field, type] of Object.entries(a.fields)) {
      if (field in b.fields && b.fields[field] !== type) {
        fresh.push(`${name}: field ${code(field)} is now ${type} (was ${b.fields[field]})`)
      }
    }
    for (const [key, values] of Object.entries(a.enums)) {
      const old = b.enums[key]
      if (!old) fresh.push(`${name}: values of ${code(key)}: ${list(values)}`)
      else {
        const more = added(values, old)
        if (more.length > 0) fresh.push(`${name}: ${code(key)} gains ${list(more)}`)
        const fewer = added(old, values)
        if (fewer.length > 0) gone.push(`${name}: ${code(key)} loses ${list(fewer)}`)
      }
    }
  }
  return { fresh, gone }
}

function keyChanges(label, now, then) {
  const fresh = []
  const gone = []
  for (const key of added(Object.keys(now), Object.keys(then))) {
    const values = now[key].length > 0 ? `: ${list(now[key])}` : ''
    fresh.push(`${label}: ${code(key)}${values}`)
  }
  for (const key of added(Object.keys(then), Object.keys(now))) gone.push(`${label}: ${code(key)}`)
  for (const [key, values] of Object.entries(now)) {
    if (!then[key]) continue
    const more = added(values, then[key])
    if (more.length > 0) fresh.push(`${label}: ${code(key)} gains ${list(more)}`)
    const fewer = added(then[key], values)
    if (fewer.length > 0) gone.push(`${label}: ${code(key)} loses ${list(fewer)}`)
  }
  return { fresh, gone }
}

function claudeChanges(now, then) {
  if (!then) return { fresh: [], gone: [], first: true }
  const options = keyChanges('Options', now.options, then.options ?? {})
  const init = keyChanges('init message', now.init, then.init ?? {})
  return {
    fresh: [...options.fresh, ...init.fresh],
    gone: [...options.gone, ...init.gone],
  }
}

function bullets(lines, out) {
  for (const line of lines) out.push(`- ${line}`)
}

function changeSection(title, part, changes, version, out) {
  out.push(`### ${title}`, '')
  if (part.missing) out.push(`Skipped: ${part.missing}.`)
  else if (changes.first) out.push('No snapshot yet; run with `--update`.')
  else if (changes.fresh.length === 0 && changes.gone.length === 0) {
    out.push(`Nothing new since the snapshot of ${version}.`)
  } else {
    bullets(changes.fresh, out)
    if (changes.gone.length > 0) {
      if (changes.fresh.length > 0) out.push('')
      out.push('Removed since the snapshot:', '')
      bullets(changes.gone, out)
    }
  }
  out.push('')
}

async function main() {
  const args = process.argv.slice(2)
  const update = args.includes('--update')
  const sdkAt = args.indexOf('--sdk')
  const chosenSdk = sdkAt >= 0 ? args[sdkAt + 1] : undefined
  if (sdkAt >= 0 && !chosenSdk) throw new Error('--sdk needs a folder')

  const snapshot = existsSync(SNAPSHOT) ? JSON.parse(await readFile(SNAPSHOT, 'utf8')) : {}
  const [codex, claude] = await Promise.all([
    readCodex().catch((error) => ({ missing: `the Codex schema failed: ${error.message}` })),
    readClaude(chosenSdk).catch((error) => ({
      missing: `the SDK's declarations failed: ${error.message}`,
    })),
  ])

  const out = []
  const versions = [
    codex.missing ? 'Codex: missing' : `Codex ${codex.version}`,
    claude.missing ? 'Claude Agent SDK: missing' : `Claude Agent SDK ${claude.version}`,
  ]
  out.push(`# Capabilities: ${versions.join(', ')}`, '')

  out.push('## New since snapshot', '')
  const codexDiff = codex.missing ? {} : codexChanges(codex, snapshot.codex)
  changeSection('Codex', codex, codexDiff, snapshot.codex?.version, out)
  const claudeDiff = claude.missing ? {} : claudeChanges(claude, snapshot.claude)
  changeSection('Claude Agent SDK', claude, claudeDiff, snapshot.claude?.version, out)

  out.push('## Offered but unused by Kite', '')
  out.push('### Codex', '')
  if (codex.missing) out.push(`Skipped: ${codex.missing}.`, '')
  else {
    const names = await sourceNames(CODEX_SOURCES)
    out.push(`Methods that ${CODEX_SOURCES.map(code).join(' and ')} never name:`, '')
    for (const key of Object.keys(UNIONS)) {
      const unused = codex.methods[key].filter((m) => !names.has(m))
      out.push(`- ${UNION_LABELS[key]}s (${unused.length}): ${list(unused) || 'none'}`)
    }
    out.push('', 'Top-level fields of the tracked shapes that the source never names:', '')
    for (const [name, shape] of Object.entries(codex.shapes)) {
      const unused = Object.keys(shape.fields).filter((f) => !f.includes('.') && !names.has(f))
      const top = unused.filter((f) => !/[[<{]/.test(f))
      out.push(`- ${name} (${top.length}): ${list(top) || 'none'}`)
    }
    out.push('')
  }
  out.push('### Claude Agent SDK', '')
  if (claude.missing) out.push(`Skipped: ${claude.missing}.`, '')
  else {
    const declared = await kiteQueryOptions()
    const unusedOptions = Object.keys(claude.options).filter((k) => !declared.has(k))
    out.push(
      `- Options that ${code('QueryOptions')} in ${code(KITE_SDK_TYPES)} does not declare (${unusedOptions.length}): ${list(unusedOptions) || 'none'}`,
    )
    // Kite's SystemMessage has an index signature, so the init fields count as used when named.
    const names = await sourceNames(CLAUDE_SOURCES)
    const unusedInit = Object.keys(claude.init).filter((k) => !names.has(k))
    out.push(
      `- init message fields that ${code(CLAUDE_SOURCES[0])} never names (${unusedInit.length}): ${list(unusedInit) || 'none'}`,
      '',
    )
  }

  if (update) {
    const today = new Date().toISOString().slice(0, 10)
    const next = {
      codex: codex.missing
        ? snapshot.codex
        : { version: codex.version, date: today, methods: codex.methods, shapes: codex.shapes },
      claude: claude.missing
        ? snapshot.claude
        : { version: claude.version, date: today, options: claude.options, init: claude.init },
    }
    await writeFile(SNAPSHOT, `${JSON.stringify(next, null, 2)}\n`)
    out.push(`Snapshot written to ${code(path.relative(ROOT, SNAPSHOT).replaceAll('\\', '/'))}.`)
  }
  process.stdout.write(`${out.join('\n').trimEnd()}\n`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
