import { describe, expect, it } from 'vitest'
import {
  cloneFolderName,
  cloneUrlProblem,
  projectNameProblem,
  safeProjectName,
  withoutUrlCredentials,
} from './project-create'

describe('cloneUrlProblem', () => {
  it('takes https, ssh and scp-like addresses', () => {
    for (const url of [
      'https://github.com/owner/repo.git',
      'https://github.com/owner/repo',
      'https://gitlab.example.com:8443/group/sub/repo.git',
      'https://org@dev.azure.com/org/project/_git/repo',
      'HTTPS://github.com/owner/repo',
      'ssh://git@github.com/owner/repo.git',
      'ssh://git@host.example.com:2222/srv/repo.git',
      'git@github.com:owner/repo.git',
      'git@ssh.dev.azure.com:v3/org/project/repo',
      'deploy.user@host:repo',
    ]) {
      expect(cloneUrlProblem(url), url).toBeNull()
    }
  })

  it('refuses transport helpers, options and other protocols', () => {
    expect(cloneUrlProblem('ext::sh -c touch% /tmp/pwned')).toBe('malformed')
    expect(cloneUrlProblem('ext::sh%20-c%20id')).toBe('scheme')
    expect(cloneUrlProblem('fd::17')).toBe('scheme')
    expect(cloneUrlProblem('https::github.com/owner/repo')).toBe('scheme')
    expect(cloneUrlProblem('-uhttps://github.com/x/y')).toBe('option')
    expect(cloneUrlProblem('--upload-pack=touch /tmp/x')).toBe('malformed')
    expect(cloneUrlProblem('--upload-pack=id')).toBe('option')
    expect(cloneUrlProblem('http://github.com/owner/repo')).toBe('scheme')
    expect(cloneUrlProblem('git://github.com/owner/repo')).toBe('scheme')
    expect(cloneUrlProblem('ftp://host/repo')).toBe('scheme')
    expect(cloneUrlProblem('github.com:owner/repo')).toBe('scheme')
    expect(cloneUrlProblem('owner/repo')).toBe('scheme')
  })

  it('refuses local paths and file URLs', () => {
    for (const url of [
      'file:///srv/git/repo.git',
      'FILE://host/share/repo',
      '/srv/git/repo.git',
      './repo',
      '../repo',
      '~/repo',
      'C:\\repos\\x',
      'C:/repos/x',
      'c:repo',
      '\\\\server\\share\\repo',
    ]) {
      expect(cloneUrlProblem(url), url).toBe('local')
    }
  })

  it('refuses a password in the address', () => {
    expect(cloneUrlProblem('https://ann:hunter2@github.com/owner/repo')).toBe('password')
    expect(cloneUrlProblem('ssh://git:secret@host/repo')).toBe('password')
  })

  it('refuses hosts and users ssh could read as options, and malformed addresses', () => {
    expect(cloneUrlProblem('ssh://-oProxyCommand=id/repo')).toBe('malformed')
    expect(cloneUrlProblem('ssh://-oProxyCommand=id@host/repo')).toBe('malformed')
    expect(cloneUrlProblem('-oProxyCommand=id@host:repo')).toBe('option')
    expect(cloneUrlProblem('git@-oProxyCommand=id:repo')).toBe('scheme')
    expect(cloneUrlProblem('git@host:-repo')).toBe('malformed')
    expect(cloneUrlProblem('https://github.com')).toBe('malformed')
    expect(cloneUrlProblem('https://github.com/')).toBe('malformed')
    expect(cloneUrlProblem('https:///repo')).toBe('malformed')
    expect(cloneUrlProblem('https://host:port/repo')).toBe('malformed')
    expect(cloneUrlProblem('https://host/a b')).toBe('malformed')
    expect(cloneUrlProblem('https://host/repo\n')).toBe('malformed')
    expect(cloneUrlProblem(' https://host/repo')).toBe('malformed')
  })

  it('refuses empty and overlong addresses', () => {
    expect(cloneUrlProblem('')).toBe('empty')
    expect(cloneUrlProblem(`https://host/${'a'.repeat(2048)}`)).toBe('tooLong')
  })
})

describe('withoutUrlCredentials', () => {
  it('takes passwords and HTTPS users out of every address in the text', () => {
    expect(
      withoutUrlCredentials(
        "fatal: Authentication failed for 'https://ann:p@ss@github.com/owner/repo.git/'",
      ),
    ).toBe("fatal: Authentication failed for 'https://github.com/owner/repo.git/'")
    expect(withoutUrlCredentials('https://ghp_token123@github.com/x and http://u:p@h/y')).toBe(
      'https://github.com/x and http://h/y',
    )
    expect(withoutUrlCredentials('ssh://git:secret@host/x')).toBe('ssh://host/x')
  })

  it('keeps an SSH user, which is no secret', () => {
    expect(withoutUrlCredentials('ssh://git@host/x')).toBe('ssh://git@host/x')
    expect(withoutUrlCredentials('git@github.com: Permission denied')).toBe(
      'git@github.com: Permission denied',
    )
  })
})

describe('cloneFolderName', () => {
  it('names the folder after the repository', () => {
    expect(cloneFolderName('https://github.com/Owner/MyRepo.git')).toBe('MyRepo')
    expect(cloneFolderName('https://github.com/owner/repo/')).toBe('repo')
    expect(cloneFolderName('git@github.com:owner/tool.GIT')).toBe('tool')
    expect(cloneFolderName('ssh://git@host:22/srv/x.y.git')).toBe('x.y')
    expect(cloneFolderName('git@host:repo')).toBe('repo')
    expect(cloneFolderName('https://dev.azure.com/org/p/_git/web%20app')).toBe('web%20app')
  })

  it('falls back to a safe name', () => {
    expect(cloneFolderName('https://github.com')).toBe('project')
    expect(cloneFolderName('nonsense')).toBe('project')
    expect(cloneFolderName('https://host/con.git')).toBe('con-project')
  })
})

describe('projectNameProblem', () => {
  it('takes ordinary folder names', () => {
    for (const name of ['app', 'My App', '项目', 'a.b', '-dash', '.hidden']) {
      expect(projectNameProblem(name), name).toBeNull()
    }
  })

  it('refuses separators, traversal and names Windows cannot hold', () => {
    expect(projectNameProblem('')).toBe('empty')
    expect(projectNameProblem('a'.repeat(101))).toBe('tooLong')
    expect(projectNameProblem('a/b')).toBe('chars')
    expect(projectNameProblem('a\\b')).toBe('chars')
    expect(projectNameProblem('..\\..\\x')).toBe('chars')
    expect(projectNameProblem('C:x')).toBe('chars')
    expect(projectNameProblem('a\0b')).toBe('chars')
    expect(projectNameProblem('what?')).toBe('chars')
    expect(projectNameProblem('.')).toBe('dots')
    expect(projectNameProblem('..')).toBe('dots')
    expect(projectNameProblem(' app')).toBe('edge')
    expect(projectNameProblem('app.')).toBe('edge')
    expect(projectNameProblem('CON')).toBe('reserved')
    expect(projectNameProblem('nul.txt')).toBe('reserved')
    expect(projectNameProblem('com1')).toBe('reserved')
  })

  it('agrees with the names it makes safe', () => {
    for (const value of ['a/b', ' x. ', '..', 'con', '', 'a'.repeat(300), 'x:y*z']) {
      expect(projectNameProblem(safeProjectName(value)), value).toBeNull()
    }
  })
})
