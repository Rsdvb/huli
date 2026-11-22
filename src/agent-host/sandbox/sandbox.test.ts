import { describe, expect, it } from 'vitest'
import { forbiddenToDevices } from '@shared/remote/allow-list'
import {
  containerSupport,
  nativeSupport,
  resolveSandbox,
  sandboxChoiceOf,
  supportsChoice,
  agentSandboxSupport,
} from '@shared/sandbox'
import { parseProjectsFile, parseSessionsFile, type SessionRecord } from '../storage'
import { createValidators } from '../validate'
import {
  agentCommand,
  containerLimits,
  egressArgs,
  engineName,
  findEngine,
  installArgs,
  mapPaths,
  runArgs,
  type ContainerRun,
  type Exec,
} from './container'
import { modelHosts } from './model-hosts'
import { folderProblem, MountError, projectMount, type MountContext } from './mounts'
import { claudeSandbox, codexPolicy, codexWindowsReady, type SessionSandbox } from './native'

const WIN: Omit<MountContext, 'realpath'> = {
  platform: 'win32',
  home: 'C:\\Users\\dvb',
  dataDir: 'C:\\Users\\dvb\\AppData\\Roaming\\Huli',
}
const LINUX: Omit<MountContext, 'realpath'> = {
  platform: 'linux',
  home: '/home/dvb',
  dataDir: '/home/dvb/.config/Huli',
}
const MAC: Omit<MountContext, 'realpath'> = {
  platform: 'darwin',
  home: '/Users/dvb',
  dataDir: '/Users/dvb/Library/Application Support/Huli',
}

