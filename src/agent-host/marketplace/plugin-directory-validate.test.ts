import { describe, expect, it } from 'vitest'
import { createValidators } from '../validate'

const posix = createValidators('darwin')

function rejects(run: () => unknown): void {
  expect(run).toThrow(expect.objectContaining({ code: 'invalid_params' }))
}

describe('the plugin directory requests', () => {
  it('reads the directory with refresh or cached, and nothing else', () => {
    expect(posix['market.pluginCatalog'](undefined)).toEqual({})
    expect(posix['market.pluginCatalog']({ refresh: true })).toEqual({ refresh: true })
    expect(posix['market.pluginCatalog']({ cached: true })).toEqual({ cached: true })
    rejects(() => posix['market.pluginCatalog']({ refresh: 'yes' }))
    rejects(() => posix['market.pluginCatalog']({ source: 'x/y' }))
  })

  it('reads only a github.com link', () => {
    expect(posix['market.pluginLink']({ url: ' https://github.com/a/b ' })).toEqual({
      url: 'https://github.com/a/b',
    })
    for (const url of [
      'http://github.com/a/b',
      'https://github.com.evil.example/a/b',
      'https://example.com/a/b',
      'https://github.com/a/b c',
      `https://github.com/${'a'.repeat(3000)}`,
      42,
    ]) {
      rejects(() => posix['market.pluginLink']({ url }))
    }
    rejects(() => posix['market.pluginLink']({ url: 'https://github.com/a/b', extra: 1 }))
  })

  it('inspects a plugin of the directory by its source and name, from GitHub alone', () => {
    const source = { kind: 'github', url: 'https://github.com/a/b/tree/main/x' }
    expect(
      posix['plugins.inspect']({ source, catalog: { source: 'anthropics/claude', name: 'x-y.z' } }),
    ).toEqual({ source, catalog: { source: 'anthropics/claude', name: 'x-y.z' } })
    expect(
      posix['plugins.inspect']({ source, catalog: { source: 'link:a/b', name: 'p' } }),
    ).toMatchObject({ catalog: { source: 'link:a/b' } })
    for (const catalog of [
      { source: '../b', name: 'x' },
      { source: 'a/..', name: 'x' },
      { source: 'a/b/c', name: 'x' },
      { source: 'a/b', name: '../x' },
      { source: 'a/b', name: 'has space' },
      { source: 'a/b', name: 'x', extra: 1 },
      { source: 'a/b' },
      'a/b:x',
    ]) {
      rejects(() => posix['plugins.inspect']({ source, catalog }))
    }
    rejects(() =>
      posix['plugins.inspect']({
        source: { kind: 'local', path: '/home/me/plugin' },
        catalog: { source: 'a/b', name: 'x' },
      }),
    )
  })
})
