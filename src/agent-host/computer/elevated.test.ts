// Huli: the elevated helper of Kite's computer use, as a test build of it runs without elevation:
// its install, the checks before its broker starts, who may connect, what passes, the owner's
// confirmations, the program's containment and when it ends. Windows only; it builds the helper and
// small stand-in programs with the .NET Framework compiler Windows ships. A test build installs into
// a folder of the test's, starts with no administrator prompt and answers its own windows from
// KITE_BROKER_TEST_ANSWER, logging each question to KITE_BROKER_TEST_LOG.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  closeSync,
  constants,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { connect, ElevatedDriver, newSecrets } from './elevated'
import { ComputerHelper } from './helper'

const root = process.env.SystemRoot ?? 'C:\\Windows'
const csc = path.join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const runs = process.platform === 'win32' && existsSync(csc)
const build = path.resolve(__dirname, '../../../native/computer-helper/build.mjs')
const HELPER = 'kite-computer-helper.exe'

// Answers every request as Cua Driver would: a read gives a snapshot with a button and a field;
// every other call says what it was called with. It writes its process id where its TEMP is.
const FAKE_DRIVER = `
using System; using System.Collections.Generic; using System.IO; using System.Text;
using System.Web.Script.Serialization;
static class FakeDriver {
  static void Main() {
    File.WriteAllText(Path.Combine(Environment.GetEnvironmentVariable("TEMP"), "fake-driver.pid"),
      System.Diagnostics.Process.GetCurrentProcess().Id.ToString());
    var json = new JavaScriptSerializer();
    var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    output.AutoFlush = true;
    string line;
    while ((line = input.ReadLine()) != null) {
      var message = json.DeserializeObject(line) as Dictionary<string, object>;
      if (message == null || !message.ContainsKey("id")) continue;
      object result;
      var p = message.ContainsKey("params") ? message["params"] as Dictionary<string, object> : null;
      if ((string)message["method"] == "initialize") {
        result = new Dictionary<string, object> {
          { "protocolVersion", p["protocolVersion"] },
          { "capabilities", new Dictionary<string, object> { { "tools", new Dictionary<string, object>() } } },
          { "serverInfo", new Dictionary<string, object> { { "name", "fake" }, { "version", "1" } } } };
      } else if (p != null && (string)p["name"] == "get_window_state") {
        var args = p["arguments"] as Dictionary<string, object>;
        var elements = new object[] {
          new Dictionary<string, object> { { "element_index", 0 }, { "role", "Button" }, { "label", "Delete" },
            { "frame", new Dictionary<string, object> { { "x", 10 }, { "y", 10 }, { "w", 40 }, { "h", 20 } } } },
          new Dictionary<string, object> { { "element_index", 1 }, { "role", "Edit" }, { "label", "Name" },
            { "frame", new Dictionary<string, object> { { "x", 10 }, { "y", 40 }, { "w", 80 }, { "h", 20 } } } },
          new Dictionary<string, object> { { "element_index", 2 }, { "role", "MenuItem" }, { "label", "粘贴(&P)" },
            { "frame", new Dictionary<string, object> { { "x", 10 }, { "y", 70 }, { "w", 80 }, { "h", 20 } } } },
        };
        result = new Dictionary<string, object> {
          { "content", new object[] { new Dictionary<string, object> { { "type", "text" }, { "text", "read" } } } },
          { "structuredContent", new Dictionary<string, object> {
            { "snapshot_id", "s00000001" }, { "window_id", args["window_id"] },
            { "window_bounds", new Dictionary<string, object> { { "x", 0 }, { "y", 0 }, { "width", 200 }, { "height", 100 } } },
            { "screenshot_width", 200 }, { "screenshot_height", 100 }, { "elements", elements } } } };
      } else {
        result = new Dictionary<string, object> { { "content", new object[] { new Dictionary<string, object> {
          { "type", "text" }, { "text", "called " + (p == null ? "" : json.Serialize(p)) } } } } };
      }
      output.WriteLine(json.Serialize(new Dictionary<string, object> { { "jsonrpc", "2.0" }, { "id", message["id"] }, { "result", result } }));
    }
  }
}`

// A program with a window that never shows: it prints the window's handle, then on each "spawn"
// line tries to start a program and says whether it could; on "child" it starts one that stays a while.
const TARGET = `
using System; using System.Diagnostics; using System.Windows.Forms;
static class Target {
  [STAThread] static void Main() {
    var form = new Form();
    Console.WriteLine(form.Handle.ToInt64());
    string line;
    Process child = null;
    while ((line = Console.ReadLine()) != null) {
      if (line == "child") {
        child = Process.Start(new ProcessStartInfo(Environment.GetEnvironmentVariable("ComSpec"), "/c ping -n 30 127.0.0.1 >nul") { UseShellExecute = false, CreateNoWindow = true });
        Console.WriteLine("child");
        continue;
      }
      if (line != "spawn") continue;
      try {
        var p = Process.Start(new ProcessStartInfo(Environment.GetEnvironmentVariable("ComSpec"), "/c exit") { UseShellExecute = false, CreateNoWindow = true });
        p.WaitForExit();
        Console.WriteLine("spawned");
      } catch (Exception) { Console.WriteLine("refused"); }
    }
    if (child != null) try { child.Kill(); } catch (Exception) { }
  }
}`