describe('the folders a container may mount', () => {
  it('takes a project folder and refuses the rest on Windows', () => {
    const cases: [string, ReturnType<typeof folderProblem>][] = [
      ['E:\\dvb\\desktop\\proj', null],
      ['C:\\Users\\dvb\\code\\proj', null],
      ['C:\\', 'root'],
      ['E:\\', 'root'],
      ['\\\\server\\share', 'root'],
      ['\\\\server\\share\\proj', null],
      ['C:\\Users\\dvb', 'home'],
      ['c:\\users\\DVB\\', 'home'],
      ['C:\\Users', 'aboveHome'],
      ['C:\\Users\\Public', 'aboveHome'],
      ['C:\\Windows\\System32', 'system'],
      ['D:\\Program Files\\App', 'system'],
      ['C:\\ProgramData\\x', 'system'],
      ['C:\\Users\\dvb\\.ssh', 'credentials'],
      ['C:\\Users\\dvb\\.SSH\\keys', 'credentials'],
      ['C:\\Users\\dvb\\AppData\\Local\\Temp\\x', 'credentials'],
      ['C:\\Users\\dvb\\.claude\\projects', 'credentials'],
      ['C:\\Users\\dvb\\AppData\\Roaming\\Huli\\scratch\\a', 'kiteData'],
      ['C:\\Users\\dvb\\AppData\\Roaming', 'kiteData'],
      ['E:\\proj\\..\\other', 'dotSegments'],
      ['E:\\proj\\.\\x', 'dotSegments'],
      ['\\\\?\\C:\\proj', 'devicePath'],
      ['\\\\.\\PhysicalDrive0', 'devicePath'],
      ['proj', 'notAbsolute'],
      ['\\proj', 'notAbsolute'],
      ['E:proj', 'notAbsolute'],
      ['E:\\proj:stream', 'badCharacters'],
      ['E:\\a,b', 'badCharacters'],
      ['E:\\a"b', 'badCharacters'],
      ['E:\\a\nb', 'badCharacters'],
      ['E:\\$(x)', 'badCharacters'],
    ]
    for (const [folder, problem] of cases)
      expect([folder, folderProblem(folder, WIN)]).toEqual([folder, problem])
  })

  it('refuses the root, the home folder, the system and the key folders on Linux and macOS', () => {
    const linux: [string, ReturnType<typeof folderProblem>][] = [
      ['/home/dvb/code/proj', null],
      ['/tmp/proj', null],
      ['/srv/x', 'system'],
      ['/', 'root'],
      ['/home/dvb', 'home'],
      ['/home/dvb/', 'home'],
      ['/home', 'aboveHome'],
      ['/etc', 'system'],
      ['/usr/local/src/proj', 'system'],
      ['/var/lib/docker', 'system'],
      ['/root/proj', 'system'],
      ['/proc/1', 'system'],
      ['/home/dvb/.ssh', 'credentials'],
      ['/home/dvb/.config/gh', 'credentials'],
      ['/home/dvb/.docker', 'credentials'],
      ['/home/dvb/code/../.ssh', 'dotSegments'],
      ['relative/proj', 'notAbsolute'],
      ['/home/dvb/a,b', 'badCharacters'],
    ]
    for (const [folder, problem] of linux) {
      expect([folder, folderProblem(folder, LINUX)]).toEqual([folder, problem])
    }
    expect(folderProblem('/Users/dvb/code/proj', MAC)).toBeNull()
    expect(folderProblem('/private/tmp/proj', MAC)).toBeNull()
    expect(folderProblem('/Users', MAC)).toBe('aboveHome')
    expect(folderProblem('/Users/dvb/Library/Keychains', MAC)).toBe('credentials')
    expect(folderProblem('/System/Library', MAC)).toBe('system')
    expect(folderProblem('/Volumes/Data', MAC)).toBe('root')
    expect(folderProblem('/Volumes/Data/proj', MAC)).toBeNull()
  })

  it('judges where links lead, so a link cannot reach a folder kept out', async () => {
    const links: Record<string, string> = {
      'E:\\link-to-windows': 'C:\\Windows',
      'E:\\link-to-home': 'C:\\Users\\dvb',
      'E:\\link-to-keys': 'C:\\Users\\dvb\\.ssh',
      'E:\\proj': 'E:\\proj',
      'C:\\Users\\dvb': 'C:\\Users\\dvb',
      'C:\\Users\\dvb\\AppData\\Roaming\\Huli': 'C:\\Users\\dvb\\AppData\\Roaming\\Huli',
    }
    const ctx: MountContext = {
      ...WIN,
      realpath: async (folder) => {
        const real = links[folder]
        if (!real) throw new Error('ENOENT')
        return real
      },
    }
    await expect(projectMount('E:\\proj', ctx)).resolves.toBe('E:\\proj')
    for (const [folder, problem] of [
      ['E:\\link-to-windows', 'system'],
      ['E:\\link-to-home', 'home'],
      ['E:\\link-to-keys', 'credentials'],
      ['E:\\gone', 'missing'],
      ['C:\\Users\\dvb', 'home'],
    ] as const) {
      const error = await projectMount(folder, ctx).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(MountError)
      expect((error as MountError).problem).toBe(problem)
    }
    // A home folder that is itself a link is compared both as written and as it really is.
    const linked: MountContext = {
      ...LINUX,
      realpath: async (folder) =>
        folder === '/home/dvb'
          ? '/data/home/dvb'
          : folder === '/srv2/p'
            ? '/data/home/dvb'
            : folder,
    }
    const error = await projectMount('/srv2/p', linked).catch((e: unknown) => e)
    expect((error as MountError).problem).toBe('home')
  })
})

const RUN: ContainerRun = {
  name: 'kite-sbx-s1-12345678',
  owner: 'abcdef0123456789',
  project: '/mnt/e/proj',
  gitDir: true,
  network: { kind: 'egress', name: 'kite-sbx-net-s1-12345678' },
  user: '1000:1000',
  home: 'kite-sandbox-home-gemini-12345678',
  env: ['GEMINI_API_KEY'],
  cpus: 8,
  memoryMb: 8192,
  command: ['node', '/tools/x/index.js'],
}

