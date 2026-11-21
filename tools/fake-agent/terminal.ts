// Huli: the fake agent's stand-in for an agent's interactive CLI, `--terminal [--resume <id>]`,
// which a terminal of Kite's runs to check an agent's start and resume there. It echoes each line
// until `/exit` or the end of its input, and touches no file.

import { createInterface } from 'node:readline'

export function runInTerminal(argv: readonly string[]): Promise<never> {
  const at = argv.indexOf('--resume')
  const resumed = at === -1 ? null : (argv[at + 1] ?? null)
  const out = process.stdout
  out.write(
    resumed
      ? `Fake agent, in a terminal: resumed session ${resumed}.\n`
      : 'Fake agent, in a terminal: a new session.\n',
  )
  out.write(`Folder: ${process.cwd()}\nType a message, or /exit to leave.\n`)
  const lines = createInterface({ input: process.stdin, output: out, prompt: '> ' })
  lines.on('line', (line) => {
    if (line.trim() === '/exit') {
      lines.close()
      return
    }
    out.write(`fake-agent: ${line}\n`)
    lines.prompt()
  })
  lines.on('close', () => process.exit(0))
  lines.prompt()
  return new Promise(() => {})
}
