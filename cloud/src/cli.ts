// The `huli-cloud` command line, read strictly: each command takes only the few arguments below,
// none of them a secret, and anything else is refused. Passwords and two-step codes are typed at
// the terminal when asked, never on the command line, where the shell's history and the process
// list would keep them; invite codes are made by the service and shown once.

import { INVITE_DAYS, MAX_INVITE_DAYS, normalizeUsername } from './store'

export type Command =
  | { name: 'serve' }
  | { name: 'init'; force: boolean }
  | { name: 'passwd' }
  | { name: 'totp' }
  | { name: 'signout-all'; username: string | null }
  | { name: 'user-list' }
  | { name: 'user-invite'; days: number }
  | { name: 'user-uninvite'; id: string }
  | { name: 'user-disable' | 'user-enable' | 'user-remove'; username: string }
  | { name: 'user-reset'; username: string; days: number }

export const USAGE = `用法：huli-cloud <命令>
  serve                          运行服务
  init [--force]                 建机主账号（--force 重建，机主的设备都会退出登录）
  passwd | totp                  改机主的密码 | 重新绑定机主的两步验证并换恢复码
  signout-all [用户名]           让一个账号（默认机主）的所有设备退出登录
  user list                      列出账号和邀请码
  user invite [--days N]         新建邀请码（默认 ${INVITE_DAYS} 天，最多 ${MAX_INVITE_DAYS} 天）
  user uninvite <编号>           撤销还没用的邀请码
  user disable|enable <用户名>   停用 | 启用账号
  user remove <用户名>           删除账号和它的一切（设备、电脑、推送）
  user reset <用户名> [--days N] 让账号退出登录、清掉密码和两步验证，给一个重设用的邀请码
密码和验证码都在运行后按提示输入，不放在命令行里。`

const INVITE_ID = /^[A-Za-z0-9_-]{4,16}$/

/** `--days N` or `--days=N` at the end of `rest`, or the default; null for anything else. */
function days(rest: string[]): number | null {
  if (rest.length === 0) return INVITE_DAYS
  const text =
    rest.length === 2 && rest[0] === '--days'
      ? rest[1]!
      : rest.length === 1 && rest[0]!.startsWith('--days=')
        ? rest[0]!.slice('--days='.length)
        : null
  if (text === null || !/^\d{1,2}$/.test(text)) return null
  const n = Number(text)
  return n >= 1 && n <= MAX_INVITE_DAYS ? n : null
}

/** The command `argv` names, with its arguments; null for anything that is not one. */
export function parseCommand(argv: readonly string[]): Command | null {
  const [command = 'serve', ...rest] = argv
  switch (command) {
    case 'serve':
      return rest.length === 0 ? { name: 'serve' } : null
    case 'init':
      if (rest.length === 0) return { name: 'init', force: false }
      return rest.length === 1 && rest[0] === '--force' ? { name: 'init', force: true } : null
    case 'passwd':
    case 'totp':
      return rest.length === 0 ? { name: command } : null
    case 'signout-all': {
      if (rest.length === 0) return { name: 'signout-all', username: null }
      const username = rest.length === 1 ? normalizeUsername(rest[0]!) : null
      return username ? { name: 'signout-all', username } : null
    }
    case 'user':
      break
    default:
      return null
  }
  const [action, ...args] = rest
  switch (action) {
    case 'list':
      return args.length === 0 ? { name: 'user-list' } : null
    case 'invite': {
      const n = days(args)
      return n === null ? null : { name: 'user-invite', days: n }
    }
    case 'uninvite':
      return args.length === 1 && INVITE_ID.test(args[0]!)
        ? { name: 'user-uninvite', id: args[0]! }
        : null
    case 'disable':
    case 'enable':
    case 'remove': {
      const username = args.length === 1 ? normalizeUsername(args[0]!) : null
      return username ? { name: `user-${action}`, username } : null
    }
    case 'reset': {
      const username = args.length >= 1 ? normalizeUsername(args[0]!) : null
      const n = days(args.slice(1))
      return username && n !== null ? { name: 'user-reset', username, days: n } : null
    }
    default:
      return null
  }
}
