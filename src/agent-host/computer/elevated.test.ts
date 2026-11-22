// Huli: the elevated broker of Kite's computer use helper, run here without elevation against a
// stand-in for Cua Driver: who may connect, what passes, and when it ends. Windows only; it builds
// the helper and two small programs with the .NET Framework compiler Windows ships.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { connectPipe, ElevatedDriver, hello, newSecrets, pipePath } from './elevated'
import { ComputerHelper, type ElevateRequest } from './helper'

const root = process.env.SystemRoot ?? 'C:\\Windows'
const csc = path.join(root, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
const runs = process.platform === 'win32' && existsSync(csc)

// Answers every request: the tool and arguments it was called with, as Cua Driver's results look.
const FAKE_DRIVER = `
using System; using System.Collections.Generic; using System.IO; using System.Text;
using System.Web.Script.Serialization;
static class FakeDriver {
  static void Main() {
    var json = new JavaScriptSerializer();
    var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    output.AutoFlush = true;
    string line;
    while ((line = input.ReadLine()) != null) {
      var message = json.DeserializeObject(line) as Dictionary<string, object>;
      if (message == null || !message.ContainsKey("id")) continue;
      object result;
      if ((string)message["method"] == "initialize") {
        result = new Dictionary<string, object> {
          { "protocolVersion", ((Dictionary<string, object>)message["params"])["protocolVersion"] },
          { "capabilities", new Dictionary<string, object> { { "tools", new Dictionary<string, object>() } } },
          { "serverInfo", new Dictionary<string, object> { { "name", "fake" }, { "version", "1" } } } };
      } else {
        var p = message["params"] as Dictionary<string, object>;
        result = new Dictionary<string, object> { { "content", new object[] { new Dictionary<string, object> {
          { "type", "text" }, { "text", "called " + (p == null ? "" : json.Serialize(p)) } } } } };
      }
      output.WriteLine(json.Serialize(new Dictionary<string, object> { { "jsonrpc", "2.0" }, { "id", message["id"] }, { "result", result } }));
    }
  }
}`

// A program with a window that never shows, which prints the window's handle and waits for stdin.
const TARGET = `
using System; using System.Windows.Forms;
static class Target {
  [STAThread] static void Main() {
    var form = new Form();
    Console.WriteLine(form.Handle.ToInt64());
    Console.In.ReadToEnd();
  }
}`

function compile(dir: string, name: string, source: string, references: string[]): string {
  const file = path.join(dir, `${name}.cs`)
  const out = path.join(dir, `${name}.exe`)
  writeFileSync(file, source)
  const result = spawnSync(
    csc,
    ['-nologo', `-out:${out}`, ...references.map((r) => `-r:${r}`), file],
    { encoding: 'utf8' },
  )
  if (result.status !== 0) throw new Error(`${name}: ${result.stdout}${result.stderr}`)
  return out
}

interface Target {
  process: ChildProcess
  pid: number
  window: number
}

function startTarget(exe: string): Promise<Target> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    child.stdout!.setEncoding('utf8')
    child.stdout!.once('data', (text: string) =>
      resolve({ process: child, pid: child.pid!, window: Number(text.trim()) }),
    )
    child.once('error', reject)
  })
}

function exited(child: ChildProcess, withinMs: number): Promise<number | null | 'running'> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('running'), withinMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