describe("a session's container", () => {
  it('runs with no capability, on a network with no way out, and only the project writable', () => {
    const args = runArgs(RUN)
    const pairs = (flag: string): string[] =>
      args.flatMap((word, i) => (word === flag ? [args[i + 1]!] : []))
    expect(args.slice(0, 4)).toEqual(['run', '--rm', '-i', '--init'])
    expect(pairs('--network')).toEqual(['kite-sbx-net-s1-12345678'])
    expect(pairs('--cap-drop')).toEqual(['ALL'])
    expect(pairs('--security-opt')).toEqual(['no-new-privileges'])
    expect(args).toContain('--read-only')
    expect(pairs('--user')).toEqual(['1000:1000'])
    expect(pairs('--mount')).toEqual([
      'type=bind,source=/mnt/e/proj,target=/workspace',
      'type=bind,source=/mnt/e/proj/.git,target=/workspace/.git,readonly',
      'type=volume,source=kite-sandbox-tools,target=/tools,readonly',
      'type=volume,source=kite-sandbox-home-gemini-12345678,target=/home/node',
    ])
    // A key goes in by name: its value never reaches the command line. The proxy variables name
    // the egress proxy, the only way out.
    const proxy = 'http://kite-egress:3128'
    expect(pairs('-e')).toEqual([
      'HOME=/home/node',
      `HTTP_PROXY=${proxy}`,
      `http_proxy=${proxy}`,
      `HTTPS_PROXY=${proxy}`,
      `https_proxy=${proxy}`,
      `ALL_PROXY=${proxy}`,
      `all_proxy=${proxy}`,
      'NO_PROXY=localhost,127.0.0.1',
      'no_proxy=localhost,127.0.0.1',
      'NODE_USE_ENV_PROXY=1',
      'GEMINI_API_KEY',
    ])
    for (const word of args) {
      expect(word).not.toMatch(
        /docker\.sock|--privileged|^-v$|^--volume$|--pid=host|--network=host/,
      )
    }
    expect(args.slice(-2)).toEqual(RUN.command)
  })

  it('opens the network only when asked, and mounts no .git that is not there', () => {
    const args = runArgs({ ...RUN, network: { kind: 'open' }, gitDir: false, env: [] })
    expect(args[args.indexOf('--network') + 1]).toBe('bridge')
    expect(args.filter((word) => word.includes('.git'))).toEqual([])
    expect(args.filter((word) => word === '-e')).toHaveLength(1)
  })

  it('refuses names and folders a command line could be bent with', () => {
    expect(() => runArgs({ ...RUN, name: 'kite;rm -rf' })).toThrow()
    expect(() => runArgs({ ...RUN, home: '../home' })).toThrow()
    expect(() => runArgs({ ...RUN, project: '/mnt/e/a,readonly=false,target=/etc' })).toThrow()
    expect(() => runArgs({ ...RUN, agentFolder: '/x\n--privileged' })).toThrow()
    expect(() =>
      runArgs({ ...RUN, network: { kind: 'egress', name: 'host --privileged' } }),
    ).toThrow()
    expect(engineName('kite-sbx', 'Session/../ID 1')).toMatch(
      /^kite-sbx-session-[a-z0-9_.-]+-id-1-[0-9a-f]{8}$/,
    )
  })

  it('installs only an npm package by its name and version', () => {
    const agent = {
      kind: 'package' as const,
      agentId: 'gemini',
      package: '@google/gemini-cli',
      version: '0.70.0',
      args: ['--acp'],
    }
    const args = installArgs(agent, 'owner', '1000:1000')
    expect(args.slice(-1)).toEqual(['@google/gemini-cli@0.70.0'])
    expect(args).not.toContain('--network')
    expect(args.join(' ')).not.toMatch(/\/workspace/)
    for (const bad of ['x;rm -rf /', '../x', 'X', '@a/b/c']) {
      expect(() => installArgs({ ...agent, package: bad }, 'owner', '1000:1000')).toThrow()
    }
    expect(() => installArgs({ ...agent, version: '1.0 && rm' }, 'owner', '1000:1000')).toThrow()
    const command = agentCommand(agent)
    expect(command.slice(0, 3)).toEqual(['node', '--input-type=module', '-e'])
    expect(command[4]).toMatch(
      /^\/tools\/agent-gemini-[0-9a-f]{8}\/0\.70\.0\/node_modules\/@google\/gemini-cli$/,
    )
    expect(command.slice(5)).toEqual(['--acp'])
  })

  it("runs the egress proxy with nothing mounted, its tunnel on the engine's loopback alone", () => {
    const allow = egressArgs({
      name: 'kite-sbx-egress-s1-1',
      network: 'kite-sbx-net-s1-1',
      owner: 'o',
      user: '1000:1000',
      mode: 'allow',
      allow: ['api.example.com', '*.example.org:8443', 'bad rule', 'x,y'],
    })
    // The words after a flag, up to the image: `node -e` runs the proxy's source after it.
    const pairs = (args: string[], flag: string): string[] => {
      const image = args.findIndex((word) => word.startsWith('docker.io/'))
      return args.slice(0, image).flatMap((word, i) => (word === flag ? [args[i + 1]!] : []))
    }
    expect(pairs(allow, '--network')).toEqual(['bridge'])
    expect(pairs(allow, '--cap-drop')).toEqual(['ALL'])
    expect(allow).toContain('--read-only')
    expect(allow.filter((word) => word === '--mount' || word === '-p')).toEqual([])
    expect(pairs(allow, '-e')).toEqual([
      'KITE_EGRESS_MODE=allow',
      'KITE_EGRESS_ALLOW=api.example.com,*.example.org:8443',
    ])
    const tunnel = egressArgs({
      name: 'kite-sbx-egress-s1-1',
      network: 'kite-sbx-net-s1-1',
      owner: 'o',
      user: '1000:1000',
      mode: 'tunnel',
      allow: ['api.example.com'],
    })
    expect(pairs(tunnel, '-p')).toEqual(['127.0.0.1::7000'])
    // The token comes by name, never on the command line.
    expect(pairs(tunnel, '-e')).toEqual([
      'KITE_EGRESS_MODE=tunnel',
      'KITE_EGRESS_ALLOW=',
      'KITE_EGRESS_TOKEN',
    ])
    expect(() =>
      egressArgs({ name: 'a b', network: 'n', owner: 'o', user: 'u', mode: 'allow', allow: [] }),
    ).toThrow()
  })

  it("names the model's addresses from the harness and the base addresses Kite hands it", () => {
    expect(modelHosts('gemini', {})).toContain('generativelanguage.googleapis.com')
    expect(modelHosts('opencode', {})).toEqual([])
    expect(
      modelHosts('qwen', {
        OPENAI_BASE_URL: 'https://gateway.example.com:8443/v1',
        OTHER_URL: 'https://not-a-base.example.com',
        ANTHROPIC_BASE_URL: 'not a url',
        DEEPSEEK_API_BASE: 'ftp://files.example.com',
      }),
    ).toEqual([
      'dashscope.aliyuncs.com',
      'dashscope-intl.aliyuncs.com',
      'chat.qwen.ai',
      'portal.qwen.ai',
      'gateway.example.com:8443',
    ])
  })

  it('takes half the cores and memory, at most 8 GB', () => {
    expect(containerLimits(32, 64 * 1024 ** 3)).toEqual({ cpus: 16, memoryMb: 8192 })
    expect(containerLimits(4, 8 * 1024 ** 3)).toEqual({ cpus: 2, memoryMb: 4096 })
    expect(containerLimits(1, 1024 ** 3)).toEqual({ cpus: 1, memoryMb: 1024 })
  })

  it('names the project as the container does and back, and nothing else', () => {
    const out = mapPaths(
      {
        cwd: 'E:\\dvb\\Proj',
        files: ['e:\\dvb\\proj\\src\\a.ts', 'E:\\dvb\\project2\\b.ts', 'see E:\\dvb\\proj'],
        uri: 'file:///E:/dvb/Proj/src/a.ts',
        n: 3,
      },
      'E:\\dvb\\Proj',
      '/workspace',
      'win32',
    )
    expect(out).toEqual({
      cwd: '/workspace',
      files: ['/workspace/src/a.ts', 'E:\\dvb\\project2\\b.ts', 'see E:\\dvb\\proj'],
      uri: 'file:///workspace/src/a.ts',
      n: 3,
    })
    expect(
      mapPaths(
        { path: '/workspace/src/a.ts', other: '/workspaces/x', uri: 'file:///workspace/b' },
        '/workspace',
        'E:\\dvb\\Proj',
        'win32',
      ),
    ).toEqual({
      path: 'E:\\dvb\\Proj\\src\\a.ts',
      other: '/workspaces/x',
      uri: 'file:///E:/dvb/Proj/b',
    })
    expect(mapPaths({ p: '/home/u/proj/x' }, '/home/u/proj', '/workspace', 'linux')).toEqual({
      p: '/workspace/x',
    })
    // Linux compares with case.
    expect(mapPaths({ p: '/home/u/Proj/x' }, '/home/u/proj', '/workspace', 'linux')).toEqual({
      p: '/home/u/Proj/x',
    })
  })
})

