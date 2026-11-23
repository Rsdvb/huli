import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILT_IN_STYLES, readOutputStyles } from './output-styles'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'kite-styles-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("Claude Code's output styles", () => {
  it('lists the built-in ones when the folder is missing', async () => {
    const styles = await readOutputStyles(path.join(dir, 'output-styles'))
    expect(styles.map((style) => style.name)).toEqual([...BUILT_IN_STYLES])
    expect(styles.every((style) => style.builtIn)).toBe(true)
  })

  it("adds the user's own by their frontmatter, else their file name, without the others", async () => {
    const folder = path.join(dir, 'output-styles')
    await mkdir(folder)
    await writeFile(
      path.join(folder, 'pirate.md'),
      '---\nname: "Pirate"\ndescription: Talks like one\n---\nArr.',
    )
    await writeFile(path.join(folder, 'Terse notes.md'), 'Short answers only.')
    await writeFile(path.join(folder, 'notes.txt'), 'not a style')
    await writeFile(path.join(folder, 'zz-again.md'), '---\nname: Pirate\n---\n')
    await writeFile(path.join(folder, 'clash.md'), '---\nname: Explanatory\n---\n')
    await mkdir(path.join(folder, 'folder.md'))
    const own = (await readOutputStyles(folder)).filter((style) => !style.builtIn)
    expect(own).toEqual([
      { name: 'Pirate', label: 'Pirate', description: 'Talks like one', builtIn: false },
      { name: 'Terse notes', label: 'Terse notes', description: null, builtIn: false },
    ])
  })
})