// Writes values into a private registry hive file (RegLoadAppKey), never the user's own registry:
// each argument is subkey\name=value, the subkey's path below the hive's root.
const HIVE = `
using System; using System.Runtime.InteropServices; using Microsoft.Win32; using Microsoft.Win32.SafeHandles;
static class Hive {
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
  static extern int RegLoadAppKeyW(string file, out IntPtr key, int access, int options, int reserved);
  static int Main(string[] args) {
    IntPtr handle;
    int error = RegLoadAppKeyW(args[0], out handle, 0xF003F, 0, 0);
    if (error != 0) { Console.Error.WriteLine("load " + error); return 1; }
    using (var root = RegistryKey.FromHandle(new SafeRegistryHandle(handle, true))) {
      for (int i = 1; i < args.Length; i++) {
        int eq = args[i].IndexOf('=');
        string path = args[i].Substring(0, eq), value = args[i].Substring(eq + 1);
        int slash = path.LastIndexOf('\\\\');
        using (var key = root.CreateSubKey(path.Substring(0, slash))) key.SetValue(path.Substring(slash + 1), value);
      }
    }
    return 0;
  }
}`

function compile(
  dir: string,
  name: string,
  source: string,
  references: string[],
  kind = 'exe',
): string {
  const file = path.join(dir, `${name}.cs`)
  const out = path.join(dir, `${name}.exe`)
  writeFileSync(file, source)
  const result = spawnSync(
    csc,
    ['-nologo', `-target:${kind}`, `-out:${out}`, ...references.map((r) => `-r:${r}`), file],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(`${name}: ${result.stdout}${result.stderr}`)
  return out
}

interface Target {
  process: ChildProcess
  pid: number
  window: number
  lines: string[]
}

function startTarget(exe: string): Promise<Target> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    const lines: string[] = []
    let first = true
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (text: string) => {
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        if (first) {
          first = false
          resolve({ process: child, pid: child.pid!, window: Number(line), lines })
        } else {
          lines.push(line)
        }
      }
    })
    child.once('error', reject)
  })
}