describe('the container engine', () => {
  const answers =
    (table: Record<string, string | Error>): Exec =>
    async (file, args) => {
      const answer = table[[file, ...args].join(' ')]
      if (answer === undefined || answer instanceof Error) throw answer ?? new Error('not found')
      return { stdout: answer, stderr: '' }
    }
  const only = (files: string[]) => async (file: string) => files.includes(file)
  const env = { PATH: 'C:\\bin', PATHEXT: '.EXE' }

  it('takes Docker, else Docker inside WSL, and tells a stopped engine from none', async () => {
    const version = 'version --format {{.Server.Version}}'
    expect(
      await findEngine({
        platform: 'win32',
        env,
        exec: answers({ [`C:\\bin\\docker.exe ${version}`]: '29.1.0\n' }),
        isExecutable: only(['C:\\bin\\docker.exe']),
      }),
    ).toEqual({
      kind: 'docker',
      command: 'C:\\bin\\docker.exe',
      prefix: [],
      version: '29.1.0',
      user: '1000:1000',
    })
    const wsl = await findEngine({
      platform: 'win32',
      env,
      exec: answers({
        [`C:\\bin\\wsl.exe -e docker ${version}`]: '29.9.0',
        'C:\\bin\\wsl.exe -e id -u': '1000',
        'C:\\bin\\wsl.exe -e id -g': '1000',
      }),
      isExecutable: only(['C:\\bin\\docker.exe', 'C:\\bin\\wsl.exe']),
    })
    expect(wsl).toMatchObject({ kind: 'wsl-docker', prefix: ['-e', 'docker'], version: '29.9.0' })
    expect(
      await findEngine({
        platform: 'linux',
        env: { PATH: '/bin' },
        exec: answers({}),
        isExecutable: only(['/bin/docker']),
      }),
    ).toEqual({ problem: 'notRunning' })
    expect(
      await findEngine({
        platform: 'linux',
        env: { PATH: '/bin' },
        exec: answers({}),
        isExecutable: only([]),
      }),
    ).toEqual({ problem: 'notFound' })
  })
})