describe.skipIf(!runs)('the elevated broker', () => {
  let dir = ''
  let helperExe = ''
  let targetExe = ''
  let sid = ''
  const children: ChildProcess[] = []

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'kite-broker-test-'))
    const build = path.resolve(__dirname, '../../../native/computer-helper/build.mjs')
    const built = spawnSync(process.execPath, [build, dir], { encoding: 'utf8' })
    if (built.status !== 0) throw new Error(built.stdout + built.stderr)
    helperExe = path.join(dir, 'kite-computer-helper.exe')
    compile(dir, 'cua-driver', FAKE_DRIVER, ['System.Web.Extensions.dll'])
    targetExe = compile(dir, 'target', TARGET, ['System.Windows.Forms.dll'])
  }, 60_000)

  beforeAll(async () => {
    const helper = new ComputerHelper({ path: helperExe, log: () => {} })
    sid = (await helper.whoami()).sid!
    helper.stop()
  }, 60_000)

  afterAll(() => {
    for (const child of children) child.kill()
    // The programs take a moment to exit and let go of their files.
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  })

  function broker(request: ElevateRequest): ChildProcess {
    const child = spawn(
      helperExe,
      [
        'broker',
        '--pipe',
        request.pipe,
        '--user',
        request.user,
        '--client',
        String(request.client),
        '--target',
        String(request.target),
        '--token-sha256',
        request.tokenSha256,
        '--idle',
        String(request.idleMs),
      ],
      { stdio: 'ignore', windowsHide: true },
    )
    children.push(child)
    return child
  }

  async function target(): Promise<Target> {
    const started = await startTarget(targetExe)
    children.push(started.process)
    return started
  }

  it('refuses a missing or wrong token, ending after three refusals', async () => {
    const { pid } = await target()
    const secrets = newSecrets()
    const child = broker({
      ...secrets,
      user: sid,
      client: process.pid,
      target: pid,
      idleMs: 20_000,
    })
    const path_ = pipePath(secrets.pipe)
    const wrong = await connectPipe(path_, 10_000)
    await expect(hello(wrong, 'not the token')).rejects.toThrow('wrong token')
    wrong.destroy()
    const missing = await connectPipe(path_, 10_000)
    const answer = await new Promise<string>((resolve) => {
      missing.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')))
      missing.write('{"hello":true}\n')
    })
    expect(JSON.parse(answer)).toEqual({ ok: false, error: 'no token' })
    missing.destroy()
    const third = await connectPipe(path_, 10_000)
    await expect(hello(third, secrets.tokenSha256)).rejects.toThrow('wrong token')
    third.destroy()
    expect(await exited(child, 5_000)).toBe(5)
  }, 30_000)

  it('refuses a client that is not the process Kite named', async () => {
    const { pid } = await target()
    const secrets = newSecrets()
    broker({ ...secrets, user: sid, client: pid, target: pid, idleMs: 20_000 })
    const socket = await connectPipe(pipePath(secrets.pipe), 10_000)
    await expect(hello(socket, secrets.token)).rejects.toThrow('not the expected process')
    socket.destroy()
  }, 30_000)

  it('relays only the approved program’s windows, in the background, and ends with Kite', async () => {
    const approved = await target()
    const other = await target()
    let child: ChildProcess | null = null
    const driver = await ElevatedDriver.start({
      target: approved.pid,
      user: sid,
      log: () => {},
      idleMs: 20_000,
      launch: async (request) => {
        child = broker(request)
        return child.pid ?? null
      },
    })
    expect(driver).not.toBeNull()
    const text = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text
    const own = await driver!.call('get_window_state', {
      pid: approved.pid,
      window_id: approved.window,
    })
    expect(own.isError).toBeFalsy()
    expect(text(own)).toContain('get_window_state')
    const refusals = [
      ['list_windows', { pid: other.pid }],
      ['get_window_state', { pid: approved.pid, window_id: other.window }],
      [
        'click',
        { target: { kind: 'window', pid: approved.pid, window_id: other.window }, x: 1, y: 1 },
      ],
      ['launch_app', { path: 'notepad.exe' }],
      ['run_script', { script: 'x' }],
      [
        'get_window_state',
        { pid: approved.pid, window_id: approved.window, screenshot_out_file: 'C:\\x.png' },
      ],
      [
        'click',
        {
          target: { kind: 'window', pid: approved.pid, window_id: approved.window },
          x: 1,
          y: 1,
          delivery_mode: 'foreground',
        },
      ],
    ] as const
    for (const [tool, args] of refusals) {
      const result = await driver!.call(tool, args as Record<string, unknown>)
      expect(result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true)
      expect(text(result)).toContain('Refused by Kite')
    }
    const click = await driver!.call('click', {
      target: { kind: 'window', pid: approved.pid, window_id: approved.window },
      x: 1,
      y: 1,
      delivery_mode: 'background',
    })
    expect(click.isError).toBeFalsy()
    let closed = false
    driver!.onClosed = () => (closed = true)
    await driver!.stop()
    expect(closed).toBe(true)
    expect(await exited(child!, 5_000)).toBe(0)
  }, 40_000)

  it('ends when the approved program exits, or when idle', async () => {
    const approved = await target()
    const secrets = newSecrets()
    const child = broker({
      ...secrets,
      user: sid,
      client: process.pid,
      target: approved.pid,
      idleMs: 20_000,
    })
    const socket = await connectPipe(pipePath(secrets.pipe), 10_000)
    await hello(socket, secrets.token)
    approved.process.kill()
    expect(await exited(child, 5_000)).toBe(0)
    socket.destroy()

    const idle = await target()
    const quiet = newSecrets()
    const idler = broker({
      ...quiet,
      user: sid,
      client: process.pid,
      target: idle.pid,
      idleMs: 5_000,
    })
    const kept = await connectPipe(pipePath(quiet.pipe), 10_000)
    await hello(kept, quiet.token)
    expect(await exited(idler, 9_000)).toBe(0)
    kept.destroy()
  }, 40_000)
})