async function spawnFrom(target: Target): Promise<string> {
  const before = target.lines.length
  target.process.stdin!.write('spawn\n')
  for (let i = 0; i < 100 && target.lines.length === before; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return target.lines[before] ?? 'no answer'
}

function exited(pid: number, withinMs: number): Promise<boolean> {
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  return new Promise((resolve) => {
    const end = Date.now() + withinMs
    const check = () => {
      if (!alive()) resolve(true)
      else if (Date.now() > end) resolve(false)
      else setTimeout(check, 100)
    }
    check()
  })
}

const text = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text

/** Waits for the target's next line after it was sent `command`. */
async function ask(target: Target, command: string): Promise<string> {
  const before = target.lines.length
  target.process.stdin!.write(`${command}\n`)
  for (let i = 0; i < 100 && target.lines.length === before; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return target.lines[before] ?? 'no answer'
}

describe.skipIf(!runs)('the elevated helper', () => {
  let work = ''
  let app = ''
  let installDir = ''
  let targetExe = ''
  let hiveExe = ''
  let sid = ''
  let log = ''
  const children: ChildProcess[] = []
  const helpers: ComputerHelper[] = []

  beforeAll(async () => {
    work = mkdtempSync(path.join(tmpdir(), 'kite-elevated-test-'))
    app = path.join(work, 'app')
    installDir = path.join(work, 'Kite Computer Helper')
    mkdirSync(app)
    compile(app, 'cua-driver', FAKE_DRIVER, ['System.Web.Extensions.dll'])
    const built = spawnSync(process.execPath, [build, app, '--test'], { encoding: 'utf8' })
    if (built.status !== 0) throw new Error(built.stdout + built.stderr)
    // A windowed program, as the apps run as administrator are, so it has no console host of its own.
    targetExe = compile(work, 'target', TARGET, ['System.Windows.Forms.dll'], 'winexe')
    hiveExe = compile(work, 'hive', HIVE, [])
    log = path.join(work, 'questions.log')
    const helper = helperFor('allow')
    sid = (await helper.whoami()).sid!
    const state = await helper.install(process.execPath)
    expect(state).toMatchObject({ state: 'current', exitCode: 0 })
  }, 90_000)

  afterEach(() => {
    for (const helper of helpers.splice(0)) helper.stop()
    delete process.env.KITE_HELPER_TEST_HIVE
  })

  afterAll(() => {
    for (const child of children) child.kill()
    // The programs take a moment to exit and let go of their files.
    if (work) rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  })

  /** A helper whose broker answers its windows with `answers`, in turn. */
  function helperFor(
    answers: string,
    dir = installDir,
    exe = path.join(app, HELPER),
  ): ComputerHelper {
    process.env.KITE_BROKER_TEST_ANSWER = answers
    process.env.KITE_BROKER_TEST_LOG = log
    const helper = new ComputerHelper({ path: exe, log: () => {}, installDir: dir })
    helpers.push(helper)
    return helper
  }

  async function target(exe = targetExe): Promise<Target> {
    const started = await startTarget(exe)
    children.push(started.process)
    return started
  }

  /** A copy of the target under another name, as a program of that name would be. */
  async function targetNamed(name: string): Promise<Target> {
    const exe = path.join(work, name)
    if (!existsSync(exe)) copyFileSync(targetExe, exe)
    return target(exe)
  }

  /** A private hive file with these values, for the helper to read in place of the user's registry. */
  function hive(...values: string[]): string {
    const file = path.join(work, `hive-${Math.random().toString(36).slice(2)}.dat`)
    const made = spawnSync(hiveExe, [file, ...values], { encoding: 'utf8' })
    if (made.status !== 0) throw new Error(made.stdout + made.stderr)
    return file
  }

  /** One request to a serve of its own, for the test build's ops, with the environment as it is now. */
  function serve(
    op: string,
    fields: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const child = spawn(path.join(app, HELPER), ['serve'], { stdio: ['pipe', 'pipe', 'ignore'] })
    children.push(child)
    return new Promise((resolve, reject) => {
      let buffer = ''
      child.stdout!.setEncoding('utf8')
      child.stdout!.on('data', (chunk: string) => {
        buffer += chunk
        const end = buffer.indexOf('\n')
        if (end < 0) return
        child.stdin!.end()
        const answer = JSON.parse(buffer.slice(0, end)) as {
          ok: boolean
          result?: unknown
          error?: string
        }
        if (answer.ok) resolve(answer.result as Record<string, unknown>)
        else reject(new Error(answer.error))
      })
      child.once('error', reject)
      child.stdin!.write(`${JSON.stringify({ id: 1, op, ...fields })}\n`)
    })
  }

  /** The test's environment with these variables set, whatever the case of the names it had. */
  function envWith(extra: Record<string, string>): NodeJS.ProcessEnv {
    const names = new Set(Object.keys(extra).map((name) => name.toLowerCase()))
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !names.has(name.toLowerCase())),
    )
    return { ...env, ...extra }
  }

  function questions(): Record<string, unknown>[] {
    if (!existsSync(log)) return []
    return readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  async function request(helper: ComputerHelper, program: Target) {
    const info = await helper.process(program.pid)
    return {
      ...newSecrets(),
      user: sid,
      host: process.pid,
      target: program.pid,
      targetImage: info.image!,
      targetStarted: info.started!,
      idleMs: 20_000,
      lang: 'en' as const,
    }
  }

  async function start(answers: string, program: Target) {
    const helper = helperFor(answers)
    return ElevatedDriver.start({
      target: program.pid,
      user: sid,
      helper,
      installDir,
      lang: 'en',
      log: () => {},
      testBuild: true,
      idleMs: 20_000,
    })
  }

  it('installs only a driver that matches the build, keeps an install across updates, and knows a changed one', async () => {
    const helper = helperFor('allow')
    expect(await helper.layout(process.execPath)).toMatchObject({ state: 'current' })
    // Another Kite program is another client.
    expect(await helper.layout(targetExe)).toMatchObject({ state: 'outdated' })
    const swapped = path.join(work, 'swapped')
    mkdirSync(swapped)
    copyFileSync(path.join(app, HELPER), path.join(swapped, HELPER))
    copyFileSync(targetExe, path.join(swapped, 'cua-driver.exe'))
    const other = helperFor('allow', path.join(work, 'other'), path.join(swapped, HELPER))
    await expect(other.install(process.execPath)).rejects.toThrow(
      'not the one this helper was built with',
    )
    expect(existsSync(path.join(work, 'other'))).toBe(false)

    // An update brings a helper built anew, of the same protocol: the install stays current, so
    // no administrator prompt comes with it.
    const updated = path.join(work, 'updated')
    mkdirSync(updated)
    copyFileSync(path.join(app, 'cua-driver.exe'), path.join(updated, 'cua-driver.exe'))
    const rebuilt = spawnSync(process.execPath, [build, updated, '--test'], { encoding: 'utf8' })
    if (rebuilt.status !== 0) throw new Error(rebuilt.stdout + rebuilt.stderr)
    const newer = helperFor('allow', installDir, path.join(updated, HELPER))
    expect(await newer.layout(process.execPath)).toMatchObject({ state: 'current' })

    // A file that is not the one the install recorded makes it unusable.
    const changed = path.join(work, 'changed')
    const own = helperFor('allow', changed)
    expect(await own.install(process.execPath)).toMatchObject({ state: 'current', exitCode: 0 })
    writeFileSync(path.join(changed, 'cua-driver.exe'), 'not the driver')
    expect(await own.layout(process.execPath)).toMatchObject({ state: 'tampered' })
    const program = await target()
    await expect(own.elevate(await request(own, program))).rejects.toThrow('changed')
    expect(await own.uninstall()).toMatchObject({ state: 'missing' })
    expect(existsSync(changed)).toBe(false)

    // The elevated command itself wrote the record: the protocol, both hashes and Kite's program.
    const [protocol, helperSha, driverSha, client] = readFileSync(
      path.join(installDir, 'install.txt'),
      'ascii',
    )
      .trim()
      .split(' ')
    expect(protocol).toBe('2')
    expect(helperSha).toMatch(/^[0-9a-f]{64}$/)
    expect(driverSha).toMatch(/^[0-9a-f]{64}$/)
    expect(Buffer.from(client!, 'hex').toString('utf8')).toBe(process.execPath)

    // A copy that fails on one file, here the newer helper over a locked one, records what should
    // have landed: what is there reads tampered, now and later, whatever the copy's exit code.
    const locked = path.join(work, 'locked')
    expect(await helperFor('allow', locked).install(process.execPath)).toMatchObject({
      state: 'current',
    })
    // libuv's UV_FS_O_EXLOCK: opened with no sharing, so robocopy cannot replace it.
    const hold = openSync(path.join(locked, HELPER), constants.O_RDONLY | 0x10000000)
    let failed: Awaited<ReturnType<ComputerHelper['install']>>
    try {
      failed = await helperFor('allow', locked, path.join(updated, HELPER)).install(
        process.execPath,
      )
    } finally {
      closeSync(hold)
    }
    expect(failed).toMatchObject({ state: 'tampered' })
    expect(failed!.exitCode).not.toBe(0)
    expect(await helperFor('allow', locked).layout(process.execPath)).toMatchObject({
      state: 'tampered',
    })
  }, 90_000)

  it('tells a folder only administrators can change from one others can', async () => {
    const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    await expect(serve('protected', { path: system32 })).resolves.toEqual({ protected: true })
    await expect(serve('protected', { path: work })).resolves.toEqual({ protected: false })
  })

  it('starts no broker without a current install, for a program that starts programs, or one with programs of its own running', async () => {
    const program = await target()
    const empty = helperFor('allow', path.join(work, 'empty'))
    await expect(empty.elevate(await request(empty, program))).rejects.toThrow('not installed')
    const helper = helperFor('allow')
    for (const name of ['taskmgr.exe', 'python3.12.exe', 'node.exe']) {
      const launcher = await targetNamed(name)
      await expect(helper.elevate(await request(helper, launcher)), name).rejects.toThrow(
        'starts other programs',
      )
    }
    const parent = await target()
    expect(await ask(parent, 'child')).toBe('child')
    await expect(helper.elevate(await request(helper, parent))).rejects.toThrow(
      'programs of its own running',
    )
  }, 40_000)

  it('names the approved program only by the image Windows gives, exactly', async () => {
    const program = await target()
    const helper = helperFor('allow')
    const exact = await request(helper, program)
    // Forms that only normalize to the image.
    for (const image of [`${exact.targetImage}.`, `${exact.targetImage} `]) {
      await expect(helper.elevate({ ...exact, targetImage: image })).rejects.toThrow(
        'not the program that was approved',
      )
    }
  }, 30_000)

  it('starts nothing while a .NET setting would load code into it, wherever it is set', async () => {
    const program = await target()
    for (const name of ['COR_PROFILER_PATH', 'complus_KiteTest', 'DOTNET_EnableEventPipe']) {
      process.env[name] = '1'
      let helper: ComputerHelper
      try {
        helper = helperFor('allow')
        await helper.whoami()
      } finally {
        delete process.env[name]
      }
      await expect(helper.elevate(await request(helper, program)), name).rejects.toThrow(name)
      await expect(helper.install(process.execPath), name).rejects.toThrow(name)
    }
    // Removal runs no .NET program, so no such setting stops it.
    const removable = path.join(work, 'removable')
    expect(await helperFor('allow', removable).install(process.execPath)).toMatchObject({
      state: 'current',
    })
    process.env.DOTNET_EnableEventPipe = '1'
    try {
      expect(await helperFor('allow', removable).uninstall()).toMatchObject({ state: 'missing' })
    } finally {
      delete process.env.DOTNET_EnableEventPipe
    }
    // The SDK's own variables reach no .NET Framework program.
    process.env.DOTNET_CLI_TELEMETRY_OPTOUT = '1'
    try {
      await expect(serve('guard')).resolves.toEqual({ unsafe: null })
    } finally {
      delete process.env.DOTNET_CLI_TELEMETRY_OPTOUT
    }
  }, 40_000)

  it('reads the user’s environment, its volatile part with each session’s and the runtime’s own settings', async () => {
    const cases: [string[], string | null][] = [
      [['Environment\\DOTNET_NOLOGO=1', 'Volatile Environment\\USERNAME=me'], null],
      [['Volatile Environment\\1\\SESSIONNAME=Console'], null],
      [['Environment\\COR_PROFILER={0}'], 'HKCU\\Environment'],
      [['Volatile Environment\\COR_ENABLE_PROFILING=1'], 'HKCU\\Volatile Environment'],
      [['Volatile Environment\\2\\COMPlus_AltJitName=x.dll'], 'HKCU\\Volatile Environment\\2'],
      [['Software\\Microsoft\\.NETFramework\\AltJit=*'], 'NETFramework'],
      [['Environment\\windir=C:\\Users\\x'], 'windir'],
      [['Volatile Environment\\1\\SystemRoot=C:\\Users\\x'], 'SystemRoot'],
      [['Environment\\APPDOMAIN_MANAGER_ASM=x'], 'APPDOMAIN_MANAGER_ASM'],
      [['Volatile Environment\\APPDOMAIN_MANAGER_TYPE=x'], 'APPDOMAIN_MANAGER_TYPE'],
      // Overrides of what Windows' administrator prompt runs for a program.
      [['Software\\Classes\\exefile\\shell\\runas\\command\\=cmd.exe /c x'], 'Classes\\exefile'],
      // Keys an app may leave there that change no verb: the class key passed makes them moot.
      [['Software\\Classes\\.exe\\x=1'], null],
      [['Software\\Classes\\exefile\\DefaultIcon\\=x'], null],
    ]
    for (const [values, found] of cases) {
      process.env.KITE_HELPER_TEST_HIVE = hive(...values)
      const { unsafe } = (await serve('guard')) as { unsafe: string | null }
      if (found === null) expect(unsafe, values.join()).toBeNull()
      else expect(unsafe, values.join()).toContain(found)
    }
  }, 40_000)

  it('runs no broker with a code-loading variable or another Windows folder in its own environment', () => {
    const exe = path.join(installDir, HELPER)
    const run = (extra: Record<string, string>) =>
      spawnSync(exe, ['broker'], { env: envWith(extra) }).status
    // Names the runtime itself reads before Main stop it there: COMPlus_AltJit alone already does.
    expect(run({ COMPlus_KiteTest: '1' })).toBe(17)
    expect(run({ COR_PROFILER: '{0}' })).toBe(17)
    expect(run({ CORECLR_PROFILER: 'x' })).toBe(17)
    expect(run({ windir: 'C:\\Users\\Public' })).toBe(17)
    // With a clean environment it goes on, to its own arguments.
    expect(run({})).toBe(2)
    // It reads the user's registry again itself, as written while the prompt was open.
    expect(run({ KITE_HELPER_TEST_HIVE: hive('Volatile Environment\\1\\COR_PROFILER={0}') })).toBe(
      17,
    )
    expect(run({ KITE_HELPER_TEST_HIVE: hive('Software\\Classes\\exefile\\shell\\x=1') })).toBe(17)
  })

  it('holds the staged copy so nothing can change it until the copy is done', async () => {
    // One serve for both requests: its held files go with it.
    const child = spawn(path.join(app, HELPER), ['serve'], { stdio: ['pipe', 'pipe', 'ignore'] })
    children.push(child)
    const lines: string[] = []
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => lines.push(...chunk.split('\n').filter(Boolean)))
    const send = async (id: number, op: string, fields: Record<string, unknown> = {}) => {
      const mine = (line: string) => line.startsWith(`{"id":${id},`)
      child.stdin!.write(`${JSON.stringify({ id, op, ...fields })}\n`)
      for (let i = 0; i < 200 && !lines.some(mine); i++) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return (JSON.parse(lines.find(mine)!) as { result: { dir?: string } }).result
    }
    const dir = (await send(1, 'stage', { client: process.execPath })).dir!
    const helper = path.join(dir, HELPER)
    expect(readFileSync(helper).length).toBeGreaterThan(0)
    expect(() => writeFileSync(helper, 'x')).toThrow()
    expect(() => rmSync(path.join(dir, 'cua-driver.exe'))).toThrow()
    expect(() => renameSync(dir, `${dir}-moved`)).toThrow()
    await send(2, 'unstage')
    expect(existsSync(dir)).toBe(false)
    child.stdin!.end()
  }, 30_000)

  it('serves only the program that was approved, by its start time and image', async () => {
    const program = await target()
    const helper = helperFor('allow')
    const secrets = newSecrets()
    const exact = await request(helper, program)
    const launcher = await helper.elevate({
      ...exact,
      ...secrets,
      targetStarted: String(BigInt(exact.targetStarted) - 10_000_000n),
    })
    const exe = path.join(installDir, HELPER)
    await expect(
      connect(
        exe,
        ['--pipe', secrets.pipe, '--launcher', String(launcher), '--install-dir', installDir],
        secrets.token,
        30_000,
      ),
    ).rejects.toThrow('could not be reached')
  }, 40_000)

  it('refuses a missing or wrong token and a client of its own, ending after three', async () => {
    const program = await target()
    const helper = helperFor('allow')
    const secrets = newSecrets()
    const launcher = await helper.elevate({ ...(await request(helper, program)), ...secrets })
    const exe = path.join(installDir, HELPER)
    const args = [
      '--pipe',
      secrets.pipe,
      '--launcher',
      String(launcher),
      '--install-dir',
      installDir,
    ]
    await expect(connect(exe, args, 'not the token', 20_000)).rejects.toThrow('wrong token')
    // A client that is not the installed helper started by the host is refused before its token.
    const direct = net.connect(`\\\\.\\pipe\\${secrets.pipe}`)
    const answer = await new Promise<string>((resolve) => {
      direct.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')))
      direct.once('error', () => resolve('error'))
    })
    expect(answer).toContain('not the expected program')
    direct.destroy()
    await expect(connect(exe, args, secrets.tokenSha256, 20_000)).rejects.toThrow('wrong token')
    await expect(connect(exe, args, secrets.token, 10_000)).rejects.toThrow()
  }, 60_000)

  it('connects only to the broker its prompt’s launcher started', async () => {
    const exe = path.join(installDir, HELPER)
    // A pipe of the test's own process: neither the launcher itself nor a child of another program
    // will do, and a child of its parent is no installed helper.
    const pipe = newSecrets().pipe
    const squatter = net.createServer((socket) => socket.end()).listen(`\\\\.\\pipe\\${pipe}`)
    await new Promise((resolve) => squatter.once('listening', resolve))
    const unrelated = await target()
    const tried: [number, string][] = [
      [process.pid, 'not served by the helper Kite started'],
      [unrelated.pid, 'not served by the helper Kite started'],
      [process.ppid, 'not served by the installed helper'],
    ]
    for (const [launcher, why] of tried) {
      await expect(
        connect(
          exe,
          ['--pipe', pipe, '--launcher', String(launcher), '--install-dir', installDir],
          'x',
          20_000,
        ),
      ).rejects.toThrow(why)
    }
    squatter.close()
  }, 40_000)

  it('starts only when the owner allows it in its window, naming the program and who asks', async () => {
    const program = await target()
    await expect(start('deny', program)).rejects.toThrow('the user did not allow it')
    const asked = questions().filter((q) => q.kind === 'start')
    expect(asked.at(-1)).toMatchObject({ kind: 'start', pid: program.pid, askerPid: process.pid })
    expect(String(asked.at(-1)?.target).toLowerCase()).toBe(targetExe.toLowerCase())
    expect(String(asked.at(-1)?.asker).toLowerCase()).toBe(process.execPath.toLowerCase())
  }, 30_000)

  it('relays only the approved program’s windows, in the background, as it checked them', async () => {
    const approved = await target()
    const other = await target()
    const driver = await start('allow', approved)
    expect(driver).not.toBeNull()
    const own = await driver!.call('get_window_state', {
      pid: approved.pid,
      window_id: approved.window,
    })
    expect(own.isError).toBeFalsy()
    const window = { kind: 'window', pid: approved.pid, window_id: approved.window }
    const refusals: [string, Record<string, unknown>][] = [
      ['list_windows', { pid: other.pid }],
      ['get_window_state', { pid: approved.pid, window_id: other.window }],
      [
        'click',
        { target: { ...window, window_id: other.window }, x: 1, y: 1, delivery_mode: 'background' },
      ],
      ['launch_app', { path: 'notepad.exe' }],
      ['run_script', { script: 'x' }],
      [
        'get_window_state',
        { pid: approved.pid, window_id: approved.window, screenshot_out_file: 'C:\\x.png' },
      ],
      ['get_window_state', { pid: approved.pid, window_id: approved.window, max_depth: 'deep' }],
      ['click', { target: window, x: 1, y: 1, delivery_mode: 'foreground' }],
      ['click', { target: window, x: 1, y: 1, button: 7, delivery_mode: 'background' }],
      ['scroll', { target: window, x: 1, y: 1, direction: 'down' }],
      [
        'scroll',
        { target: window, x: 1, y: 1, direction: 'sideways', delivery_mode: 'background' },
      ],
      ['press_key', { target: window, key: ' return', delivery_mode: 'background' }],
      ['press_key', { target: window, key: 'tab', modifiers: 'ctrl', delivery_mode: 'background' }],
    ]
    for (const [tool, args] of refusals) {
      const result = await driver!.call(tool, args)
      expect(result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true)
      expect(text(result)).toContain('Refused by Kite')
    }
    const scrolled = await driver!.call('scroll', {
      target: window,
      x: 1,
      y: 1,
      direction: 'down',
      delivery_mode: 'background',
    })
    expect(text(scrolled)).toContain('"name":"scroll"')
    await driver!.stop()
  }, 40_000)

  it('passes on what it checked, not the line it was sent', async () => {
    const program = await target()
    const helper = helperFor('allow')
    const secrets = newSecrets()
    const launcher = await helper.elevate({ ...(await request(helper, program)), ...secrets })
    const exe = path.join(installDir, HELPER)
    const { child } = await connect(
      exe,
      ['--pipe', secrets.pipe, '--launcher', String(launcher), '--install-dir', installDir],
      secrets.token,
    )
    children.push(child)
    const lines: string[] = []
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => lines.push(...chunk.split('\n').filter(Boolean)))
    // The same key twice: whatever the broker reads is what the driver gets, never the other.
    child.stdin.write(
      `{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"launch_app","name":"list_windows","arguments":{"pid":${program.pid}}}}\n`,
    )
    child.stdin.write(
      `{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"list_windows","arguments":{"pid":${program.pid}},"task":{"x":1}}}\n`,
    )
    child.stdin.write(
      `{"jsonrpc":"2.0","id":9,"method":"initialize","params":{"protocolVersion":"1","capabilities":{"sampling":{}},"clientInfo":{"name":"x","version":"1"}}}\n`,
    )
    child.stdin.write(
      `{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"list_windows","arguments":{"pid":${program.pid}},"_meta":{"progressToken":1,"other":2}}}\n`,
    )
    for (let i = 0; i < 100 && lines.length < 4; i++)
      await new Promise((resolve) => setTimeout(resolve, 50))
    expect(lines.join('\n')).not.toContain('launch_app')
    for (const id of [8, 9, 10]) {
      expect(lines.find((line) => line.includes(`"id":${id}`))).toContain('Refused by Kite')
    }
    child.kill()
  }, 30_000)

  it('ends on an id that could alias another', async () => {
    const program = await target()
    const list = `"name":"list_windows","arguments":{"pid":${program.pid}}`
    // Raw JSON lines: a fraction, and a lone surrogate and the replacement character it turns into
    // on the way: string ids are printable ASCII alone.
    const lines = [
      `{"jsonrpc":"2.0","id":5.1,"method":"tools/call","params":{${list}}}`,
      `{"jsonrpc":"2.0","id":"\\ud800","method":"tools/call","params":{${list}}}`,
      `{"jsonrpc":"2.0","id":"\\ufffd","method":"tools/call","params":{${list}}}`,
    ]
    for (const line of lines) {
      const helper = helperFor('allow')
      const secrets = newSecrets()
      const launcher = await helper.elevate({ ...(await request(helper, program)), ...secrets })
      const { child, pid } = await connect(
        path.join(installDir, HELPER),
        ['--pipe', secrets.pipe, '--launcher', String(launcher), '--install-dir', installDir],
        secrets.token,
      )
      children.push(child)
      child.stdin.write(`${line}\n`)
      expect(await exited(pid, 5_000), line).toBe(true)
    }
  }, 60_000)

  it('ends when a request uses an id again, so no answer stands for another', async () => {
    const program = await target()
    const helper = helperFor('allow')
    const secrets = newSecrets()
    const launcher = await helper.elevate({ ...(await request(helper, program)), ...secrets })
    const exe = path.join(installDir, HELPER)
    const { child, pid } = await connect(
      exe,
      ['--pipe', secrets.pipe, '--launcher', String(launcher), '--install-dir', installDir],
      secrets.token,
    )
    children.push(child)
    child.stdin.write(
      `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"list_windows","arguments":{"pid":${program.pid}}}}\n`,
    )
    child.stdin.write('{"jsonrpc":"2.0","id":5,"method":"ping"}\n')
    expect(await exited(pid, 5_000)).toBe(true)
  }, 30_000)

  it('asks the owner before every step but harmless ones, listing what went through unasked', async () => {
    const program = await target()
    const driver = await start('allow', program)
    const window = { kind: 'window', pid: program.pid, window_id: program.window }
    const background = { target: window, delivery_mode: 'background' }
    await driver!.call('get_window_state', { pid: program.pid, window_id: program.window })
    const before = questions().length
    const harmless: [string, Record<string, unknown>][] = [
      ['scroll', { ...background, x: 5, y: 5, direction: 'down' }],
      ['press_key', { ...background, key: 'tab' }],
      ['click', { ...background, element_token: 's00000001:1' }],
      ['type_text', { ...background, text: 'name' }],
    ]
    for (const [tool, args] of harmless) {
      expect((await driver!.call(tool, args)).isError, tool).toBeFalsy()
    }
    expect(questions()).toHaveLength(before)
    const risky: [string, Record<string, unknown>, string][] = [
      ['click', { ...background, element_token: 's00000001:0' }, 'click'],
      ['click', { ...background, element_token: 's00000001:1', button: 'right' }, 'right-click'],
      ['click', { ...background, element_token: 's00000001:1', count: 2 }, 'double-click'],
      ['click', { ...background, x: 20, y: 20 }, 'click'],
      // Typing no longer follows a click into the field, so it is asked.
      ['type_text', { ...background, text: 'plain' }, 'type'],
      ['press_key', { ...background, key: 'return' }, 'key'],
      ['hotkey', { ...background, keys: ['ctrl', 's'] }, 'key'],
      ['type_text', { ...background, text: 'del *\n\u202Eexe.txt' }, 'type'],
      ['type_text', { ...background, text: 'a\tb' }, 'type'],
      ['drag', { ...background, from_x: 1, from_y: 1, to_x: 9, to_y: 9 }, 'drag'],
      [
        'invoke_menu',
        {
          pid: program.pid,
          window_id: program.window,
          path: ['File', 'Open'],
          delivery_mode: 'background',
        },
        'menu',
      ],
    ]
    for (const [tool, args] of risky) {
      expect((await driver!.call(tool, args)).isError, tool).toBeFalsy()
    }
    const asked = questions().slice(before)
    expect(asked.map((q) => q.step)).toEqual(risky.map(([, , kind]) => kind))
    expect(asked[0]).toMatchObject({ text: 'Delete', role: 'Button', places: 1 })
    // The first question lists the four steps that went through without one.
    expect(asked[0]!.since).toEqual([
      'Scrolled down 3',
      'Pressed tab',
      'Clicked “Name” (Edit)',
      'Typed “name”',
    ])
    expect(asked[1]!.since).toEqual([])
    // Typed text is shown in full, its line breaks, tabs and direction marks made visible.
    expect(asked[7]!.details).toContain('del *⏎')
    expect(asked[7]!.details).toContain('⟦U+202E⟧exe.txt')
    expect(asked[8]!.details).toContain('a⇥b')
    expect(asked[9]).toMatchObject({ step: 'drag', places: 2 })

    const refused: [string, Record<string, unknown>, string][] = [
      ['click', { ...background, element_token: 's00000001:9' }, 'no place'],
      ['click', { ...background, element_token: 's00000001:1', x: 1, y: 1 }, 'not both'],
      ['click', { ...background, x: 5000, y: 5000 }, 'no place'],
      ['hotkey', { ...background, keys: ['ctrl', 'v'] }, 'never pastes'],
      ['press_key', { ...background, key: 'insert', modifiers: ['shift'] }, 'never pastes'],
      ['type_text', { ...background, text: 'x'.repeat(1001) }, 'longer than 1000'],
      // Paste by a menu or a click on an element named so, in any of the covered languages.
      [
        'invoke_menu',
        {
          pid: program.pid,
          window_id: program.window,
          path: ['Edit', 'Paste'],
          delivery_mode: 'background',
        },
        'never pastes',
      ],
      [
        'invoke_menu',
        {
          pid: program.pid,
          window_id: program.window,
          path: ['编辑', '粘贴(&P)'],
          delivery_mode: 'background',
        },
        'never pastes',
      ],
      [
        'invoke_menu',
        {
          pid: program.pid,
          window_id: program.window,
          path: ['Bearbeiten', 'Einfügen'],
          delivery_mode: 'background',
        },
        'never pastes',
      ],
      ['click', { ...background, element_token: 's00000001:2' }, 'never pastes'],
      ...[
        ['Editar', 'Colar'],
        ['Правка', 'Вставить'],
        ['Bewerken', 'Plakken'],
        ['Edycja', 'Wklej'],
        ['Düzen', 'Yapıştır'],
        ['Redigera', 'Klistra in'],
        ['編集', '貼付け(&P)'],
        ['편집', '붙여 넣기'],
      ].map((path): [string, Record<string, unknown>, string] => [
        'invoke_menu',
        { pid: program.pid, window_id: program.window, path, delivery_mode: 'background' },
        'never pastes',
      ]),
      // A control character is a command to a field: U+0016 pastes.
      ['type_text', { ...background, text: 'a\u0016' }, 'control character'],
      ['type_text', { ...background, text: '\u0085' }, 'control character'],
    ]
    const count = questions().length
    for (const [tool, args, why] of refused) {
      const result = await driver!.call(tool, args)
      expect(result.isError, tool).toBe(true)
      expect(text(result), tool).toContain(why)
    }
    expect(questions()).toHaveLength(count)

    // Typing goes unasked only into the field just clicked: not with another element's token.
    await driver!.call('click', { ...background, element_token: 's00000001:1' })
    const quiet = questions().length
    await driver!.call('type_text', { ...background, text: 'a', element_token: 's00000001:1' })
    expect(questions()).toHaveLength(quiet)
    await driver!.call('type_text', { ...background, text: 'y', element_token: 's00000001:0' })
    expect(questions().at(-1)).toMatchObject({ step: 'type' })

    // An open context menu or menu bar takes a letter, Enter or a click by a point as its item:
    // they are refused until a click by element or Escape.
    for (const opener of [
      ['click', { ...background, element_token: 's00000001:1', button: 'right' }],
      ['press_key', { ...background, key: 'f10', modifiers: ['shift'] }],
      ['press_key', { ...background, key: 'menu' }],
      ['press_key', { ...background, key: 'menu', modifiers: ['shift'] }],
      ['press_key', { ...background, key: 'alt' }],
      ['press_key', { ...background, key: 'f10' }],
      ['hotkey', { ...background, keys: ['alt', 'e'] }],
    ] as [string, Record<string, unknown>][]) {
      expect((await driver!.call(...opener)).isError, JSON.stringify(opener)).toBeFalsy()
      for (const [tool, args] of [
        ['press_key', { ...background, key: 'p' }],
        ['press_key', { ...background, key: 'return' }],
        ['type_text', { ...background, text: 'p' }],
        ['click', { ...background, x: 20, y: 20 }],
      ] as [string, Record<string, unknown>][]) {
        expect(
          text(await driver!.call(tool, args)),
          `${JSON.stringify(opener)} then ${tool}`,
        ).toContain('menu bar is open')
      }
      expect((await driver!.call('press_key', { ...background, key: 'down' })).isError).toBeFalsy()
      expect(text(await driver!.call('press_key', { ...background, key: 'p' }))).toContain(
        'menu bar is open',
      )
      expect(
        (await driver!.call('press_key', { ...background, key: 'escape' })).isError,
      ).toBeFalsy()
      expect(text(await driver!.call('press_key', { ...background, key: 'p' }))).not.toContain(
        'menu bar is open',
      )
    }
    await driver!.stop()
  }, 90_000)

  it('ends once the owner said no to three steps', async () => {
    const program = await target()
    const driver = await start('allow,deny', program)
    const background = {
      target: { kind: 'window', pid: program.pid, window_id: program.window },
      delivery_mode: 'background',
    }
    let closed = false
    driver!.onClosed = () => (closed = true)
    for (let i = 0; i < 3; i++) {
      const result = await driver!.call('press_key', { ...background, key: 'return' })
      expect(text(result)).toContain('the user did not allow this step')
    }
    expect(await exited(driver!.brokerPid, 5_000)).toBe(true)
    for (let i = 0; i < 50 && !closed; i++) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(closed).toBe(true)
  }, 40_000)

  it('keeps the program from starting programs while it runs, and lets it after', async () => {
    const program = await target()
    expect(await spawnFrom(program)).toBe('spawned')
    const driver = await start('allow', program)
    expect(await spawnFrom(program)).toBe('refused')
    await driver!.stop()
    for (let i = 0; i < 40 && (await spawnFrom(program)) !== 'spawned'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    expect(await spawnFrom(program)).toBe('spawned')
  }, 40_000)

  it('ends with the program, when idle, and takes the driver with it', async () => {
    const program = await target()
    const driver = await start('allow', program)
    const pid = Number(
      readFileSync(path.join(installDir, 'home', 'Temp', 'fake-driver.pid'), 'utf8'),
    )
    let closed = false
    driver!.onClosed = () => (closed = true)
    program.process.kill()
    expect(await exited(driver!.brokerPid, 5_000)).toBe(true)
    expect(await exited(pid, 5_000)).toBe(true)
    for (let i = 0; i < 50 && !closed; i++) await new Promise((resolve) => setTimeout(resolve, 50))
    expect(closed).toBe(true)

    const idle = await target()
    const helper = helperFor('allow')
    const quiet = await ElevatedDriver.start({
      target: idle.pid,
      user: sid,
      helper,
      installDir,
      lang: 'en',
      log: () => {},
      testBuild: true,
      idleMs: 5_000,
    })
    expect(await exited(quiet!.brokerPid, 9_000)).toBe(true)
  }, 40_000)
})