const SANDBOX: SessionSandbox = {
  tier: 'native',
  network: 'none',
  roots: ['/home/dvb/proj-wt', '/home/dvb/proj'],
  proxyPort: null,
  gitWritable: false,
}

describe("the harnesses' own sandboxes", () => {
  it('gives Claude Code a sandbox that fails closed and has no way around it', () => {
    const option = claudeSandbox(SANDBOX, '/home/dvb', 'linux')
    expect(option).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      filesystem: { allowWrite: ['/home/dvb/proj-wt', '/home/dvb/proj'] },
      network: { allowedDomains: [], strictAllowlist: true },
    })
    expect(option.filesystem.denyRead).toEqual(
      expect.arrayContaining(['/home/dvb/.ssh', '/home/dvb/.aws', '/home/dvb/.config/gh']),
    )
    expect(claudeSandbox(SANDBOX, 'C:\\Users\\dvb', 'win32').filesystem.denyRead).toContain(
      'C:\\Users\\dvb\\.ssh',
    )
    expect(
      claudeSandbox({ ...SANDBOX, network: 'agent', proxyPort: 7891 }, '/h', 'linux').network,
    ).toEqual({
      httpProxyPort: 7891,
      socksProxyPort: 7891,
    })
    expect(() => claudeSandbox({ ...SANDBOX, network: 'agent' }, '/h', 'linux')).toThrow()
    expect(claudeSandbox({ ...SANDBOX, network: 'open' }, '/h', 'linux').network).toEqual({})
    // Its commands may not write the project's .git unless the user lets the sandbox commit.
    expect(option.filesystem.denyWrite).toEqual(['/home/dvb/proj-wt/.git', '/home/dvb/proj/.git'])
    const committing = claudeSandbox({ ...SANDBOX, gitWritable: true }, '/h', 'linux')
    expect(committing.filesystem.denyWrite).toBeUndefined()
  })

  it("holds Codex's turns to the project, and never to full access", () => {
    const write = {
      type: 'workspaceWrite' as const,
      writableRoots: [],
      networkAccess: true,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    }
    expect(codexPolicy(write, SANDBOX)).toEqual({
      type: 'workspaceWrite',
      writableRoots: ['/home/dvb/proj-wt', '/home/dvb/proj'],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    })
    expect(codexPolicy({ type: 'readOnly', networkAccess: true }, SANDBOX)).toEqual({
      type: 'readOnly',
      networkAccess: false,
    })
    expect(codexPolicy(write, { ...SANDBOX, network: 'open' })).toMatchObject({
      networkAccess: true,
    })
    expect(() => codexPolicy({ type: 'dangerFullAccess' }, SANDBOX)).toThrow()
    expect(() => codexPolicy(write, { ...SANDBOX, network: 'agent', proxyPort: 1 })).toThrow()
    expect(codexWindowsReady({ status: 'ready' })).toBe('ready')
    expect(codexWindowsReady({ status: 'notConfigured' })).toBe('notConfigured')
    expect(codexWindowsReady({})).toBeNull()
    expect(codexWindowsReady(null)).toBeNull()
  })
})

