// A command line's steps as the shell that runs it reads them, for judging what each step touches.
// Wider than command-safety's `commandSteps`, which refuses anything but plain words: this also
// reads redirections to files, the duplications and null device that only drop output, and
// wildcards. Anything it cannot read the same way the shell does is null, which counts as high.

/** The shell a command line runs in: a POSIX shell, PowerShell, or Windows' cmd.exe. */
export type ShellKind = 'posix' | 'powershell' | 'cmd'

export interface Word {
  text: string
  /** Holds a wildcard that the shell, or the command itself, expands into file names. */
  glob: boolean
}

export interface Redirect {
  /** `>` writes the file, `>>` appends to it, `<` reads it. */
  op: '>' | '>>' | '<'
  target: string
}

export interface Step {
  words: Word[]
  /** The files the step's redirections write or read; duplications and the null device are left out. */
  redirects: Redirect[]
}

/** Whether a redirection's target only drops what is written to it. */
function nullDevice(target: string, shell: ShellKind): boolean {
  const key = target.toLowerCase()
  if (shell === 'posix') return target === '/dev/null'
  return key === 'nul' || key === 'nul:' || (shell === 'powershell' && key === '$null')
}

/**
 * The steps of `command`, split on `&&`, `||`, `;` and `|` (and a lone `&` in cmd.exe), as words
 * without their quotes, with each step's redirections apart. Null for expansions, subshells,
 * groups, background jobs, here-documents, comments, line breaks, unterminated quotes, a
 * redirection without a plain target and empty steps.
 */
export function shellSteps(command: string, shell: ShellKind): Step[] | null {
  const steps: Step[] = []
  let words: Word[] = []
  let redirects: Redirect[] = []
  let word: Word | null = null
  // A redirection still waiting for its target.
  let pending: { op: Redirect['op'] } | null = null
  let failed = false

  const append = (text: string, glob = false): void => {
    word = word ? { text: word.text + text, glob: word.glob || glob } : { text, glob }
  }
  const endWord = (): void => {
    if (word === null) return
    const done: Word = word
    word = null
    if (pending) {
      if (done.glob || done.text === '') failed = true
      else if (!nullDevice(done.text, shell)) {
        redirects.push({ op: pending.op, target: done.text })
      }
      pending = null
      return
    }
    words.push(done)
  }
  const endStep = (): boolean => {
    endWord()
    if (pending || words.length === 0) return false
    steps.push({ words, redirects })
    words = []
    redirects = []
    return true
  }
  /** Starts a redirection, taking a word of digits (or `*` in PowerShell) before it as its stream. */
  const redirect = (op: Redirect['op']): boolean => {
    const before = word as Word | null
    const stream =
      before !== null &&
      !before.glob &&
      (/^\d+$/.test(before.text) || (shell === 'powershell' && before.text === '*'))
    if (stream) word = null
    else endWord()
    if (pending) return false
    pending = { op }
    return true
  }

  for (let i = 0; i < command.length; i++) {
    if (failed) return null
    const c = command[i]!
    const next = command[i + 1]
    if (c === ' ' || c === '\t') {
      endWord()
      continue
    }
    if (c < ' ' || c === '\x7f') return null
    if (shell === 'powershell' && c === '*' && next === '>') {
      // `*>` redirects every stream, PowerShell's alone.
      endWord()
      word = { text: '*', glob: false }
      continue
    }
    if (c === "'" && shell !== 'cmd') {
      const close = command.indexOf("'", i + 1)
      if (close === -1) return null
      const text = command.slice(i + 1, close)
      if (/[\p{Cc}]/u.test(text)) return null
      // PowerShell's cmdlets expand wildcards in a quoted path too.
      append(text, shell === 'powershell' && /[*?[]/.test(text))
      i = close
      continue
    }
    if (c === '"') {
      let text = ''
      let j = i + 1
      for (; j < command.length && command[j] !== '"'; j++) {
        const d = command[j]!
        const escaped = command[j + 1]
        if (shell === 'posix' && d === '\\' && escaped !== undefined && '$`"\\'.includes(escaped)) {
          text += escaped
          j++
        } else if (d < ' ' || d === '\x7f') {
          return null
        } else if (shell === 'posix' && (d === '$' || d === '`' || d === '!')) {
          return null
        } else if (shell === 'powershell' && (d === '$' || d === '`')) {
          return null
        } else if (shell === 'cmd' && (d === '%' || d === '!')) {
          return null
        } else {
          text += d
        }
      }
      if (j >= command.length) return null
      append(text, shell !== 'posix' && /[*?[]/.test(text))
      i = j
      continue
    }
    if (c === '\\' && shell === 'posix') {
      if (next === undefined || next < ' ') return null
      append(next)
      i++
      continue
    }
    if (c === '>') {
      const append2 = next === '>'
      if (!redirect(append2 ? '>>' : '>')) return null
      if (append2) i++
      const after = command[i + 1]
      if (after === '&') {
        // A duplication such as `2>&1` or `>&-`, which writes no file.
        const rest = /^&(\d+|-)/.exec(command.slice(i + 1))
        if (!rest) return null
        pending = null
        i += rest[0].length
      } else if (after === '|' && shell === 'posix') {
        i++
      } else if (after === '(' || after === '>' || after === '<') {
        return null
      }
      continue
    }
    if (c === '<') {
      if (shell === 'powershell') return null
      if (next === '<' || next === '>' || next === '(') return null
      if (!redirect('<')) return null
      if (next === '&') {
        const rest = /^&(\d+|-)/.exec(command.slice(i + 1))
        if (!rest) return null
        pending = null
        i += rest[0].length
      }
      continue
    }
    if (shell === 'powershell' && c === '$' && pending) {
      // `2>$null` drops a stream; any other variable is an expansion.
      if (command.slice(i, i + 5).toLowerCase() !== '$null' || /\w/.test(command[i + 5] ?? '')) {
        return null
      }
      endWord()
      word = { text: '$null', glob: false }
      i += 4
      continue
    }
    if (c === '&' || c === '|' || c === ';') {
      if (c === '&') {
        if (next === '&') i++
        else if (shell === 'posix' && next === '>') {
          // `&>` and `&>>` send both streams to a file.
          endWord()
          if (pending) return null
          const twice = command[i + 2] === '>'
          pending = { op: twice ? '>>' : '>' }
          i += twice ? 2 : 1
          continue
        } else if (shell !== 'cmd') return null
      } else if (c === '|') {
        if (next === '&') return null
        if (next === '|') i++
      } else if (shell === 'cmd') {
        // cmd.exe reads `;` as a space between a builtin's words.
        endWord()
        continue
      } else if (next === ';') {
        return null
      }
      if (!endStep()) return null
      continue
    }
    if (shell === 'posix' && /[$`(){}!]/.test(c)) return null
    if (shell === 'posix' && c === '#' && word === null) return null
    if (shell === 'powershell') {
      if (/[$`(){}@!]/.test(c)) return null
      if (c === '#' && word === null) return null
      if (c === '-' && command.startsWith('--%', i) && word === null) return null
      if (c === ',') {
        // An array of words, each its own argument.
        endWord()
        continue
      }
    }
    if (shell === 'cmd') {
      if (/[%^!()@]/.test(c)) return null
      if (c === ',' || c === '=') {
        endWord()
        continue
      }
    }
    const glob = shell === 'cmd' ? c === '*' || c === '?' : c === '*' || c === '?' || c === '['
    append(c, glob)
  }
  if (!endStep() || failed) return null
  return steps
}
