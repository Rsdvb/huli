// Huli: the guards of the Plugins tab directory's requests, which `createValidators` takes in.
// Each returns a fresh params object with only the known fields, or throws `invalid_params`.

import type { HostMethod } from '@shared/agent-host'
import { isCatalogRef, type CatalogPluginRef } from '@shared/plugin-catalog'
import { invalidParams } from '../errors'
import type { Validators } from '../rpc'

type DirectoryMethod = Extract<HostMethod, 'market.pluginCatalog' | 'market.pluginLink'>

const URL_CHARS = 2_048

function record(params: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw invalidParams('params must be an object')
  }
  const extra = Object.keys(params).find((key) => !keys.includes(key))
  if (extra !== undefined) throw invalidParams(`Unknown param "${extra.slice(0, 64)}"`)
  return params as Record<string, unknown>
}

function flag(o: Record<string, unknown>, key: string): boolean | undefined {
  const value = o[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw invalidParams(`${key} must be a boolean`)
  return value
}

/** A plugin of the directory, by its source's id and its name. */
export function catalogRef(value: unknown): CatalogPluginRef {
  const o = record(value, ['source', 'name'])
  if (typeof o.source !== 'string' || typeof o.name !== 'string') {
    throw invalidParams('catalog must name a source and a plugin')
  }
  const ref = { source: o.source, name: o.name }
  if (!isCatalogRef(ref)) throw invalidParams('catalog is not a plugin of the directory')
  return ref
}

export const pluginDirectoryValidators: Pick<Validators, DirectoryMethod> = {
  'market.pluginCatalog': (params) => {
    const o = params === undefined || params === null ? {} : record(params, ['refresh', 'cached'])
    const refresh = flag(o, 'refresh')
    const cached = flag(o, 'cached')
    return {
      ...(refresh === undefined ? {} : { refresh }),
      ...(cached === undefined ? {} : { cached }),
    }
  },
  'market.pluginLink': (params) => {
    const o = record(params, ['url'])
    const url = typeof o.url === 'string' ? o.url.trim() : ''
    if (url.length > URL_CHARS || !url.startsWith('https://github.com/') || /\s/.test(url)) {
      throw invalidParams('url must be a https://github.com/ address')
    }
    return { url }
  },
}