describe('sandbox choices', () => {
  it('reads only known tiers and networks, and off holds nothing back', () => {
    expect(sandboxChoiceOf({ tier: 'native', network: 'none' })).toEqual({
      tier: 'native',
      network: 'none',
    })
    expect(sandboxChoiceOf({ tier: 'off', network: 'none' })).toEqual({
      tier: 'off',
      network: 'open',
    })
    // Each tier's strictest stands for the other's: a container keeps its model, and the harness's
    // own sandbox never held the model's calls.
    expect(sandboxChoiceOf({ tier: 'container', network: 'none' })).toEqual({
      tier: 'container',
      network: 'model',
    })
    expect(sandboxChoiceOf({ tier: 'native', network: 'model' })).toEqual({
      tier: 'native',
      network: 'none',
    })
    for (const bad of [
      null,
      'native',
      [],
      { tier: 'vm', network: 'none' },
      { tier: 'native' },
      { tier: 'native', network: 'some' },
    ]) {
      expect(sandboxChoiceOf(bad)).toBeNull()
    }
  })

  it('takes the asked choice, else the project, else the default, which is off', () => {
    const project = { tier: 'container' as const, network: 'model' as const }
    const settings = { tier: 'native' as const, network: 'open' as const }
    expect(resolveSandbox(undefined, undefined, undefined)).toEqual({
      tier: 'off',
      network: 'open',
    })
    expect(resolveSandbox(undefined, null, settings)).toEqual(settings)
    expect(resolveSandbox(undefined, project, settings)).toEqual(project)
    expect(resolveSandbox({ tier: 'off', network: 'open' }, project, settings)).toEqual({
      tier: 'off',
      network: 'open',
    })
  })

  it('offers each tier only where it runs, with the networks it can hold', () => {
    expect(nativeSupport('claude-code', 'win32')).toEqual({
      available: true,
      networks: ['none', 'agent', 'open'],
      setup: 'claudeWindows',
    })
    expect(nativeSupport('codex', 'win32')).toMatchObject({
      available: true,
      networks: ['none', 'open'],
    })
    expect(nativeSupport('gemini', 'darwin')).toMatchObject({ available: false, block: 'notWired' })
    expect(nativeSupport('opencode', 'linux')).toMatchObject({
      available: false,
      block: 'noSandbox',
    })
    expect(nativeSupport('claude-code', 'freebsd')).toMatchObject({
      available: false,
      block: 'platform',
    })
    expect(containerSupport('other', 'win32')).toMatchObject({
      available: false,
      block: 'protocol',
    })
    expect(containerSupport('acp-package', 'win32', ['api.example.com'])).toMatchObject({
      available: true,
      networks: ['model', 'agent', 'open'],
      modelHosts: ['api.example.com'],
    })
    // Without the model's addresses, "only the model" would leave the agent nothing.
    expect(containerSupport('acp-package', 'win32')).toMatchObject({ networks: ['agent', 'open'] })
    const gemini = agentSandboxSupport('gemini', 'acp-package', 'win32', modelHosts('gemini', {}))
    expect(supportsChoice(gemini, { tier: 'container', network: 'model' })).toBe(true)
    expect(supportsChoice(gemini, { tier: 'container', network: 'agent' })).toBe(true)
    expect(supportsChoice(gemini, { tier: 'container', network: 'none' })).toBe(false)
    expect(supportsChoice(gemini, { tier: 'native', network: 'none' })).toBe(false)
    expect(supportsChoice(gemini, { tier: 'off', network: 'open' })).toBe(true)
  })
})

describe('sandbox requests and what is stored', () => {
  const posix = createValidators('darwin')
  const rejects = (run: () => unknown): void => {
    expect(run).toThrow(expect.objectContaining({ code: 'invalid_params' }))
  }

  it('takes a sandbox of known values only, at the start, for a project and between turns', () => {
    const create = posix['sessions.create']
    const choice = { tier: 'container', network: 'model' }
    expect(create({ agentId: 'gemini', projectPath: '/p', sandbox: choice })).toEqual({
      agentId: 'gemini',
      projectPath: '/p',
      sandbox: choice,
    })
    for (const sandbox of [
      null,
      'container',
      { tier: 'vm', network: 'none' },
      { ...choice, image: 'x' },
    ]) {
      rejects(() => create({ agentId: 'gemini', projectPath: '/p', sandbox }))
      rejects(() => posix['sessions.prepare']({ agentId: 'gemini', projectPath: '/p', sandbox }))
    }
    const project = posix['projects.setSandbox']
    expect(project({ path: '/p', sandbox: null })).toEqual({ path: '/p', sandbox: null })
    expect(project({ path: '/p', sandbox: choice })).toEqual({ path: '/p', sandbox: choice })
    rejects(() => project({ path: '/p' }))
    rejects(() => project({ path: 'p', sandbox: choice }))
    const set = posix['sessions.setSandbox']
    expect(set({ sessionId: 's', sandbox: { tier: 'off', network: 'none' } })).toEqual({
      sessionId: 's',
      sandbox: { tier: 'off', network: 'open' },
    })
    rejects(() => set({ sessionId: 's', sandbox: null }))
    rejects(() => posix['sandbox.pullImage']({ image: 'evil/image' }))
  })

  it('leaves what holds an agent back to the computer, never to a paired device', () => {
    for (const method of [
      'projects.setSandbox',
      'sessions.setSandbox',
      'sandbox.containerStatus',
      'sandbox.pullImage',
      'sandbox.removeImage',
    ]) {
      expect(forbiddenToDevices(method, {})).toBe(true)
    }
    const sandbox = { tier: 'off', network: 'open' }
    expect(
      forbiddenToDevices('sessions.create', { agentId: 'a', projectPath: '/p', sandbox }),
    ).toBe(true)
    expect(
      forbiddenToDevices('sessions.prepare', { agentId: 'a', projectPath: '/p', sandbox }),
    ).toBe(true)
    expect(forbiddenToDevices('sessions.create', { agentId: 'a', projectPath: '/p' })).toBe(false)
  })

  it('keeps a stored choice, and never reads one it cannot as no sandbox', () => {
    const session: SessionRecord = {
      id: 's1',
      agentId: 'gemini',
      acpSessionId: 'a1',
      projectPath: '/repo',
      title: null,
      createdAt: 1,
      updatedAt: 2,
      lastViewedAt: null,
      parentId: null,
      origin: 'user',
      description: null,
      branch: null,
    }
    const read = (extra: Record<string, unknown>) =>
      parseSessionsFile({ sessions: [{ ...session, ...extra }] })
    const sandbox = { tier: 'container', network: 'model' }
    expect(read({ sandbox })).toEqual({ version: 1, sessions: [{ ...session, sandbox }] })
    expect(read({ sandbox: { tier: 'vm', network: 'none' } })).toEqual({
      version: 1,
      sessions: [{ ...session, sandboxUnknown: true }],
    })
    expect(read({ sandboxUnknown: true })).toEqual({
      version: 1,
      sessions: [{ ...session, sandboxUnknown: true }],
    })
    expect(read({})).toEqual({ version: 1, sessions: [session] })
    const project = { path: '/repo', name: 'repo', addedAt: 1, lastOpenedAt: 2 }
    expect(parseProjectsFile({ projects: [{ ...project, sandbox }] })).toEqual({
      version: 1,
      projects: [{ ...project, sandbox }],
    })
    expect(parseProjectsFile({ projects: [{ ...project, sandbox: 'container' }] })).toEqual({
      version: 1,
      projects: [project],
    })
  })
})
